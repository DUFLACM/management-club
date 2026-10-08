import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { ensureTestDatabase, TEST_URL } from './setup.js'
import { VenueService } from '../../modules/venues/venue.service.js'
import { ActivityService } from '../../modules/activities/activity.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'
import { makeActor, minutesFromNow } from './helpers.js'

/**
 * 地点认证流（真实 PostgreSQL）：
 * - draft → pending → approved/rejected 状态机
 * - 创建者/编辑者/提交者按 principal 完整回避（换人提交不绕过）
 * - 样本仅 draft 可追加（提交后冻结）
 * - 未认证地点不能发布活动；认证窗口不覆盖发布窗口被拒
 * - 新草稿不移动已发布活动围栏
 */

process.env.DATABASE_URL = TEST_URL

let db: PrismaService
let venueService: VenueService
let activityService: ActivityService

const creator = makeActor()
const editor = makeActor()
const submitter = makeActor()
const verifier = makeActor()

beforeAll(async () => {
  const url = ensureTestDatabase()
  db = new PrismaService(url)
  const audit = new AuditService(db)
  venueService = new VenueService(db, audit)
  activityService = new ActivityService(db, audit, new JobsService(db), venueService)
})

afterAll(async () => {
  await db.$disconnect()
})

const baseDraft = {
  name: '回避测试地点',
  building: 'A 座',
  room: '404',
  latitude: 39.9,
  longitude: 116.4,
  radiusMeters: 60,
  maxAccuracyMeters: 40,
  allowedCapabilities: ['GEO', 'QR'] as never,
  coordinateSource: 'manual_verified' as const,
}

describe('审核与状态机', () => {
  it('创建者可以直接审核自己提交的版本', async () => {
    const { venueId, versionId } = await venueService.createVenue(creator, baseDraft)
    await venueService.submitForReview(creator, venueId, versionId, 1)
    await venueService.decide(creator, venueId, versionId, 'approve', '自审通过')
    const version = await db.venueVersion.findUnique({ where: { id: versionId } })
    expect(version!.status).toBe('approved')
  })

  it('编辑者 / 提交者同样可审核（贡献者仅留痕）', async () => {
    const { venueId, versionId } = await venueService.createVenue(creator, { ...baseDraft, name: '换人提交测试' })
    await venueService.updateDraft(editor, venueId, versionId, 1, { ...baseDraft, name: '换人提交测试-改' })
    await venueService.submitForReview(submitter, venueId, versionId, 2)
    await venueService.decide(editor, venueId, versionId, 'approve', '编辑者审核')
    expect((await db.venueVersion.findUnique({ where: { id: versionId } }))!.status).toBe('approved')
  })

  it('样本仅 draft 可追加；提交后冻结', async () => {
    const { venueId, versionId } = await venueService.createVenue(creator, { ...baseDraft, name: '样本冻结测试' })
    await venueService.addSample(creator, venueId, versionId, {
      source: 'browser_geolocation', sampledAt: new Date().toISOString(), latitude: 39.9, longitude: 116.4, accuracyMeters: 12, deviceType: 'phone',
    })
    await venueService.submitForReview(creator, venueId, versionId, 1)
    await expect(
      venueService.addSample(creator, venueId, versionId, { source: 'manual_note', sampledAt: new Date().toISOString() }),
    ).rejects.toMatchObject({ code: 'FROZEN' })
  })

  it('驳回附理由；复制为新草稿重新提交后原驳回版本不变', async () => {
    const { venueId, versionId } = await venueService.createVenue(creator, { ...baseDraft, name: '驳回修订测试' })
    await venueService.submitForReview(creator, venueId, versionId, 1)
    await venueService.decide(verifier, venueId, versionId, 'reject', '样本不足')
    const rejected = await db.venueVersion.findUnique({ where: { id: versionId } })
    expect(rejected!.status).toBe('rejected')
    expect(rejected!.rejectedReason).toBe('样本不足')
    const { versionId: draft2 } = await venueService.newDraftFromVersion(creator, venueId, versionId, { ...baseDraft, name: '驳回修订测试-v2' })
    await venueService.submitForReview(creator, venueId, draft2, 1)
    await venueService.decide(verifier, venueId, draft2, 'approve', '补充后通过')
    expect((await db.venueVersion.findUnique({ where: { id: versionId } }))!.status).toBe('rejected') // 原版本不被改写
  })

  it('声明 GEO 能力必须有坐标；QR_ONLY 可无坐标', async () => {
    await expect(
      venueService.createVenue(creator, { ...baseDraft, name: '无坐标GEO', latitude: undefined, longitude: undefined, radiusMeters: undefined, maxAccuracyMeters: undefined }),
    ).rejects.toMatchObject({ code: 'GEO_NEEDS_COORDS' })
    const qrOnly = await venueService.createVenue(creator, { ...baseDraft, name: '纯二维码地点', latitude: undefined, longitude: undefined, radiusMeters: undefined, maxAccuracyMeters: undefined, allowedCapabilities: ['QR'] as never })
    expect(qrOnly.versionId).toBeTruthy()
  })
})

