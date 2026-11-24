import { randomBytes } from 'node:crypto'
import { Inject, Injectable, Optional } from '@nestjs/common'
import QRCode from 'qrcode'
import { z } from 'zod'
import {
  createWxPusherQrCode,
  fetchWxPusherQrImageDataUrl,
  sendWxPusherMessage,
  WxPusherError,
} from '@acm/integrations'
import { PrismaService, SchemaStateService } from '../../infrastructure/database/database.module.js'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'
import { loadEnv } from '../../config/env.js'
import { newId } from '../../common/utils.js'
import { DomainError } from '../../common/domain-error.js'

export type WxPusherPreferenceKey = 'points' | 'approvals' | 'activities' | 'competitions' | 'announcements'

export const wxpusherPreferencesSchema = z.object({
  enabled: z.boolean().optional(),
  points: z.boolean().optional(),
  approvals: z.boolean().optional(),
  activities: z.boolean().optional(),
  competitions: z.boolean().optional(),
  announcements: z.boolean().optional(),
}).strict()

export const wxpusherManualBindSchema = z.object({
  uid: z
    .string()
    .trim()
    .regex(/^UID_[A-Za-z0-9_-]{6,60}$/, 'UID 格式不正确（应为 UID_ 开头）'),
}).strict()

export interface WxPusherStatusDto {
  configured: boolean
  ready: boolean
  bound: boolean
  uidMasked: string | null
  enabled: boolean
  preferences: {
    points: boolean
    approvals: boolean
    activities: boolean
    competitions: boolean
    announcements: boolean
  }
  boundAt: string | null
  lastPushedAt: string | null
  lastError: string | null
  callbackUrl: string
}

export interface WxPusherBroadcastInput {
  category: 'activities' | 'competitions' | 'announcements'
  title: string
  body: string
  link?: string | null
  dedupeKey?: string
}

const BIND_TOKEN_TTL_SECONDS = 900 // 15 分钟

function maskUid(uid: string): string {
  if (uid.length <= 10) return `${uid.slice(0, 4)}***`
  return `${uid.slice(0, 8)}…${uid.slice(-4)}`
}

export function buildAbsoluteAppUrl(link?: string | null): string | undefined {
  if (!link) return undefined
  const trimmed = link.trim()
  if (!trimmed) return undefined
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  try {
    const base = loadEnv().PUBLIC_BASE_URL.replace(/\/+$/, '')
    const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
    return `${base}${normalized}`
  } catch {
    return undefined
  }
}

export function formatWxPusherMarkdown(input: {
  tag: string
  title: string
  body: string
  link?: string | null
}): { summary: string; content: string; url?: string } {
  const summary = `【${input.tag}】${input.title}`.slice(0, 100)
  const url = buildAbsoluteAppUrl(input.link)
  const lines = [
    `### ${input.title}`,
    '',
    input.body.trim(),
  ]
  if (url) {
    lines.push('', `[前往协会系统查看详情](${url})`)
  }
  return {
    summary,
    content: lines.join('\n'),
    url,
  }
}

