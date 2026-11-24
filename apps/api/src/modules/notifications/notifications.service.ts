import { Inject, Injectable, Optional } from '@nestjs/common'
import { PrismaService, SchemaStateService } from '../../infrastructure/database/database.module.js'
import { newId } from '../../common/utils.js'
import { WxPusherService, type WxPusherBroadcastInput, type WxPusherPreferenceKey } from './wxpusher.service.js'

export type NotificationKind =
  | 'leave_decision'
  | 'remote_decision'
  | 'appeal_decision'
  | 'claim_decision'
  | 'room_booking'
  | 'badge_awarded'
  | 'platform_review'
  | 'points_change'
  | 'general'

export interface NotifyInput {
  userId: string
  kind: NotificationKind
  title: string
  body: string
  link?: string | null
}

const KIND_PUSH_META: Record<NotificationKind, { tag: string; preferenceKey: WxPusherPreferenceKey }> = {
  points_change: { tag: '积分变动', preferenceKey: 'points' },
  leave_decision: { tag: '请假审批', preferenceKey: 'approvals' },
  remote_decision: { tag: '远程审批', preferenceKey: 'approvals' },
  appeal_decision: { tag: '积分申诉', preferenceKey: 'approvals' },
  claim_decision: { tag: '贡献申报', preferenceKey: 'approvals' },
  room_booking: { tag: '训练室', preferenceKey: 'approvals' },
  badge_awarded: { tag: '新获徽标', preferenceKey: 'approvals' },
  platform_review: { tag: '平台核验', preferenceKey: 'approvals' },
  general: { tag: '协会通知', preferenceKey: 'approvals' },
}

/**
 * 个人事件通知服务：
 * - 写入采用 best-effort（通知表未迁移或瞬时异常绝不阻断核心审批/记分主流程）；
 * - 站内写入后顺手通过 WxPusherService 异步入队微信推送，由 Worker 统一限流下发；
 * - 查询按用户倒序返回最近 50 条及未读数，支持单条已读与一键全部已读。
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(SchemaStateService) private readonly schema: SchemaStateService,
    @Optional() @Inject(WxPusherService) private readonly wxpusher?: WxPusherService,
  ) {}

  async notify(input: NotifyInput): Promise<void> {
    let notificationId: string | undefined
    if (this.schema.notificationsReady) {
      try {
        notificationId = newId()
        await this.db.userNotification.create({
          data: {
            id: notificationId,
            userId: input.userId,
            kind: input.kind,
            title: input.title.slice(0, 120),
            body: input.body.slice(0, 1000),
            link: input.link ?? null,
          },
        })
      } catch {
        // 通知写失败不中断业务主流程
      }
    }
    const meta = KIND_PUSH_META[input.kind] ?? KIND_PUSH_META.general
    await this.wxpusher?.enqueueUserPush({
      userId: input.userId,
      preferenceKey: meta.preferenceKey,
      tag: meta.tag,
      title: input.title.slice(0, 120),
      body: input.body.slice(0, 1000),
      link: input.link ?? null,
      dedupeKey: notificationId ? `wxpusher:notif:${notificationId}` : undefined,
    })
  }

  /** 社团广播事件外部微信推送（活动发布、正式赛事发布、社团公告发布） */
  async broadcastExternal(input: WxPusherBroadcastInput): Promise<void> {
    await this.wxpusher?.enqueueBroadcastPush(input)
  }

  async listForUser(userId: string | null) {
    if (!userId || !this.schema.notificationsReady) {
      return { items: [], unreadCount: 0 }
    }
    try {
      const [rows, unreadCount] = await Promise.all([
        this.db.userNotification.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { id: true, kind: true, title: true, body: true, link: true, readAt: true, createdAt: true },
        }),
        this.db.userNotification.count({ where: { userId, readAt: null } }),
      ])
      return {
        items: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          title: row.title,
          body: row.body,
          link: row.link,
          read: row.readAt !== null,
          readAt: row.readAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
        unreadCount,
      }
    } catch {
      return { items: [], unreadCount: 0 }
    }
  }

  async markRead(userId: string, id: string): Promise<{ marked: boolean }> {
    if (!this.schema.notificationsReady) return { marked: false }
    const res = await this.db.userNotification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    })
    return { marked: res.count > 0 }
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    if (!this.schema.notificationsReady) return { updated: 0 }
    const res = await this.db.userNotification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    })
    return { updated: res.count }
  }
}