describe('活动发布校验', () => {
  it('未认证地点（pending_review）不能发布', async () => {
    const { venueId, versionId } = await venueService.createVenue(creator, { ...baseDraft, name: '待认证地点' })
    await venueService.submitForReview(creator, venueId, versionId, 1)
    const { activityId } = await activityService.createActivity(makeActor(), {
      type: 'weekly_contest', title: '发布阻塞测试', announcement: 'x'.repeat(10),
      startAt: minutesFromNow(60).toISOString(), endAt: minutesFromNow(180).toISOString(),
      venueVersionIds: [versionId], primaryVenueVersionId: versionId,
      attendancePolicy: { policy: 'QR_ONLY', checkinOpenAt: minutesFromNow(45).toISOString(), checkinCloseAt: minutesFromNow(75).toISOString(), checkoutOpenAt: minutesFromNow(175).toISOString(), checkoutCloseAt: minutesFromNow(210).toISOString() },
    })
    await expect(activityService.publish(makeActor(), activityId)).rejects.toMatchObject({ code: 'VENUE_NOT_VERIFIED' })
  })

  it('认证有效区间不覆盖 IN/OUT 完整窗口被拒', async () => {
    // approved 但 validUntil 很短
    const { venueId, versionId } = await venueService.createVenue(creator, {
      ...baseDraft, name: '短有效期地点',
      validFrom: new Date(Date.now() - 3600_000).toISOString(), validUntil: minutesFromNow(30).toISOString(),
    })
    await venueService.submitForReview(creator, venueId, versionId, 1)
    await venueService.decide(verifier, venueId, versionId, 'approve', '短效期')
    const { activityId } = await activityService.createActivity(makeActor(), {
      type: 'weekly_contest', title: '窗口覆盖测试', announcement: 'x'.repeat(10),
      startAt: minutesFromNow(60).toISOString(), endAt: minutesFromNow(180).toISOString(),
      venueVersionIds: [versionId], primaryVenueVersionId: versionId,
      attendancePolicy: { policy: 'GEO_OR_QR', checkinOpenAt: minutesFromNow(45).toISOString(), checkinCloseAt: minutesFromNow(75).toISOString(), checkoutOpenAt: minutesFromNow(175).toISOString(), checkoutCloseAt: minutesFromNow(210).toISOString() },
    })
    await expect(activityService.publish(makeActor(), activityId)).rejects.toMatchObject({ code: 'VENUE_WINDOW_NOT_COVERED' })
  })

  it('已发布活动围栏不被地点新草稿移动', async () => {
    const { venueId, versionId } = await venueService.createVenue(creator, { ...baseDraft, name: '围栏稳定测试', radiusMeters: 60 })
    await venueService.submitForReview(creator, venueId, versionId, 1)
    await venueService.decide(verifier, venueId, versionId, 'approve', 'ok')
    const { activityId } = await activityService.createActivity(makeActor(), {
      type: 'weekly_contest', title: '围栏快照测试', announcement: 'x'.repeat(10),
      startAt: minutesFromNow(60).toISOString(), endAt: minutesFromNow(180).toISOString(),
      venueVersionIds: [versionId], primaryVenueVersionId: versionId,
      attendancePolicy: { policy: 'GEO_OR_QR', checkinOpenAt: minutesFromNow(45).toISOString(), checkinCloseAt: minutesFromNow(75).toISOString(), checkoutOpenAt: minutesFromNow(175).toISOString(), checkoutCloseAt: minutesFromNow(210).toISOString() },
    })
    await activityService.publish(makeActor(), activityId)
    const bindingBefore = await db.activityVenueBinding.findUnique({ where: { activityId_venueVersionId: { activityId, venueVersionId: versionId } } })
    // 地点建新草稿改坐标
    const { versionId: v2 } = await venueService.newDraftFromVersion(creator, venueId, versionId, { ...baseDraft, name: '围栏稳定测试', radiusMeters: 500, latitude: 40, longitude: 117 })
    await venueService.submitForReview(creator, venueId, v2, 1)
    await venueService.decide(verifier, venueId, v2, 'approve', '新版本')
    const bindingAfter = await db.activityVenueBinding.findUnique({ where: { activityId_venueVersionId: { activityId, venueVersionId: versionId } } })
    expect(bindingAfter!.fenceSnapshot).toEqual(bindingBefore!.fenceSnapshot) // 活动围栏不动
    expect((bindingAfter!.fenceSnapshot as { radiusMeters: number }).radiusMeters).toBe(60)
  })
})
