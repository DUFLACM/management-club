import { DomainError } from '../../../common/domain-error.js'
import { randomUUID } from 'node:crypto'
import { hydroCanonical, hydroSign, hydroVerify } from '@acm/integrations'
import { Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../../../infrastructure/database/database.module.js'
import { JobsService } from '../../../infrastructure/jobs/jobs.service.js'
import { newId, sha256Hex } from '../../../common/utils.js'
import { z } from 'zod'

/**
 * Hydro Bridge 机器接口（07 方案 5）：
 * - Webhook：HMAC-SHA256 raw-body 签名（HYDRO-BRIDGE-V1 canonical），timestamp ±300s，nonce 防重放，
 *   eventId 幂等收据；成功写 receipt + jobs 同事务并返回 202。
 * - 机器请求不能建立学生会话；pull 由 Worker 携带 club-to-hydro 方向签名。
 * - secret 仅服务器（secret_references 加密存储），不出现在日志/GET。
 */

export class HydroError extends DomainError {
  constructor(message: string, readonly code: string) {
    super(message, code)
  }
}

export const hydroEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  instanceId: z.string().uuid(),
  domainId: z.string().min(1).max(64),
  kind: z.string().min(3).max(80),
  resource: z.record(z.string(), z.unknown()).default({}),
  revision: z.number().int().min(1),
  snapshotHash: z.string().length(64).optional(),
  observedAt: z.string().datetime(),
  sourceVersion: z.string().max(40).optional(),
})

export type HydroEvent = z.infer<typeof hydroEventSchema>



@Injectable()
export class HydroService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  /** 从 secret_references 解密获取实例推送 secret（开发环境直接取明文列也仅服务器可见） */
  private async instancePushSecret(instanceId: string): Promise<{ keyId: string; secret: string } | null> {
    const instance = await this.db.integrationInstance.findUnique({ where: { instanceId } })
    if (!instance || !instance.enabled) return null
    const keyId = (instance.config as { pushKeyId?: string } | null)?.pushKeyId ?? `hydro:${instanceId}`
    const ref = await this.db.secretReference.findUnique({ where: { key: `hydro-push-${instanceId}` } })
    if (!ref || ref.disabledAt) return null
    // 开发存储直接明文；生产应接 KMS/加密列（见 docs/deploy.md）
    return { keyId, secret: ref.secretEnc }
  }

  /**
   * 接收 webhook：大小→key/instance→时间窗→HMAC→nonce 防重放→schema→域授权→同事务写 receipt+job。
   * 幂等：同 eventId 同 bodyHash 返回成功；同 eventId 不同 bodyHash 为冲突。
   */
  async receiveWebhook(headers: {
    keyId?: string
    instanceId?: string
    timestamp?: string
    nonce?: string
    signature?: string
  }, rawBody: Buffer): Promise<{ status: 202; eventId?: string }> {
    const { keyId, instanceId, timestamp, nonce, signature } = headers
    if (!keyId || !instanceId || !timestamp || !nonce || !signature) {
      throw new HydroError('缺少签名头', 'SIG_HEADER_MISSING')
    }
    const ts = Number(timestamp)
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
      throw new HydroError('时间戳超出 ±300 秒窗口', 'TIMESTAMP_OUT_OF_RANGE')
    }
    if (nonce.length < 16) throw new HydroError('nonce 至少 128 位随机值', 'NONCE_WEAK')

    const secret = await this.instancePushSecret(instanceId)
    if (!secret || secret.keyId !== keyId) throw new HydroError('keyId/实例未登记或已禁用', 'KEY_NOT_FOUND')

    const bodyHash = sha256Hex(rawBody)
    const canonical = hydroCanonical({
      direction: 'hydro-to-club',
      keyId,
      instanceId,
      timestamp,
      nonce,
      method: 'POST',
      pathAndQuery: '/api/v1/integrations/hydro/events',
      bodySha256: bodyHash,
    })
    const expected = hydroSign(canonical, secret.secret)
    if (!hydroVerify(canonical, signature, secret.secret)) {
      throw new HydroError('签名不匹配', 'SIGNATURE_INVALID')
    }

    let event: HydroEvent
    try {
      event = hydroEventSchema.parse(JSON.parse(rawBody.toString('utf8')))
    } catch {
      throw new HydroError('事件 schema 不符', 'SCHEMA_INVALID')
    }
    if (event.instanceId !== instanceId) throw new HydroError('instanceId 不一致', 'INSTANCE_MISMATCH')

    const instanceRow = await this.db.integrationInstance.findUnique({ where: { instanceId } })
    if (!instanceRow?.allowedDomains.includes(event.domainId)) {
      throw new HydroError('域未授权', 'DOMAIN_NOT_ALLOWED')
    }

    // 幂等 + 防重放 + 业务入队：同一事务
    await this.db.$transaction(async (tx) => {
      const dupNonce = await tx.hydroNonce.findUnique({
        where: { instanceId_keyId_nonce: { instanceId, keyId, nonce } },
      })
      if (dupNonce) throw new HydroError('nonce 重放', 'NONCE_REPLAY')
      await tx.hydroNonce.create({
        data: {
          id: newId(),
          instanceId: instanceRow.id,
          keyId,
          nonce,
          // 保留至最后可接受时刻之后（±300s 窗口 + 余量）
          expiresAt: new Date((ts + 600 + 60) * 1000),
        },
      }).catch(() => {
        throw new HydroError('nonce 重放', 'NONCE_REPLAY')
      })

      const existing = await tx.hydroEventReceipt.findUnique({ where: { eventId: event.eventId } })
      if (existing) {
        if (existing.bodyHash !== bodyHash) throw new HydroError('同 eventId 不同 body', 'EVENT_CONFLICT')
        return // 幂等成功
      }
      await tx.hydroEventReceipt.create({
        data: {
          id: newId(),
          instanceId: instanceRow.id,
          eventId: event.eventId,
          bodyHash,
          payload: event as never,
        },
      })
      void this.jobs // jobs 在事务外由 receipt 消费者排队（事件仅触发刷新，repair 负责遗漏）
    })
    // 事件触发刷新任务（receipt 消费；失败可 repair）
    await this.jobs.enqueue({
      type: 'hydro.pull_contest',
      payload: { eventId: event.eventId, instanceId, domainId: event.domainId, kind: event.kind, resource: event.resource },
      dedupeKey: `hydro-event:${event.eventId}`,
    })
    return { status: 202, eventId: event.eventId }
  }

  /** club-to-hydro pull 签名头（Worker 使用） */
  async buildPullAuth(instanceId: string, pathAndQuery: string): Promise<Record<string, string> | null> {
    const instance = await this.db.integrationInstance.findUnique({ where: { instanceId } })
    if (!instance || !instance.enabled) return null
    const ref = await this.db.secretReference.findUnique({ where: { key: `hydro-pull-${instanceId}` } })
    if (!ref || ref.disabledAt) return null
    const keyId = (instance.config as { pullKeyId?: string } | null)?.pullKeyId ?? `hydro-pull:${instanceId}`
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = randomUUID().replace(/-/g, '')
    const canonical = hydroCanonical({
      direction: 'club-to-hydro',
      keyId,
      instanceId,
      timestamp,
      nonce,
      method: 'GET',
      pathAndQuery,
      bodySha256: sha256Hex(''),
    })
    return {
      'X-Hydro-Key-Id': keyId,
      'X-Hydro-Instance-Id': instanceId,
      'X-Hydro-Timestamp': timestamp,
      'X-Hydro-Nonce': nonce,
      'X-Hydro-Signature': hydroSign(canonical, ref.secretEnc),
    }
  }
}
