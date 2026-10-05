import { DomainError } from '../../common/domain-error.js'
import { Inject, Injectable } from '@nestjs/common'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHmac } from 'node:crypto'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { haversineMeters, newId, randomToken, sha256Hex } from '../../common/utils.js'
import { z } from 'zod'

/**
 * 出勤模块（03 方案 5-10）：
 * - 个人 challenge：绑定用户/活动/检查点/策略版本/有效期。
 * - 提交检查点：统一锁顺序 activity(FOR SHARE) → 按 ID 排序 venue → version (FOR SHARE) → 重读状态；
 *   搬场/策略切换/停用用冲突 FOR UPDATE（ActivityService/VenueService 已按此实现）。
 * - 共享现场 QR：多人可用（不全局消费）；本人 UNIQUE(activity,user,checkpoint) 防重。
 * - GEO_AND_QR：定位按二维码绑定的同一地点版本核验，禁止跨地点拼接。
 * - 幂等：Idempotency-Key 唯一 + 相同请求摘要校验。
 */

export class AttendanceError extends DomainError {
  constructor(message: string, readonly code: string) {
    super(message, code)
  }
}

export const challengeRequestSchema = z.object({
  activityId: z.string().uuid(),
  checkpoint: z.enum(['IN', 'OUT']),
})

export const checkpointSubmitSchema = z.object({
  challenge: z.string().min(10),
  method: z.enum(['GEO', 'QR']),
  checkpoint: z.enum(['IN', 'OUT']),
  geo: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracyMeters: z.number().min(0).max(2000),
      sampledAt: z.string().datetime(),
    })
    .optional(),
  qrToken: z.string().min(10).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
})

export type CheckpointSubmit = z.infer<typeof checkpointSubmitSchema>

/** 定位证据加密（AES-256-GCM；密钥从环境派生；短期保留后清理） */
function encryptGeoEvidence(data: unknown, keyRef: string): string {
  const key = scryptSync(keyRef, 'acm-club-geo-evidence', 32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8')
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

export function decryptGeoEvidence(payload: string, keyRef: string): unknown {
  const key = scryptSync(keyRef, 'acm-club-geo-evidence', 32)
  const buf = Buffer.from(payload, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const data = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'))
}

/** 现场动态 QR 内容：purpose/activityId/checkpoint/venueVersionId/nonce/issuedAt/expiresAt/policyVersion 签名封装 */
export interface QrPayload {
  p: 'att'
  a: string // activityId
  cp: 'IN' | 'OUT'
  v: string // venueVersionId
  n: string // nonce（明文嵌入；库存摘要）
  iat: number
  exp: number
  pv: number
  sig: string
}

export function qrPayloadSigningKey(keyRef: string): Buffer {
  return scryptSync(keyRef, 'acm-club-qr-window', 32)
}

function qrMac(canonical: string, key: Buffer): string {
  return createHmac('sha256', key).update(canonical).digest('base64url')
}

export function signQrPayload(payload: Omit<QrPayload, 'sig'>, keyRef: string): QrPayload {
  const sig = qrMac(qrCanonical(payload), qrPayloadSigningKey(keyRef))
  return { ...payload, sig }
}

export function verifyQrPayload(token: string, keyRef: string): QrPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as QrPayload
    if (parsed.p !== 'att') return null
    const { sig, ...rest } = parsed
    const expected = qrMac(qrCanonical(rest), qrPayloadSigningKey(keyRef))
    if (sig.length !== expected.length) return null
    let diff = 0
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i)
    if (diff !== 0) return null
    return parsed
  } catch {
    return null
  }
}

function qrCanonical(payload: Omit<QrPayload, 'sig'>): string {
  return [payload.p, payload.a, payload.cp, payload.v, payload.n, payload.iat, payload.exp, payload.pv].join('|')
}

interface GeoFenceDecision {
  accepted: boolean
  pending: boolean
  code?: string
  message: string
  distance?: number
}

