import { Inject, Injectable, Optional } from '@nestjs/common'
import { z } from 'zod'
import { Prisma } from '@acm/db'
import { PrismaService, SchemaStateService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import type { SessionActor } from '../auth/session.service.js'
import { newId } from '../../common/utils.js'
import { DomainError } from '../../common/domain-error.js'

export class AnnouncementsError extends DomainError {
  constructor(message: string, readonly code: 'NOT_FOUND' | 'INVALID_STATE' | 'INVALID_INPUT') {
    super(message, code)
  }
}

export const announcementInputSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(100, '标题不超过 100 字'),
  content: z.string().trim().min(1, '正文不能为空').max(20000, '正文不超过 20000 字'),
  popup: z.boolean().default(false),
  pinned: z.boolean().default(false),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
})
export type AnnouncementInput = z.infer<typeof announcementInputSchema>

const ADMIN_SELECT = {
  id: true, title: true, content: true, popup: true, pinned: true, status: true,
  publishedAt: true, expiresAt: true, createdAt: true, updatedAt: true,
  _count: { select: { reads: true } },
} satisfies Prisma.AnnouncementSelect

/**
 * 公告：管理端撰写草稿 → 发布（可撤回、可删除）；成员端只看已发布且未过期的。
 * popup=true 的公告在成员进入工作台时弹窗，点「我知道了」写入 AnnouncementRead，之后不再弹。
 * 置顶的排在前面，其余按发布时间倒序。
 */
