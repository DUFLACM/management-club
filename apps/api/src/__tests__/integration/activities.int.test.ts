import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { ensureTestDatabase, TEST_URL } from './setup.js'
import { ActivityService } from '../../modules/activities/activity.service.js'
import { ActivityAdminController, ActivityUserController } from '../../modules/activities/activity.controller.js'
import { AttendanceService } from '../../modules/attendance/attendance.service.js'
import type { ContestStandingsService } from '../../modules/activities/contest-standings.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'
import { VenueService } from '../../modules/venues/venue.service.js'
import { createTestUser, makeActor, createApprovedVenue, minutesFromNow } from './helpers.js'
import { activityUpdateSchema } from '../../modules/activities/activity.service.js'

/**
 * 活动报名并发（真实 PostgreSQL）：
 * - 最后名额并发只一人 enrolled，另一人按公告候补
 * - 重复报名幂等返回原状态不重复占名额
 * - 取消释放名额→候补按顺序递补
 * - 必到名单不自动报名，缺席必须走请假流程
 */

process.env.DATABASE_URL = TEST_URL

let db: PrismaService
let activities: ActivityService
let venueService: VenueService

beforeAll(async () => {
  const url = ensureTestDatabase()
  db = new PrismaService(url)
  const audit = new AuditService(db)
  const jobs = new JobsService(db)
  venueService = new VenueService(db, audit)
  activities = new ActivityService(db, audit, jobs, venueService)
})

async function createEditableDraft() {
  const actor = makeActor({ principalKind: 'system' })
  const { versionId } = await createApprovedVenue(venueService, actor, makeActor(), { name: `编辑地点-${crypto.randomUUID().slice(0, 6)}` })
  const input = {
    type: 'training' as const, title: '可编辑草稿', announcement: '草稿原始公告内容',
    startAt: minutesFromNow(60).toISOString(), endAt: minutesFromNow(180).toISOString(),
    venueVersionIds: [versionId], primaryVenueVersionId: versionId,
    attendancePolicy: { policy: 'QR_ONLY' as const, checkinOpenAt: minutesFromNow(45).toISOString(), checkinCloseAt: minutesFromNow(75).toISOString(), qrTtlSeconds: 90 },
    scoringConfig: { category: 'activity', customParameter: 7 },
    contestMeta: { preserved: true },
  }
  const { activityId } = await activities.createActivity(actor, input)
  return { actor, activityId, input, versionId }
}

