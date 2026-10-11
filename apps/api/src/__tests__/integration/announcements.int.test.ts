import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { AnnouncementsService } from '../../modules/announcements/announcements.service.js'
import { ensureTestDatabase, TEST_URL } from './setup.js'
import { makeActor } from './helpers.js'

/**
 * 公告（真实 PostgreSQL）：草稿不可见、发布后可见、发布者自动已读、
 * 成员标记已读、过期与撤回后下线、删除级联已读记录。
 */

process.env.DATABASE_URL = TEST_URL

let db: PrismaService
let announcements: AnnouncementsService

beforeAll(async () => {
  const url = ensureTestDatabase()
  db = new PrismaService(url)
  announcements = new AnnouncementsService(db, new AuditService(db))
})

afterAll(async () => {
  await db.$disconnect()
})

describe('公告', () => {
  it('草稿 → 发布 → 已读 → 撤回 → 删除', async () => {
    const admin = makeActor()
    const member = makeActor({ roles: ['member'] })

    const draft = await announcements.create(admin, { title: '寒假集训', content: '**报名**开始', popup: true, pinned: false }, false)
    expect(await announcements.visible(member.principalId)).toEqual([])
    await expect(announcements.markVisibleRead(member.principalId, draft.id)).rejects.toThrow('公告不存在或已下线')

    await announcements.publish(admin, draft.id)
    await expect(announcements.publish(admin, draft.id)).rejects.toThrow('公告已发布')
    expect(await announcements.visible(member.principalId)).toMatchObject([{ id: draft.id, popup: true, read: false }])
    // 发布者本人自动已读，不会被自己的弹窗打扰
    expect(await announcements.visible(admin.principalId)).toMatchObject([{ id: draft.id, read: true }])

    await announcements.markVisibleRead(member.principalId, draft.id)
    await announcements.markVisibleRead(member.principalId, draft.id) // 幂等
    expect(await announcements.visible(member.principalId)).toMatchObject([{ read: true }])
    expect((await announcements.adminList()).find((a) => a.id === draft.id)).toMatchObject({ status: 'published', readCount: 2 })

    await announcements.withdraw(admin, draft.id)
    expect(await announcements.visible(member.principalId)).toEqual([])

    await announcements.remove(admin, draft.id)
    expect(await db.announcementRead.count({ where: { announcementId: draft.id } })).toBe(0)
    expect(await db.auditLog.count({ where: { resourceType: 'announcement', resourceId: draft.id } })).toBe(4)
  })

  it('置顶在前；过期公告不再展示', async () => {
    const admin = makeActor()
    const member = makeActor({ roles: ['member'] })
    const older = await announcements.create(admin, { title: '旧公告', content: '内容', popup: false, pinned: true }, true)
    const newer = await announcements.create(admin, { title: '新公告', content: '内容', popup: false, pinned: false }, true)
    const expired = await announcements.create(admin, { title: '过期', content: '内容', popup: true, pinned: true, expiresAt: new Date(Date.now() - 60_000).toISOString() }, true)

    const ids = (await announcements.visible(member.principalId)).map((a) => a.id)
    expect(ids).toEqual([older.id, newer.id])
    expect(ids).not.toContain(expired.id)
  })
})