/** 保守围栏判定（03 方案 6）：a ≤ maxAcc 且 d+a ≤ R 自动通过；d−a > R 拒绝；其余待复核 */
export function evaluateGeoFence(
  lat: number, lon: number, accuracy: number,
  centerLat: number, centerLon: number, radiusMeters: number, maxAccuracy: number,
): GeoFenceDecision {
  const d = haversineMeters(lat, lon, centerLat, centerLon)
  if (accuracy > maxAccuracy) {
    return { accepted: false, pending: true, code: 'GEO_INACCURATE', message: `定位精度不足（±${Math.round(accuracy)}m > ${maxAccuracy}m），请重试或转人工复核`, distance: d }
  }
  if (d + accuracy <= radiusMeters) {
    return { accepted: true, pending: false, message: '围栏内核验通过', distance: d }
  }
  if (d - accuracy > radiusMeters) {
    return { accepted: false, pending: false, code: 'GEO_OUTSIDE', message: `定位在活动地点围栏外（约 ${Math.round(d)}m）`, distance: d }
  }
  return { accepted: false, pending: true, code: 'GEO_BOUNDARY', message: '位置处于围栏边界，待人工复核', distance: d }
}

@Injectable()
export class AttendanceService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private geoKeyRef(): string {
    return process.env.ATTENDANCE_EVIDENCE_KEY_REF ?? 'dev-attendance-key'
  }

  /** 本人活动签到上下文：资格、地点、窗口、策略、IN/OUT 状态 */
  async attendanceContext(userId: string, activityId: string) {
    const activity = await this.db.activity.findUnique({
      where: { id: activityId },
      include: {
        policy: true,
        registrations: { where: { userId } },
        participants: { where: { userId } },
        leaveRequests: { where: { userId } },
        remotePermissions: { where: { userId } },
        checkpoints: { where: { userId } },
        venueBindings: {
          include: {
            venueVersion: {
              include: { venue: true },
            },
          },
        },
        venueVersion: { include: { venue: true } },
      },
    })
    if (!activity) throw new AttendanceError('活动不存在', 'NOT_FOUND')
    if (activity.status !== 'published') throw new AttendanceError('活动不在进行状态', 'NOT_PUBLISHED')
    const reg = activity.registrations[0]
    const participant = activity.participants[0]
    const required = participant?.required ?? false
    const leave = activity.leaveRequests[0]
    const remote = activity.remotePermissions[0]
    const enrolled = reg?.status === 'enrolled'
    const pendingApproval = reg?.status === 'pending_approval'
    const eligible = enrolled || required || (remote?.status === 'approved')
    const now = new Date()
    const policy = activity.policy
    return {
      activity: {
        id: activity.id,
        title: activity.title,
        type: activity.type,
        startAt: activity.startAt.toISOString(),
        endAt: activity.endAt.toISOString(),
        requireValidSubmission: activity.requireValidSubmission,
      },
      eligibility: {
        eligible,
        reason: !eligible
          ? enrolled || pendingApproval ? (pendingApproval ? '报名待审核' : '') : required ? '' : '未报名且不在必到名单'
          : '',
        registration: reg ? { status: reg.status, waitlistSeq: reg.waitlistSeq } : null,
        required,
        leave: leave ? { status: leave.status } : null,
        remote: remote ? { status: remote.status } : null,
      },
      policy: policy
        ? {
            policy: policy.policy,
            checkinOpenAt: policy.checkinOpenAt.toISOString(),
            checkinCloseAt: policy.checkinCloseAt.toISOString(),
            checkoutOpenAt: policy.checkoutOpenAt?.toISOString() ?? null,
            checkoutCloseAt: policy.checkoutCloseAt?.toISOString() ?? null,
            selfCheckout: policy.selfCheckout,
            maxAccuracyMeters: Number(policy.maxAccuracyMeters),
            windowOpen: { IN: policy.checkinOpenAt <= now && now <= policy.checkinCloseAt, OUT: !!(policy.checkoutOpenAt && policy.checkoutCloseAt && policy.checkoutOpenAt <= now && now <= policy.checkoutCloseAt) },
          }
        : null,
      venues: activity.venueBindings.map((b) => ({
        venueVersionId: b.venueVersionId,
        name: b.venueVersion.venue.name,
        building: b.venueVersion.building,
        room: b.venueVersion.room,
        directions: b.venueVersion.directions,
        operationalStatus: b.venueVersion.venue.operationalStatus,
        versionStatus: b.venueVersion.status,
        revokedAt: b.venueVersion.revokedAt,
        validUntil: b.venueVersion.validUntil?.toISOString() ?? null,
        allowedCapabilities: b.venueVersion.allowedCapabilities,
        hasCoordinates: b.venueVersion.latitude != null,
      })),
      checkpoints: activity.checkpoints.map((c) => ({ checkpoint: c.checkpoint, acceptedAt: c.acceptedAt.toISOString(), method: c.method })),
      serverTime: now.toISOString(),
    }
  }

  /** 签发个人 challenge（绑定用户/活动/检查点/策略版本；短有效期） */
  async issueChallenge(userId: string, activityId: string, checkpoint: 'IN' | 'OUT'): Promise<{ challenge: string; expiresAt: string }> {
    const ctx = await this.attendanceContext(userId, activityId)
    if (!ctx.eligibility.eligible) throw new AttendanceError('尚不满足签到资格（未报名/待审核且不在必到名单）', 'MEMBERSHIP_NOT_ELIGIBLE')
    if (!ctx.policy) throw new AttendanceError('活动未配置签到策略', 'POLICY_MISSING')
    if (!ctx.policy.windowOpen[checkpoint]) throw new AttendanceError(`${checkpoint} 窗口未开放`, 'WINDOW_CLOSED')
    const existing = ctx.checkpoints.find((c) => c.checkpoint === checkpoint)
    if (existing) {
      // 已记录：明确返回该状态（前端应先读 attendance-context）
      throw new AttendanceError(`该检查点已于 ${existing.acceptedAt} 记录，不重复计时`, 'ALREADY_RECORDED')
    }
    const challenge = randomToken(24)
    const expiresAt = new Date(Date.now() + 5 * 60_000)
    await this.db.attendanceChallenge.create({
      data: {
        id: newId(),
        activityId,
        userId,
        checkpoint,
        policyVersion: ctx.policy ? await this.policyVersionOf(activityId) : 1,
        nonceHash: sha256Hex(challenge),
        expiresAt,
      },
    })
    return { challenge, expiresAt: expiresAt.toISOString() }
  }

  private async policyVersionOf(activityId: string): Promise<number> {
    const policy = await this.db.attendancePolicy.findUnique({ where: { activityId }, select: { version: true } })
    return policy?.version ?? 1
  }

  /**
   * 提交检查点。结果：accepted / pending_review / rejected / already_recorded。
   * 统一锁顺序（09 方案 6）：activity FOR SHARE → 按绑定集 ID 排序的 venue/version FOR SHARE，
   * 事务内重读活动状态、绑定、policy_version、地点实时状态/撤销/有效期。
   */
  async submitCheckpoint(userId: string, input: CheckpointSubmit): Promise<{
    result: 'accepted' | 'pending_review' | 'rejected' | 'already_recorded'
    serverTime: string
    acceptedAt?: string
    message: string
    nextStep?: string
    method?: string
  }> {
    // 1. challenge 校验（事务外预检；事务内二次校验消费）
    const challengeRow = await this.db.attendanceChallenge.findUnique({ where: { nonceHash: sha256Hex(input.challenge) } })
    if (!challengeRow || challengeRow.userId !== userId) {
      throw new AttendanceError('challenge 无效或已使用，请重新获取', 'CHALLENGE_INVALID')
    }
    if (challengeRow.checkpoint !== input.checkpoint) {
      throw new AttendanceError('challenge 与检查点不匹配', 'WRONG_CHECKPOINT')
    }
    // 已提交请求的网络重试仍使用原 challenge；先回放结果，再检查一次性凭证。
    if (input.idempotencyKey) {
      const prior = await this.db.attendanceAttempt.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } },
      })
      if (prior) {
        if (prior.activityId !== challengeRow.activityId || prior.checkpoint !== input.checkpoint) {
          throw new AttendanceError('幂等键已用于其他活动或检查点', 'IDEMPOTENCY_CONFLICT')
        }
        const checkpoint = await this.db.attendanceCheckpoint.findUnique({
          where: { activityId_userId_checkpoint: { activityId: challengeRow.activityId, userId, checkpoint: input.checkpoint } },
        })
        if (checkpoint) {
          return { result: 'already_recorded', serverTime: prior.serverTime.toISOString(), acceptedAt: checkpoint.acceptedAt.toISOString(), message: '该检查点此前已记录（幂等返回原时间）', method: checkpoint.method }
        }
        return { result: prior.result as 'pending_review' | 'rejected', serverTime: prior.serverTime.toISOString(), message: prior.result === 'pending_review' ? '该提交已转人工复核（幂等返回原结果）' : '该提交此前未通过核验（幂等返回原结果）', method: prior.method }
      }
    }
    if (challengeRow.consumedAt) throw new AttendanceError('challenge 无效或已使用，请重新获取', 'CHALLENGE_INVALID')
    if (challengeRow.expiresAt < new Date()) throw new AttendanceError('challenge 已过期，请重新获取', 'CHALLENGE_EXPIRED')

    // QR 预解析（确定绑定的 venue_version）
    let qrVenueVersionId: string | null = null
    let qrWindowId: string | null = null
    if (input.method === 'QR') {
      if (!input.qrToken) throw new AttendanceError('缺少二维码凭证', 'QR_MISSING')
      const payload = verifyQrPayload(input.qrToken, this.geoKeyRef())
      if (!payload) throw new AttendanceError('二维码凭证无效', 'QR_INVALID')
      if (payload.a !== challengeRow.activityId) throw new AttendanceError('二维码属于其他活动', 'QR_ACTIVITY_MISMATCH')
      if (payload.cp !== input.checkpoint) throw new AttendanceError('入场码不能作为离场码使用（检查点不匹配）', 'WRONG_CHECKPOINT')
      qrVenueVersionId = payload.v
      const window = await this.db.attendanceQrWindow.findUnique({ where: { nonceHash: sha256Hex(payload.n) } })
      if (!window) throw new AttendanceError('二维码不在有效签发记录中', 'QR_INVALID')
      if (window.revokedAt) throw new AttendanceError('二维码已被撤销', 'QR_REVOKED')
      if (window.expiresAt < new Date()) throw new AttendanceError('二维码已过期，请扫描现场新码', 'QR_EXPIRED')
      qrWindowId = window.id
    }

    return this.db.$transaction(async (tx) => {
      const activityId = challengeRow.activityId
      // 统一顺序：先 activity FOR SHARE（与发布/搬场/停用的 FOR UPDATE 协调）
      await tx.$queryRaw`SELECT id, status, policy_version FROM activities WHERE id = ${activityId}::uuid FOR SHARE`
      if (input.idempotencyKey) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`attendance-idempotency:${userId}:${input.idempotencyKey}`}, 0))`
      }
      // 仅串行本人同一检查点的提交，防止唯一约束冲突使 PG 事务整体进入 aborted。
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${activityId}:${userId}:${input.checkpoint}`}, 0))`
      const activity = await tx.activity.findUnique({
        where: { id: activityId },
        include: {
          policy: true,
          registrations: { where: { userId } },
          participants: { where: { userId } },
          remotePermissions: { where: { userId } },
          leaveRequests: { where: { userId } },
          checkpoints: { where: { userId } },
          venueBindings: { include: { venueVersion: { include: { venue: true } } } },
          venueVersion: true,
        },
      })
      if (!activity) throw new AttendanceError('活动不存在', 'NOT_FOUND')
      if (activity.status !== 'published') throw new AttendanceError('活动已下线', 'ACTIVITY_OFFLINE')

      const currentPolicyVersion = activity.policy?.version ?? 1
      if (challengeRow.policyVersion !== currentPolicyVersion) {
        throw new AttendanceError('签到策略已变更，请刷新后重新获取', 'POLICY_CHANGED')
      }

      // 资格：已确认报名 或 必到名单 或 批准远程（扫码不能绕过资格）
      const reg = activity.registrations[0]
      const required = activity.participants[0]?.required ?? false
      const remoteApproved = activity.remotePermissions[0]?.status === 'approved'
      if (!(reg?.status === 'enrolled' || required || remoteApproved)) {
        throw new AttendanceError('尚无签到资格（未报名/未确认/非必到）', 'MEMBERSHIP_NOT_ELIGIBLE')
      }

      // 幂等：同 Idempotency-Key 返回原结果
      if (input.idempotencyKey) {
        const prior = await tx.attendanceAttempt.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } },
        })
        if (prior) {
          if (prior.activityId !== activityId || prior.checkpoint !== input.checkpoint) {
            throw new AttendanceError('幂等键已用于其他活动或检查点', 'IDEMPOTENCY_CONFLICT')
          }
          const existingCheckpoint = activity.checkpoints.find((c) => c.checkpoint === input.checkpoint)
          if (existingCheckpoint) {
            return { result: 'already_recorded', serverTime: prior.serverTime.toISOString(), acceptedAt: existingCheckpoint.acceptedAt.toISOString(), message: '该检查点此前已记录（幂等返回原时间）', method: existingCheckpoint.method, nextStep: input.checkpoint === 'IN' ? '活动结束后请签退' : '等待认定' }
          }
          return { result: prior.result as 'pending_review' | 'rejected', serverTime: prior.serverTime.toISOString(), message: prior.result === 'pending_review' ? '该提交已转人工复核（幂等返回原结果）' : '该提交此前未通过核验（幂等返回原结果）', method: prior.method }
        }
      }

      // 消费 challenge（本人一次性）；幂等回放不重复消费凭证。
      const consumed = await tx.attendanceChallenge.updateMany({
        where: { id: challengeRow.id, consumedAt: null },
        data: { consumedAt: new Date() },
      })
      if (consumed.count === 0) throw new AttendanceError('challenge 已被消费', 'CHALLENGE_CONSUMED')

      // 已有检查点：already_recorded（本人每检查点唯一）
      const existingCheckpoint = activity.checkpoints.find((c) => c.checkpoint === input.checkpoint)
      if (existingCheckpoint) {
        await tx.attendanceAttempt.create({
          data: {
            id: newId(), activityId, userId, checkpoint: input.checkpoint, method: input.method,
            result: 'already_recorded', policyVersion: currentPolicyVersion,
            qrWindowId, challengeId: challengeRow.id, idempotencyKey: input.idempotencyKey ?? null,
          },
        })
        return { result: 'already_recorded', serverTime: new Date().toISOString(), acceptedAt: existingCheckpoint.acceptedAt.toISOString(), message: '该检查点已记录，不重复计时', method: existingCheckpoint.method }
      }

      // 策略与窗口
      const policy = activity.policy
      if (!policy) throw new AttendanceError('活动未配置签到策略', 'POLICY_MISSING')
      const now = new Date()
      const windowField = input.checkpoint === 'IN' ? { open: policy.checkinOpenAt, close: policy.checkinCloseAt } : { open: policy.checkoutOpenAt, close: policy.checkoutCloseAt }
      if (!windowField.open || !windowField.close) throw new AttendanceError('未配置该检查点窗口', 'WINDOW_NOT_CONFIGURED')
      if (now < windowField.open || now > windowField.close) throw new AttendanceError('当前不在签到/签退窗口内', 'WINDOW_CLOSED')

      // 按统一顺序对绑定地点版本加共享锁并检查实时状态（ID 排序防死锁）
      const bindings = [...activity.venueBindings].sort((a, b) => a.venueVersionId.localeCompare(b.venueVersionId))
      const allowedVersionIds = new Set(bindings.map((b) => b.venueVersionId))
      for (const b of bindings) {
        await tx.$queryRaw`SELECT vv.id, vv.status, vv.revoked_at, vv.valid_until, v.operational_status
          FROM venue_versions vv JOIN venues v ON v.id = vv.venue_id
          WHERE vv.id = ${b.venueVersionId}::uuid FOR SHARE OF vv, v`
      }
      for (const b of bindings) {
        const vv = b.venueVersion
        if (vv.status !== 'approved' || vv.revokedAt != null) throw new AttendanceError('活动绑定的地点版本认证已失效', 'VENUE_VERSION_REVOKED')
        if (vv.validUntil && vv.validUntil < now) throw new AttendanceError('活动绑定的地点版本已过认证有效期', 'VENUE_VERSION_REVOKED')
        if (vv.venue.operationalStatus !== 'active') throw new AttendanceError('活动地点已暂停使用，请联系现场工作人员', 'VENUE_SUSPENDED')
      }

      // 凭证核验
      let geoDecision: GeoFenceDecision | null = null
      let evidenceVenueVersionId: string | null = qrVenueVersionId
      let geoEncrypted: string | null = null
      let qrOk = false
      let geoOk = false

      if (input.method === 'QR') {
        const target = bindings.find((b) => b.venueVersionId === qrVenueVersionId)
        if (!target || !allowedVersionIds.has(qrVenueVersionId!)) {
          throw new AttendanceError('二维码绑定的地点不在本活动允许集合', 'VENUE_NOT_ALLOWED')
        }
        if (!target.venueVersion.allowedCapabilities.includes('QR')) {
          throw new AttendanceError('该地点版本未认证二维码能力', 'CAPABILITY_MISSING')
        }
        qrOk = true
      }
      if (input.geo) {
        const snapshot = (activity.venueBindings.find((b) => b.venueVersionId === (qrVenueVersionId ?? activity.venueBindings[0]?.venueVersionId))?.fenceSnapshot ?? null) as
          | { latitude: number; longitude: number; radiusMeters: number; maxAccuracyMeters: number }
          | null
        // 定位核验优先绑定二维码同一地点版本（GEO_AND_QR 不允许 A 地点定位 + B 地点扫码）
        const geoTarget = qrVenueVersionId
          ? bindings.find((b) => b.venueVersionId === qrVenueVersionId)
          : activity.venueVersion && bindings.find((b) => b.venueVersionId === activity.venueVersion!.id)
            ? bindings.find((b) => b.venueVersionId === activity.venueVersion!.id)
            : bindings[0]
        if (!geoTarget) throw new AttendanceError('活动未绑定支持定位的地点', 'VENUE_NOT_ALLOWED')
        const version = geoTarget.venueVersion
        if (!version.allowedCapabilities.includes('GEO')) throw new AttendanceError('该地点版本未认证定位能力', 'CAPABILITY_MISSING')
        const centerLat = Number(version.latitude)
        const centerLon = Number(version.longitude)
        const radius = Number(version.radiusMeters)
        const maxAcc = Math.min(Number(policy.maxAccuracyMeters), Number(version.maxAccuracyMeters ?? policy.maxAccuracyMeters))
        if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon) || !Number.isFinite(radius)) {
          throw new AttendanceError('地点缺少有效围栏配置，无法定位核验', 'GEO_INCOMPLETE')
        }
        void snapshot
        geoDecision = evaluateGeoFence(input.geo.latitude, input.geo.longitude, input.geo.accuracyMeters, centerLat, centerLon, radius, maxAcc)
        geoEncrypted = encryptGeoEvidence({ ...input.geo, distance: geoDecision.distance, venueVersionId: geoTarget.venueVersionId, activityId }, this.geoKeyRef())
        evidenceVenueVersionId = geoTarget.venueVersionId
        geoOk = geoDecision.accepted
      }

      // 策略组合判定
      let accepted = false
      let pending = false
      let rejectCode: string | undefined
      if (policy.policy === 'GEO_ONLY') {
        if (input.method !== 'GEO' || !input.geo) throw new AttendanceError('本活动仅允许定位签到', 'METHOD_NOT_ALLOWED')
        accepted = geoOk; pending = geoDecision?.pending ?? false; rejectCode = geoDecision?.code
      } else if (policy.policy === 'QR_ONLY') {
        if (input.method !== 'QR') throw new AttendanceError('本活动仅允许扫描活动码', 'METHOD_NOT_ALLOWED')
        accepted = qrOk
      } else if (policy.policy === 'GEO_OR_QR') {
        accepted = qrOk || geoOk
        pending = !accepted && (geoDecision?.pending ?? false)
        if (!accepted && !pending) rejectCode = geoDecision?.code ?? 'VERIFY_FAILED'
      } else {
        // GEO_AND_QR：单次提交须同时具备双证据；仅一项时提示下一步，不宣称成功
        if (!input.geo || input.method !== 'QR') {
          throw new AttendanceError('本活动要求定位与活动码双证据，请在同一提交中完成两步', 'DUAL_EVIDENCE_REQUIRED')
        }
        accepted = qrOk && geoOk
        pending = !accepted && (geoDecision?.pending ?? false)
        if (!accepted && !pending) rejectCode = geoDecision?.code ?? 'GEO_OUTSIDE'
      }

      const result = accepted ? 'accepted' : pending ? 'pending_review' : 'rejected'
      const serverTime = new Date()
      const attempt = await tx.attendanceAttempt.create({
          data: {
            id: newId(), activityId, userId, checkpoint: input.checkpoint, method: input.method,
            result, failureCode: rejectCode, serverTime, policyVersion: currentPolicyVersion,
            qrWindowId, challengeId: challengeRow.id, geoEvidenceEnc: geoEncrypted,
            idempotencyKey: input.idempotencyKey ?? null,
          },
      })
      if (result === 'accepted') {
        await tx.attendanceCheckpoint.create({
            data: {
              id: newId(), activityId, userId, checkpoint: input.checkpoint,
              method: input.method, acceptedAt: serverTime, venueVersionId: evidenceVenueVersionId, attemptId: attempt.id,
            },
        })
        await tx.attendanceAttendanceResult.upsert({
          where: { activityId_userId: { activityId, userId } },
          create: { id: newId(), activityId, userId, status: input.checkpoint === 'IN' ? 'pending' : 'pending' },
          update: {},
        })
      } else if (result === 'pending_review') {
        await tx.attendanceAttendanceResult.upsert({
          where: { activityId_userId: { activityId, userId } },
          create: { id: newId(), activityId, userId, status: 'pending_review', reviewNote: geoDecision?.message },
          update: { status: 'pending_review', reviewNote: geoDecision?.message, revision: { increment: 1 } },
        })
      }

      const message = result === 'accepted'
        ? input.checkpoint === 'IN'
          ? (input.method === 'QR' && !input.geo ? '二维码签到已记录，活动结束后请签退' : '签到已记录，活动结束后请签退')
          : '签退已记录，等待认定'
        : result === 'pending_review'
          ? (geoDecision?.message ?? '待人工复核')
          : rejectCode === 'GEO_OUTSIDE'
            ? '定位在围栏外，本次定位方式未通过'
            : '本次提交未通过核验'
      const nextStep = result === 'accepted'
        ? input.checkpoint === 'IN' ? '活动结束后请签退（OUT）' : '等待出勤认定与积分审核'
        : result === 'pending_review' ? '已转人工复核，请听从现场工作人员安排' : '可重试或改用允许的其他签到方式'
      return { result, serverTime: serverTime.toISOString(), acceptedAt: result === 'accepted' ? serverTime.toISOString() : undefined, message, nextStep, method: input.method }
    })
  }

  /**
   * 管理端签发共享现场动态 QR（attendance.qr 权限）。
   * 共享码：有效期内多人可用；nonce 不全局消费。
   */
  async issueQrWindow(actorPrincipalId: string, activityId: string, venueVersionId: string, checkpoint: 'IN' | 'OUT'): Promise<{ token: string; expiresAt: string; rotateSeconds: number }> {
    const activity = await this.db.activity.findUnique({ where: { id: activityId }, include: { policy: true, venueBindings: true } })
    if (!activity) throw new AttendanceError('活动不存在', 'NOT_FOUND')
    if (!activity.policy) throw new AttendanceError('活动未配置策略', 'POLICY_MISSING')
    if (!activity.venueBindings.some((b) => b.venueVersionId === venueVersionId)) {
      throw new AttendanceError('该地点版本不在活动允许集合', 'VENUE_NOT_ALLOWED')
    }
    const binding = await this.db.activityVenueBinding.findUnique({
      where: { activityId_venueVersionId: { activityId, venueVersionId } },
      include: { venueVersion: true },
    })
    if (!binding?.venueVersion.allowedCapabilities.includes('QR')) {
      throw new AttendanceError('该地点版本未认证 QR 能力', 'CAPABILITY_MISSING')
    }
    const now = new Date()
    const ttl = activity.policy.qrTtlSeconds
    const expiresAt = new Date(now.getTime() + ttl * 1000)
    const nonce = randomToken(18)
    const policyVersion = activity.policyVersion
    await this.db.attendanceQrWindow.create({
      data: {
        id: newId(), activityId, venueVersionId, checkpoint: 'IN' === checkpoint ? 'IN' : 'OUT',
        nonceHash: sha256Hex(nonce), issuedAt: now, expiresAt, policyVersion,
      },
    })
    const payload = signQrPayload(
      { p: 'att', a: activityId, cp: checkpoint, v: venueVersionId, n: nonce, iat: Math.floor(now.getTime() / 1000), exp: Math.floor(expiresAt.getTime() / 1000), pv: policyVersion },
      this.geoKeyRef(),
    )
    const token = Buffer.from(JSON.stringify(payload)).toString('base64url')
    await this.audit.log({
      actorPrincipalId,
      action: 'attendance.qr_issue',
      resourceType: 'activity',
      resourceId: activityId,
      summary: `签发现场码 ${checkpoint}（venueVersion ${venueVersionId.slice(0, 8)}…，TTL ${ttl}s）`,
    })
    return { token, expiresAt: expiresAt.toISOString(), rotateSeconds: activity.policy.qrRotateSeconds }
  }

  /** 签退窗口是否开放（现场码签发前的检查） */
  async currentQrForActivity(activityId: string, venueVersionId: string, checkpoint: 'IN' | 'OUT') {
    const win = await this.db.attendanceQrWindow.findFirst({
      where: { activityId, venueVersionId, checkpoint, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { issuedAt: 'desc' },
    })
    return win
  }
}