describe('活动草稿编辑与必填地点', () => {
  it('所有签到策略创建时都要求选择地点，空地点数组也被校验拒绝', async () => {
    for (const policy of ['QR_ONLY', 'GEO_OR_QR'] as const) {
      await expect(activities.createActivity(makeActor(), {
        type: 'training', title: '无地点草稿', announcement: '创建应当直接拒绝',
        startAt: minutesFromNow(60).toISOString(), endAt: minutesFromNow(180).toISOString(),
        attendancePolicy: { policy, checkinOpenAt: minutesFromNow(45).toISOString(), checkinCloseAt: minutesFromNow(75).toISOString() },
      })).rejects.toMatchObject({ code: 'NO_VENUE' })
    }
    expect(activityUpdateSchema.safeParse({ expectedRevision: 1, venueVersionIds: [] }).success).toBe(false)
  })

  it('保存公告、签到策略与地点为同一事务，保留未编辑配置和毫秒时间', async () => {
    const { actor, activityId, input } = await createEditableDraft()
    const { versionId: replacement } = await createApprovedVenue(venueService, actor, makeActor(), { name: '编辑替换地点' })
    const saved = await activities.updateDraft(actor, activityId, {
      expectedRevision: 1, title: '更新后的标题', announcement: '更新后的公告内容', joinNotes: '编辑后的参加须知',
      venueVersionIds: [replacement], primaryVenueVersionId: replacement,
      attendancePolicy: { ...input.attendancePolicy, qrRotateSeconds: 30 },
    })
    expect(saved.revision).toBe(2)
    const detail = await activities.detailForAdmin(activityId)
    expect(detail).toMatchObject({ title: '更新后的标题', status: 'draft', scoringConfig: input.scoringConfig, contestMeta: input.contestMeta, venueVersionId: replacement })
    expect(detail.startAt.toISOString()).toBe(input.startAt)
    expect(detail.venueBindings.map((binding) => binding.venueVersionId)).toEqual([replacement])
    expect(detail.policy).toMatchObject({ qrRotateSeconds: 30, qrTtlSeconds: 90, version: 2 })
    expect(await db.auditLog.count({ where: { action: 'activity.update', resourceId: activityId, actorPrincipalId: actor.principalId } })).toBe(1)
  })

  it('同一版本并发保存仅一个成功，过期版本不会覆盖别人修改', async () => {
    const { actor, activityId } = await createEditableDraft()
    const results = await Promise.allSettled([
      activities.updateDraft(actor, activityId, { expectedRevision: 1, title: '并发修改甲' }),
      activities.updateDraft(actor, activityId, { expectedRevision: 1, title: '并发修改乙' }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('REVISION_CONFLICT')
    expect((await activities.detailForAdmin(activityId)).revision).toBe(2)
  })

  it('非法时间或主地点不属于绑定集合时回滚；非草稿禁止编辑', async () => {
    const { actor, activityId } = await createEditableDraft()
    await expect(activities.updateDraft(actor, activityId, { expectedRevision: 1, title: '不得部分保存', endAt: minutesFromNow(10).toISOString() })).rejects.toMatchObject({ code: 'TIME_ORDER' })
    await expect(activities.updateDraft(actor, activityId, { expectedRevision: 1, primaryVenueVersionId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'VENUE_MISMATCH' })
    expect((await activities.detailForAdmin(activityId))).toMatchObject({ title: '可编辑草稿', revision: 1 })
    for (const status of ['published', 'cancelled', 'archived']) {
      await db.activity.update({ where: { id: activityId }, data: { status } })
      await expect(activities.updateDraft(actor, activityId, { expectedRevision: 1, title: '不得修改' })).rejects.toMatchObject({ code: 'NOT_DRAFT' })
    }
  })

  it('保存与发布共用锁，发布快照匹配最终绑定地点', async () => {
    const { actor, activityId, versionId } = await createEditableDraft()
    const { versionId: replacement } = await createApprovedVenue(venueService, actor, makeActor(), { name: '并发发布替换地点' })
    const [edit, publication] = await Promise.allSettled([
      activities.updateDraft(actor, activityId, { expectedRevision: 1, venueVersionIds: [replacement], primaryVenueVersionId: replacement }),
      activities.publish(actor, activityId),
    ])
    expect(publication.status).toBe('fulfilled')
    const detail = await activities.detailForAdmin(activityId)
    expect(detail.status).toBe('published')
    expect(detail.venueBindings).toHaveLength(1)
    expect(detail.venueBindings[0].venueVersionId).toBe(edit.status === 'fulfilled' ? replacement : versionId)
    expect(detail.venueBindings[0].fenceSnapshot).toBeTruthy()
    if (edit.status === 'rejected') expect(edit.reason.code).toBe('NOT_DRAFT')
  })

  it('旧的无地点草稿不能发布，编辑补地点后可发布，包括纯二维码策略', async () => {
    const { actor, activityId, versionId } = await createEditableDraft()
    await db.activityVenueBinding.deleteMany({ where: { activityId } })
    await db.activity.update({ where: { id: activityId }, data: { venueVersionId: null } })
    await expect(activities.publish(actor, activityId)).rejects.toMatchObject({ code: 'NO_VENUE' })
    await expect(activities.updateDraft(actor, activityId, { expectedRevision: 1, title: '仍缺地点' })).rejects.toMatchObject({ code: 'NO_VENUE' })
    await activities.updateDraft(actor, activityId, { expectedRevision: 1, venueVersionIds: [versionId], primaryVenueVersionId: versionId })
    await activities.publish(actor, activityId)
    expect((await activities.detailForAdmin(activityId)).status).toBe('published')
  })
})

afterAll(async () => {
  await db.$disconnect()
})

async function createPublishedActivity(opts: { capacity: number; waitlist?: number; managerActor?: ReturnType<typeof makeActor> }): Promise<string> {
  const manager = opts.managerActor ?? makeActor()
  const verifier = makeActor()
  const { versionId } = await createApprovedVenue(venueService, manager, verifier, { name: `测试地点-${crypto.randomUUID().slice(0, 6)}` })
  const { activityId } = await activities.createActivity(manager, {
    type: 'weekly_contest',
    title: `并发测试活动-${crypto.randomUUID().slice(0, 6)}`,
    announcement: '并发报名测试活动公告',
    startAt: minutesFromNow(60).toISOString(),
    endAt: minutesFromNow(180).toISOString(),
    registerDeadline: minutesFromNow(30).toISOString(),
    cancelDeadline: minutesFromNow(10).toISOString(),
    capacity: opts.capacity,
    waitlistCapacity: opts.waitlist ?? 0,
    venueVersionIds: [versionId],
    primaryVenueVersionId: versionId,
    attendancePolicy: {
      policy: 'GEO_OR_QR',
      checkinOpenAt: minutesFromNow(45).toISOString(),
      checkinCloseAt: minutesFromNow(75).toISOString(),
      checkoutOpenAt: minutesFromNow(175).toISOString(),
      checkoutCloseAt: minutesFromNow(210).toISOString(),
    },
  })
  await activities.publish(manager, activityId)
  return activityId
}

describe('报名并发与候补', () => {
  it('平台赛报名前必须绑定对应平台账号（待审核绑定即可）', async () => {
    const activityId = await createPublishedActivity({ capacity: 5 })
    await db.activity.update({ where: { id: activityId }, data: { platform: 'codeforces', platformContestId: '2043' } })
    const u = await createTestUser(db, { studentNo: '202602090' })
    await expect(activities.register(u.userId, activityId)).rejects.toMatchObject({ code: 'NEEDS_PLATFORM_BIND' })
    await db.platformAccount.create({ data: { id: crypto.randomUUID(), platform: 'atcoder', externalId: 'someone', userId: u.userId, status: 'verified' } })
    await expect(activities.register(u.userId, activityId)).rejects.toMatchObject({ code: 'NEEDS_PLATFORM_BIND' })
    await db.platformAccount.create({ data: { id: crypto.randomUUID(), platform: 'codeforces', externalId: 'tourist-club', userId: u.userId, status: 'pending_review' } })
    expect((await activities.register(u.userId, activityId)).status).toBe('enrolled')
  })

  it('容量 1 并发两请求：一人 enrolled，一人 waitlisted（不超发）', async () => {
    const activityId = await createPublishedActivity({ capacity: 1, waitlist: 2 })
    const u1 = await createTestUser(db, { studentNo: '202602001' })
    const u2 = await createTestUser(db, { studentNo: '202602002' })
    const [r1, r2] = await Promise.all([
      activities.register(u1.userId, activityId, `k1-${activityId}`),
      activities.register(u2.userId, activityId, `k2-${activityId}`),
    ])
    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual(['enrolled', 'waitlisted'])
    const enrolled = await db.activityRegistration.count({ where: { activityId, status: 'enrolled' } })
    expect(enrolled).toBe(1) // 零名额超发
  })

  it('重复报名幂等：同用户重复提交返回原状态，名额不重复占用', async () => {
    const activityId = await createPublishedActivity({ capacity: 2 })
    const u = await createTestUser(db, { studentNo: '202602003' })
    const r1 = await activities.register(u.userId, activityId, 'dup-1')
    const r2 = await activities.register(u.userId, activityId, 'dup-2')
    expect(r1.status).toBe('enrolled')
    expect(r2.status).toBe('enrolled')
    expect(r2.message).toContain('幂等')
    const count = await db.activityRegistration.count({ where: { activityId, userId: u.userId } })
    expect(count).toBe(1)
  })

  it('取消释放名额 → 候补第一人递补为 enrolled', async () => {
    const activityId = await createPublishedActivity({ capacity: 1, waitlist: 2 })
    const u1 = await createTestUser(db, { studentNo: '202602004' })
    const u2 = await createTestUser(db, { studentNo: '202602005' })
    await activities.register(u1.userId, activityId)
    const w = await activities.register(u2.userId, activityId)
    expect(w.status).toBe('waitlisted')
    const cancel = await activities.cancelRegistration(u1.userId, activityId, '测试取消')
    expect(cancel.status).toBe('cancelled')
    expect(cancel.promoted).toBe('enrolled')
    const u2reg = await db.activityRegistration.findUnique({ where: { activityId_userId: { activityId, userId: u2.userId } } })
    expect(u2reg!.status).toBe('enrolled')
  })

  it('报名截止后拒绝报名', async () => {
    const manager = makeActor()
    const { versionId } = await createApprovedVenue(venueService, manager, makeActor(), { name: `截止-${crypto.randomUUID().slice(0, 4)}` })
    const { activityId } = await activities.createActivity(manager, {
      type: 'lecture',
      title: '截止测试',
      announcement: '报名已截止的活动',
      startAt: minutesFromNow(60).toISOString(),
      endAt: minutesFromNow(120).toISOString(),
      registerDeadline: new Date(Date.now() - 60_000).toISOString(),
      capacity: 10,
      venueVersionIds: [versionId],
      attendancePolicy: {
        policy: 'QR_ONLY',
        checkinOpenAt: minutesFromNow(45).toISOString(),
        checkinCloseAt: minutesFromNow(75).toISOString(),
        checkoutOpenAt: minutesFromNow(115).toISOString(),
        checkoutCloseAt: minutesFromNow(150).toISOString(),
      },
    })
    await activities.publish(manager, activityId)
    const u = await createTestUser(db, { studentNo: '202602006' })
    await expect(activities.register(u.userId, activityId)).rejects.toMatchObject({ code: 'REG_CLOSED' })
  })

  it('设置必到名单不自动报名；重复设置幂等，必到成员可直接请假', async () => {
    const activityId = await createPublishedActivity({ capacity: 1 })
    const u = await createTestUser(db, { studentNo: '202602007' })
    const manager = makeActor()
    await activities.setRequiredParticipants(manager, activityId, [u.userId])
    await activities.setRequiredParticipants(manager, activityId, [u.userId, u.userId])
    const participant = await db.activityParticipant.findUnique({ where: { activityId_userId: { activityId, userId: u.userId } } })
    expect(participant!.required).toBe(true)
    expect(participant!.frozenAt).not.toBeNull()
    expect(await db.activityParticipant.count({ where: { activityId } })).toBe(1)
    expect(await db.activityRegistration.count({ where: { activityId, userId: u.userId } })).toBe(0)
    await activities.requestLeave(u.userId, activityId, '课程冲突')
    expect(await db.leaveRequest.findUnique({ where: { activityId_userId: { activityId, userId: u.userId } } })).toMatchObject({ status: 'pending' })
    await activities.register(u.userId, activityId)
    await expect(activities.cancelRegistration(u.userId, activityId)).rejects.toMatchObject({ code: 'REQUIRED_PARTICIPANT' })
    expect(await db.activityRegistration.findUnique({ where: { activityId_userId: { activityId, userId: u.userId } } })).toMatchObject({ status: 'enrolled' })
    const attendance = await new ActivityAdminController(activities, db).attendanceList(activityId)
    expect(attendance.data.items).toHaveLength(1)
    expect(attendance.data.items[0]).toMatchObject({ userId: u.userId, required: true, regStatus: 'enrolled' })
  })

  it('草稿设置名单和发布只冻结出勤义务，不产生报名记录', async () => {
    const { actor, activityId } = await createEditableDraft()
    const user = await createTestUser(db, { studentNo: crypto.randomUUID() })
    await activities.setRequiredParticipants(actor, activityId, [user.userId])
    expect(await db.activityParticipant.findUnique({ where: { activityId_userId: { activityId, userId: user.userId } } })).toMatchObject({ frozenAt: null })
    await activities.publish(actor, activityId)
    expect(await db.activityRegistration.count({ where: { activityId } })).toBe(0)
    expect(await db.activityParticipant.count({ where: { activityId, required: true, frozenAt: { not: null } } })).toBe(1)
  })

  it('名单包含不存在的成员时全部回滚；取消或归档活动不能设置名单', async () => {
    const activityId = await createPublishedActivity({ capacity: 1 })
    const user = await createTestUser(db, { studentNo: crypto.randomUUID() })
    await expect(activities.setRequiredParticipants(makeActor(), activityId, [user.userId, crypto.randomUUID()])).rejects.toThrow()
    expect(await db.activityParticipant.count({ where: { activityId } })).toBe(0)
    for (const status of ['cancelled', 'archived']) {
      await db.activity.update({ where: { id: activityId }, data: { status } })
      await expect(activities.setRequiredParticipants(makeActor(), activityId, [user.userId])).rejects.toMatchObject({ code: 'STATE_INVALID' })
    }
  })

  it('用户活动目录与详情仅返回本人报名状态，mine 排除其他成员的活动', async () => {
    const ownActivity = await createPublishedActivity({ capacity: 2 })
    const otherActivity = await createPublishedActivity({ capacity: 2 })
    const user = await createTestUser(db, { studentNo: '202602008' })
    const other = await createTestUser(db, { studentNo: '202602009' })
    await activities.register(user.userId, ownActivity)
    await activities.register(other.userId, ownActivity)
    await activities.register(other.userId, otherActivity)
    const controller = new ActivityUserController(activities, {} as AttendanceService, {} as ContestStandingsService)

    const mine = await controller.list({ userId: user.userId }, 'mine')
    expect(mine.data.items.map((item) => item.id)).toEqual([ownActivity])
    expect(mine.data.items[0].myRegistration?.status).toBe('enrolled')

    const viewer = makeActor({ userId: user.userId })
    const detail = await controller.detail(viewer, { userId: user.userId }, ownActivity)
    expect(detail.data.registrations).toHaveLength(1)
    expect(detail.data.registrations[0]).toMatchObject({ userId: user.userId, status: 'enrolled' })
    const unregistered = await controller.detail(viewer, { userId: user.userId }, otherActivity)
    expect(unregistered.data.registrations).toEqual([])
  })
})

describe('讲题申请、活动材料与平台榜单', () => {
  it('申请讲题 → 审批 → 上传材料 → 下载/删除；未获批或类型不符被拒绝', async () => {
    const actor = makeActor({ principalKind: 'system' })
    const { activityId } = await createEditableDraft()
    await activities.publish(actor, activityId)
    const { userId } = await createTestUser(db, { studentNo: '202603001' })

    await expect(activities.createMaterial(undefined, userId, activityId,
      { buffer: Buffer.from('x'), mimetype: 'text/plain', size: 1, originalname: 'a.txt' },
      { title: 'T', kind: 'solution' })).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await activities.submitLectureRequest(userId, activityId, '最短路专题')
    await expect(activities.submitLectureRequest(userId, activityId)).rejects.toMatchObject({ code: 'STATE_INVALID' })

    const requests = await activities.listLectureRequests(activityId)
    const request = requests.find((row) => row.userId === userId)!
    expect(request).toMatchObject({ status: 'pending', topic: '最短路专题' })
    await activities.decideLectureRequest(actor, activityId, request.id, 'approve', '主题合适')
    expect(await activities.canUploadMaterials(undefined, userId, activityId)).toBe(true)

    // 类型白名单外拒绝
    await expect(activities.createMaterial(undefined, userId, activityId,
      { buffer: Buffer.from('<html/>'), mimetype: 'text/html', size: 10, originalname: 'x.html' },
      { title: 'T', kind: 'solution' })).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' })

    const content = '# 题解内容'
    const { materialId } = await activities.createMaterial(undefined, userId, activityId,
      { buffer: Buffer.from(content), mimetype: 'text/markdown', size: Buffer.byteLength(content), originalname: 'sol.md' },
      { title: '题解', kind: 'solution' })
    const dl = await activities.materialForDownload(activityId, materialId)
    expect(dl.material.fileName).toBe('sol.md')
    const fs = await import('node:fs')
    expect(fs.existsSync(dl.filePath)).toBe(true)

    const detail = await activities.detailForUser(userId, activityId)
    expect(detail.materials).toHaveLength(1)
    expect(detail.materials[0]).toMatchObject({ title: '题解', kind: 'solution' })
    expect(detail.lectureRequests[0]).toMatchObject({ status: 'approved' })

    await activities.deleteMaterial(makeActor({ userId }), activityId, materialId)
    expect(await db.activityMaterial.count({ where: { activityId } })).toBe(0)
    expect(fs.existsSync(dl.filePath)).toBe(false)
  })

  it('活动结束后不能再申请讲题；榜单按绑定映射社团成员并输出对题数排名', async () => {
    const { userId } = await createTestUser(db, { studentNo: '202603003' })
    const rival = await createTestUser(db, { studentNo: '202603004' })
    const activityId = crypto.randomUUID()
    await db.activity.create({ data: {
      id: activityId, type: 'weekly_contest', sourceType: 'platform', platform: 'nowcoder', platformContestId: '140235',
      title: '平台赛榜单测试', announcement: '榜单映射测试', status: 'published', createdBy: crypto.randomUUID(),
      startAt: new Date(Date.now() - 7200_000), endAt: new Date(Date.now() - 3600_000),
    } })
    await expect(activities.submitLectureRequest(userId, activityId)).rejects.toMatchObject({ code: 'STATE_INVALID' })

    await db.platformAccount.createMany({ data: [
      { id: crypto.randomUUID(), userId, platform: 'nowcoder', externalId: 'club-a', displayHandle: 'club-a', status: 'verified' },
      { id: crypto.randomUUID(), userId: rival.userId, platform: 'nowcoder', externalId: 'club-b', displayHandle: 'club-b', status: 'verified' },
    ] })

    const standings = {
      fetch: async () => ({
        platform: 'nowcoder', contestId: '140235', available: true as const,
        problems: [
          { index: 'A', name: 'A', fullScore: 100, url: 'https://ac.nowcoder.com/acm/contest/140235/A' },
          { index: 'B', name: 'B', fullScore: 100, url: 'https://ac.nowcoder.com/acm/contest/140235/B' },
        ],
        entries: [
          { handle: 'outsider', rank: 1, score: 200, solvedCount: 2, cells: [
            { index: 'A', score: 100, solved: true, failedCount: 0 }, { index: 'B', score: 100, solved: true, failedCount: 0 }] },
          { handle: 'club-a', rank: 5, score: 150, solvedCount: 2, cells: [
            { index: 'A', score: 100, solved: true, failedCount: 0 }, { index: 'B', score: 50, solved: true, failedCount: 1 }] },
          { handle: 'club-b', rank: 9, score: 100, solvedCount: 1, cells: [
            { index: 'A', score: 100, solved: true, failedCount: 0 }, { index: 'B', score: 0, solved: false, failedCount: 2 }] },
        ],
        fetchedAt: new Date().toISOString(), note: 'fixture',
      }),
    } as unknown as ContestStandingsService

    const result = await activities.activityStandings(userId, activityId, standings)
    if (!result.available) throw new Error('fixture 应返回可用榜单')
    expect(result.ended).toBe(true)
    expect(result.contestUrl).toBe('https://ac.nowcoder.com/acm/contest/140235')
    expect(result.clubRanking.map((row) => row.handle)).toEqual(['club-a', 'club-b'])
    expect(result.clubRanking[0]).toMatchObject({ clubRank: 1, solvedCount: 2, platformRank: 5 })
    expect(result.me).toMatchObject({ handle: 'club-a', solvedCount: 2, score: 150 })
    expect(result.problems.find((problem) => problem.index === 'A')?.clubSolved).toBe(2)
    expect(result.problems.find((problem) => problem.index === 'B')?.clubSolved).toBe(1)
    expect(result.totalEntries).toBe(3)
    expect((result as { entries?: unknown }).entries).toBeUndefined()
  })
})