@Injectable()
export class AnnouncementsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SchemaStateService) private readonly schema: SchemaStateService,
    @Optional() @Inject(NotificationsService) private readonly notifications?: NotificationsService,
  ) {}

  /** 迁移未执行时直接给出可操作提示，不反复查询不存在的表 */
  private ensureReady(): void {
    if (!this.schema.announcementsReady) {
      throw new AnnouncementsError(
        '数据库尚未创建公告表，请在服务器执行 `pnpm db:migrate:deploy` 后重启 API',
        'INVALID_STATE',
      )
    }
  }

  async adminList() {
    this.ensureReady()
    try {
      const rows = await this.db.announcement.findMany({
        orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
        take: 200,
        select: ADMIN_SELECT,
      })
      return rows.map(({ _count, ...row }) => ({ ...row, readCount: _count.reads }))
    } catch (error) {
      this.throwIfMissingTable(error)
      throw error
    }
  }

  async create(actor: SessionActor, input: AnnouncementInput, publish: boolean) {
    this.ensureReady()
    const now = new Date()
    const row = await this.db.announcement.create({
      data: {
        id: newId(),
        title: input.title,
        content: input.content,
        popup: input.popup,
        pinned: input.pinned,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        status: publish ? 'published' : 'draft',
        publishedAt: publish ? now : null,
        createdBy: actor.principalId,
      },
      select: { id: true },
    })
    // 发布者本人不必再被自己的公告弹窗
    if (publish) await this.markRead(actor.principalId, row.id)
    await this.audit.log({
      actorPrincipalId: actor.principalId, action: publish ? 'announcements.publish' : 'announcements.create',
      resourceType: 'announcement', resourceId: row.id, summary: `${publish ? '发布' : '新建'}公告「${input.title}」`,
    })
    if (publish) {
      await this.notifications?.broadcastExternal({
        category: 'announcements',
        title: input.title,
        body: input.content.slice(0, 600),
        link: '/app',
        dedupeKey: `wxpusher:announcement:publish:${row.id}`,
      })
    }
    return row
  }

  async update(actor: SessionActor, id: string, input: AnnouncementInput) {
    this.ensureReady()
    await this.require(id)
    await this.db.announcement.update({
      where: { id },
      data: {
        title: input.title,
        content: input.content,
        popup: input.popup,
        pinned: input.pinned,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
    })
    await this.audit.log({
      actorPrincipalId: actor.principalId, action: 'announcements.update', resourceType: 'announcement', resourceId: id,
      summary: `编辑公告「${input.title}」`,
    })
    return { id }
  }

  async publish(actor: SessionActor, id: string) {
    this.ensureReady()
    const row = await this.require(id)
    if (row.status === 'published') throw new AnnouncementsError('公告已发布', 'INVALID_STATE')
    await this.db.announcement.update({ where: { id }, data: { status: 'published', publishedAt: new Date() } })
    await this.markRead(actor.principalId, id)
    await this.audit.log({
      actorPrincipalId: actor.principalId, action: 'announcements.publish', resourceType: 'announcement', resourceId: id,
      summary: `发布公告「${row.title}」`,
    })
    await this.notifications?.broadcastExternal({
      category: 'announcements',
      title: row.title,
      body: row.content.slice(0, 600),
      link: '/app',
      dedupeKey: `wxpusher:announcement:publish:${id}`,
    })
    return { id }
  }

  async withdraw(actor: SessionActor, id: string) {
    this.ensureReady()
    const row = await this.require(id)
    if (row.status !== 'published') throw new AnnouncementsError('只有已发布的公告可以撤回', 'INVALID_STATE')
    await this.db.announcement.update({ where: { id }, data: { status: 'withdrawn' } })
    await this.audit.log({
      actorPrincipalId: actor.principalId, action: 'announcements.withdraw', resourceType: 'announcement', resourceId: id,
      summary: `撤回公告「${row.title}」`,
    })
    return { id }
  }

  async remove(actor: SessionActor, id: string) {
    this.ensureReady()
    const row = await this.require(id)
    await this.db.announcement.delete({ where: { id } })
    await this.audit.log({
      actorPrincipalId: actor.principalId, action: 'announcements.delete', resourceType: 'announcement', resourceId: id,
      summary: `删除公告「${row.title}」`,
    })
    return { id }
  }

  /** 成员端：已发布且未过期的公告，带本人已读标记 */
  async visible(principalId: string) {
    if (!this.schema.announcementsReady) return []
    const now = new Date()
    try {
      const rows = await this.db.announcement.findMany({
        where: { status: 'published', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        orderBy: [{ pinned: 'desc' }, { publishedAt: 'desc' }],
        take: 50,
        select: {
          id: true, title: true, content: true, popup: true, pinned: true, publishedAt: true, expiresAt: true,
          reads: { where: { principalId }, select: { readAt: true } },
        },
      })
      return rows.map(({ reads, ...row }) => ({ ...row, read: reads.length > 0 }))
    } catch (error) {
      // 迁移未执行的旧库：公告不是核心功能，成员端按「暂无公告」处理，避免每次进工作台刷错误日志
      if (this.isMissingTable(error)) return []
      throw error
    }
  }

  async markRead(principalId: string, announcementId: string) {
    await this.db.announcementRead.upsert({
      where: { announcementId_principalId: { announcementId, principalId } },
      create: { announcementId, principalId },
      update: {},
    })
  }

  /** 成员端标记已读：只允许对当前可见的公告 */
  async markVisibleRead(principalId: string, id: string) {
    this.ensureReady()
    const row = await this.db.announcement.findFirst({
      where: { id, status: 'published', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { id: true },
    })
    if (!row) throw new AnnouncementsError('公告不存在或已下线', 'NOT_FOUND')
    await this.markRead(principalId, id)
    return { id, read: true }
  }

  private isMissingTable(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2021'
  }

  private throwIfMissingTable(error: unknown): void {
    if (this.isMissingTable(error)) {
      throw new AnnouncementsError(
        '数据库尚未创建公告表，请在服务器执行 `pnpm db:migrate:deploy` 后重启 API',
        'INVALID_STATE',
      )
    }
  }

  private async require(id: string) {
    this.ensureReady()
    const row = await this.db.announcement.findUnique({ where: { id }, select: { id: true, title: true, content: true, status: true } })
    if (!row) throw new AnnouncementsError('公告不存在', 'NOT_FOUND')
    return row
  }
}
