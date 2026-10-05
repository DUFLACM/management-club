import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { ensureTestDatabase, TEST_URL } from './setup.js'
import { ActivityService } from '../../modules/activities/activity.service.js'
import { ActivityUserController } from '../../modules/activities/activity.controller.js'
import { AttendanceService } from '../../modules/attendance/attendance.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'
import { VenueService } from '../../modules/venues/venue.service.js'
import { createTestUser, makeActor, createApprovedVenue, minutesFromNow } from './helpers.js'

/**
 * 活动报名并发（真实 PostgreSQL）：
 * - 最后名额并发只一人 enrolled，另一人按公告候补
 * - 重复报名幂等返回原状态不重复占名额
 * - 取消释放名额→候补按顺序递补
 * - 必到名单独立于自愿报名
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

  it('必到名单独立：未报名的必到成员不产生报名记录，但可设 required', async () => {
    const activityId = await createPublishedActivity({ capacity: 1 })
    const u = await createTestUser(db, { studentNo: '202602007' })
    const manager = makeActor()
    await activities.setRequiredParticipants(manager, activityId, [u.userId])
    const participant = await db.activityParticipant.findUnique({ where: { activityId_userId: { activityId, userId: u.userId } } })
    expect(participant!.required).toBe(true)
    const regCount = await db.activityRegistration.count({ where: { activityId, userId: u.userId } })
    expect(regCount).toBe(0) // 名单不等于报名
  })

  it('用户活动目录与详情仅返回本人报名状态，mine 排除其他成员的活动', async () => {
    const ownActivity = await createPublishedActivity({ capacity: 2 })
    const otherActivity = await createPublishedActivity({ capacity: 2 })
    const user = await createTestUser(db, { studentNo: '202602008' })
    const other = await createTestUser(db, { studentNo: '202602009' })
    await activities.register(user.userId, ownActivity)
    await activities.register(other.userId, ownActivity)
    await activities.register(other.userId, otherActivity)
    const controller = new ActivityUserController(activities, {} as AttendanceService)

    const mine = await controller.list({ userId: user.userId }, 'mine')
    expect(mine.data.items.map((item) => item.id)).toEqual([ownActivity])
    expect(mine.data.items[0].myRegistration?.status).toBe('enrolled')

    const detail = await controller.detail({ userId: user.userId }, ownActivity)
    expect(detail.data.registrations).toHaveLength(1)
    expect(detail.data.registrations[0]).toMatchObject({ userId: user.userId, status: 'enrolled' })
    const unregistered = await controller.detail({ userId: user.userId }, otherActivity)
    expect(unregistered.data.registrations).toEqual([])
  })
})