@Injectable()
export class WxPusherService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(SchemaStateService) private readonly schema: SchemaStateService,
    @Optional() @Inject(JobsService) private readonly jobs?: JobsService,
  ) {}

  private appToken(): string | null {
    const token = process.env.WXPUSHER_APP_TOKEN?.trim() || loadEnv().WXPUSHER_APP_TOKEN?.trim()
    return token || null
  }

  isConfigured(): boolean {
    return this.appToken() !== null
  }

  callbackUrl(): string {
    const base = loadEnv().PUBLIC_BASE_URL.replace(/\/+$/, '')
    return `${base}/api/v1/webhooks/wxpusher`
  }

  private ensureReady(): string {
    if (!this.schema.wxpusherReady) {
      throw new DomainError('数据库尚未执行 WxPusher 迁移，请先执行 pnpm db:migrate:deploy 后重启 API', 'INVALID_STATE')
    }
    const token = this.appToken()
    if (!token) {
      throw new DomainError('服务端尚未配置 WXPUSHER_APP_TOKEN，暂不可使用微信推送', 'WXPUSHER_NOT_CONFIGURED')
    }
    return token
  }

  async getStatus(userId: string | null): Promise<WxPusherStatusDto> {
    const configured = this.isConfigured()
    const ready = this.schema.wxpusherReady
    const base: WxPusherStatusDto = {
      configured,
      ready,
      bound: false,
      uidMasked: null,
      enabled: true,
      preferences: {
        points: true,
        approvals: true,
        activities: true,
        competitions: true,
        announcements: true,
      },
      boundAt: null,
      lastPushedAt: null,
      lastError: null,
      callbackUrl: this.callbackUrl(),
    }
    if (!userId || !ready) return base
    const row = await this.db.userWxPusherBinding.findUnique({ where: { userId } })
    if (!row) return base
    return {
      configured,
      ready,
      bound: true,
      uidMasked: maskUid(row.wxpusherUid),
      enabled: row.enabled,
      preferences: {
        points: row.notifyPoints,
        approvals: row.notifyApprovals,
        activities: row.notifyActivities,
        competitions: row.notifyCompetitions,
        announcements: row.notifyAnnouncements,
      },
      boundAt: row.boundAt.toISOString(),
      lastPushedAt: row.lastPushedAt?.toISOString() ?? null,
      lastError: row.lastError ?? null,
      callbackUrl: this.callbackUrl(),
    }
  }

  /** 生成带一次性 extra 令牌的微信关注二维码，扫码关注后由 webhook 自动完成绑定 */
  async createBindQrCode(userId: string): Promise<{
    qrDataUrl: string
    shortUrl: string
    expiresAt: string
    callbackUrl: string
  }> {
    const appToken = this.ensureReady()
    const token = randomBytes(16).toString('hex') // 32 位随机 hex（远小于 64 字符限制）
    const now = new Date()
    const expiresAt = new Date(now.getTime() + BIND_TOKEN_TTL_SECONDS * 1000)

    await this.db.wxPusherBindToken.deleteMany({
      where: { userId, OR: [{ expiresAt: { lt: now } }, { consumedAt: { not: null } }] },
    })
    const bindTokenId = newId()
    await this.db.wxPusherBindToken.create({
      data: { id: bindTokenId, userId, token, expiresAt },
    })

    try {
      const qr = await createWxPusherQrCode({ appToken, extra: token, validTime: BIND_TOKEN_TTL_SECONDS })
      let qrDataUrl = await fetchWxPusherQrImageDataUrl(qr.url)
      if (!qrDataUrl) {
        const target = qr.shortUrl || qr.url
        qrDataUrl = await QRCode.toDataURL(target, { width: 280, margin: 2 })
      }
      return {
        qrDataUrl,
        shortUrl: qr.shortUrl || qr.url,
        expiresAt: qr.expiresAt.toISOString(),
        callbackUrl: this.callbackUrl(),
      }
    } catch (error) {
      await this.db.wxPusherBindToken.delete({ where: { id: bindTokenId } }).catch(() => undefined)
      const message = error instanceof WxPusherError
        ? `生成 WxPusher 二维码失败：${error.message}`
        : '生成 WxPusher 二维码失败，请稍后重试'
      throw new DomainError(message, 'WXPUSHER_QR_FAILED')
    }
  }

  /** 兜底手动绑定 UID（适用于本地开发无公网回调地址或已在 WxPusher 获取 UID 的成员） */
  async bindUidManually(userId: string, rawUid: string): Promise<{ status: WxPusherStatusDto; welcomeSent: boolean; welcomeError: string | null }> {
    const appToken = this.ensureReady()
    const { uid } = wxpusherManualBindSchema.parse({ uid: rawUid })
    await this.upsertBinding(userId, uid)

    let welcomeSent = false
    let welcomeError: string | null = null
    try {
      const formatted = formatWxPusherMarkdown({
        tag: '微信推送已绑定',
        title: '大外 ACM 协会通知绑定成功',
        body: '后续你的**积分变更、审批结果、活动与比赛通知**将实时推送到微信。可在「我的 → 资料与隐私」随时调整推送开关或解绑。',
        link: '/app?section=profile',
      })
      const result = await sendWxPusherMessage({
        appToken,
        content: formatted.content,
        summary: formatted.summary,
        contentType: 3,
        uids: [uid],
        url: formatted.url,
      })
      welcomeSent = result.acceptedCount > 0
      await this.db.userWxPusherBinding.update({
        where: { userId },
        data: {
          lastPushedAt: welcomeSent ? new Date() : undefined,
          lastError: welcomeSent ? null : '消息未被接收，请确认已关注 WxPusher 应用且 UID 正确',
        },
      })
      if (!welcomeSent) {
        welcomeError = '消息未被接收，请确认已关注 WxPusher 应用且 UID 正确'
      }
    } catch (error) {
      welcomeError = error instanceof Error ? error.message : '欢迎消息发送失败'
      await this.db.userWxPusherBinding.update({
        where: { userId },
        data: { lastError: welcomeError.slice(0, 500) },
      }).catch(() => undefined)
    }

    return {
      status: await this.getStatus(userId),
      welcomeSent,
      welcomeError,
    }
  }

  async updatePreferences(userId: string, raw: unknown): Promise<WxPusherStatusDto> {
    if (!this.schema.wxpusherReady) {
      throw new DomainError('数据库尚未执行 WxPusher 迁移', 'INVALID_STATE')
    }
    const patch = wxpusherPreferencesSchema.parse(raw)
    const existing = await this.db.userWxPusherBinding.findUnique({ where: { userId } })
    if (!existing) throw new DomainError('尚未绑定微信推送', 'NOT_FOUND')
    await this.db.userWxPusherBinding.update({
      where: { userId },
      data: {
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.points !== undefined ? { notifyPoints: patch.points } : {}),
        ...(patch.approvals !== undefined ? { notifyApprovals: patch.approvals } : {}),
        ...(patch.activities !== undefined ? { notifyActivities: patch.activities } : {}),
        ...(patch.competitions !== undefined ? { notifyCompetitions: patch.competitions } : {}),
        ...(patch.announcements !== undefined ? { notifyAnnouncements: patch.announcements } : {}),
      },
    })
    return this.getStatus(userId)
  }

  async unbind(userId: string): Promise<{ unbound: boolean }> {
    if (!this.schema.wxpusherReady) return { unbound: false }
    const deleted = await this.db.userWxPusherBinding.deleteMany({ where: { userId } })
    return { unbound: deleted.count > 0 }
  }

  async sendTestMessage(userId: string): Promise<{ sent: boolean; acceptedCount: number }> {
    const appToken = this.ensureReady()
    const binding = await this.db.userWxPusherBinding.findUnique({ where: { userId } })
    if (!binding) throw new DomainError('请先绑定微信推送后再发送测试消息', 'NOT_FOUND')
    const formatted = formatWxPusherMarkdown({
      tag: '测试通知',
      title: '大外 ACM 协会微信推送测试',
      body: '如果你在微信中看到这条消息，说明你的通知通道已连通。后续积分变更、审批动态与赛事活动都会第一时间送达。',
      link: '/app',
    })
    try {
      const result = await sendWxPusherMessage({
        appToken,
        content: formatted.content,
        summary: formatted.summary,
        contentType: 3,
        uids: [binding.wxpusherUid],
        url: formatted.url,
      })
      const okSend = result.acceptedCount > 0
      await this.db.userWxPusherBinding.update({
        where: { userId },
        data: {
          lastPushedAt: okSend ? new Date() : binding.lastPushedAt,
          lastError: okSend ? null : 'WxPusher 未受理该 UID，请确认未取消关注',
        },
      })
      if (!okSend) {
        throw new DomainError('WxPusher 未受理推送，请确认没有取消关注 WxPusher 公众号', 'WXPUSHER_REJECTED')
      }
      return { sent: true, acceptedCount: result.acceptedCount }
    } catch (error) {
      if (error instanceof DomainError) throw error
      const message = error instanceof Error ? error.message : '测试推送失败'
      await this.db.userWxPusherBinding.update({
        where: { userId },
        data: { lastError: message.slice(0, 500) },
      }).catch(() => undefined)
      throw new DomainError(`测试推送失败：${message}`, 'WXPUSHER_SEND_FAILED')
    }
  }

  /**
   * 接收 WxPusher 回调（POST /api/v1/webhooks/wxpusher）：
   * - 仅信任服务端签发、未过期且未消费的一次性 extra 绑定令牌；
   * - 绑定成功后入队欢迎通知。
   */
  async handleWebhook(payload: unknown): Promise<{ accepted: boolean; bound?: boolean; reason?: string }> {
    if (!this.schema.wxpusherReady) {
      return { accepted: false, reason: 'schema_not_ready' }
    }
    const obj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
    const action = typeof obj?.action === 'string' ? obj.action : ''
    if (action !== 'app_subscribe' && action !== 'subscribe') {
      return { accepted: true, bound: false, reason: 'ignored_action' }
    }
    const data = obj?.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : null
    const uid = typeof data?.uid === 'string' ? data.uid.trim() : ''
    const extra = typeof data?.extra === 'string' ? data.extra.trim() : ''
    if (!/^UID_[A-Za-z0-9_-]{4,60}$/.test(uid) || !extra || extra.length > 64) {
      return { accepted: true, bound: false, reason: 'invalid_payload' }
    }

    const now = new Date()
    const bindToken = await this.db.wxPusherBindToken.findUnique({ where: { token: extra } })
    if (!bindToken || bindToken.consumedAt || bindToken.expiresAt <= now) {
      return { accepted: true, bound: false, reason: 'token_invalid_or_expired' }
    }

    const consumed = await this.db.$transaction(async (tx) => {
      const updated = await tx.wxPusherBindToken.updateMany({
        where: { id: bindToken.id, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      })
      if (updated.count === 0) return false
      await tx.userWxPusherBinding.deleteMany({
        where: { wxpusherUid: uid, NOT: { userId: bindToken.userId } },
      })
      await tx.userWxPusherBinding.upsert({
        where: { userId: bindToken.userId },
        create: {
          id: newId(),
          userId: bindToken.userId,
          wxpusherUid: uid,
          enabled: true,
          boundAt: now,
          lastError: null,
        },
        update: {
          wxpusherUid: uid,
          enabled: true,
          boundAt: now,
          lastError: null,
        },
      })
      return true
    })

    if (!consumed) {
      return { accepted: true, bound: false, reason: 'already_consumed' }
    }

    await this.enqueueUserPush({
      userId: bindToken.userId,
      preferenceKey: 'approvals',
      tag: '微信推送已绑定',
      title: '大外 ACM 协会通知绑定成功',
      body: '扫码绑定已完成。后续你的**积分变更、审批结果、比赛活动与社团公告**将实时推送到微信。',
      link: '/app?section=profile',
      force: true,
    })

    return { accepted: true, bound: true }
  }

  /** 单人定向推送入队（best-effort，永不抛出阻断主流程） */
  async enqueueUserPush(input: {
    userId: string
    preferenceKey: WxPusherPreferenceKey
    tag: string
    title: string
    body: string
    link?: string | null
    dedupeKey?: string
    force?: boolean
  }): Promise<void> {
    if (!this.isConfigured() || !this.schema.wxpusherReady || !this.jobs) return
    try {
      const binding = await this.db.userWxPusherBinding.findUnique({
        where: { userId: input.userId },
        select: {
          enabled: true,
          notifyPoints: true,
          notifyApprovals: true,
          notifyActivities: true,
          notifyCompetitions: true,
          notifyAnnouncements: true,
        },
      })
      if (!binding) return
      if (!input.force && !binding.enabled) return
      if (!input.force && !this.preferenceEnabled(binding, input.preferenceKey)) return

      const formatted = formatWxPusherMarkdown({
        tag: input.tag,
        title: input.title,
        body: input.body,
        link: input.link,
      })
      await this.jobs.enqueue({
        type: 'notification.wxpusher_send',
        payload: {
          userId: input.userId,
          preferenceKey: input.preferenceKey,
          summary: formatted.summary,
          content: formatted.content,
          url: formatted.url ?? null,
          force: input.force === true,
        },
        dedupeKey: input.dedupeKey,
        priority: 4,
        maxAttempts: 4,
      })
    } catch {
      // 外部推送入队失败绝不阻断核心业务流程
    }
  }

  /** 社团广播推送入队（活动发布 / 正式赛事发布 / 社团公告发布） */
  async enqueueBroadcastPush(input: WxPusherBroadcastInput): Promise<void> {
    if (!this.isConfigured() || !this.schema.wxpusherReady || !this.jobs) return
    try {
      const tag =
        input.category === 'activities'
          ? '活动通知'
          : input.category === 'competitions'
            ? '赛事通知'
            : '社团公告'
      const formatted = formatWxPusherMarkdown({
        tag,
        title: input.title,
        body: input.body,
        link: input.link,
      })
      await this.jobs.enqueue({
        type: 'notification.wxpusher_broadcast',
        payload: {
          preferenceKey: input.category,
          summary: formatted.summary,
          content: formatted.content,
          url: formatted.url ?? null,
        },
        dedupeKey: input.dedupeKey,
        priority: 4,
        maxAttempts: 4,
      })
    } catch {
      // 外部推送入队失败绝不阻断发布流程
    }
  }

  private async upsertBinding(userId: string, uid: string): Promise<void> {
    const now = new Date()
    await this.db.$transaction(async (tx) => {
      await tx.userWxPusherBinding.deleteMany({
        where: { wxpusherUid: uid, NOT: { userId } },
      })
      await tx.userWxPusherBinding.upsert({
        where: { userId },
        create: {
          id: newId(),
          userId,
          wxpusherUid: uid,
          enabled: true,
          boundAt: now,
          lastError: null,
        },
        update: {
          wxpusherUid: uid,
          enabled: true,
          boundAt: now,
          lastError: null,
        },
      })
    })
  }

  private preferenceEnabled(
    binding: {
      notifyPoints: boolean
      notifyApprovals: boolean
      notifyActivities: boolean
      notifyCompetitions: boolean
      notifyAnnouncements: boolean
    },
    key: WxPusherPreferenceKey,
  ): boolean {
    switch (key) {
      case 'points':
        return binding.notifyPoints
      case 'approvals':
        return binding.notifyApprovals
      case 'activities':
        return binding.notifyActivities
      case 'competitions':
        return binding.notifyCompetitions
      case 'announcements':
        return binding.notifyAnnouncements
    }
  }
}
