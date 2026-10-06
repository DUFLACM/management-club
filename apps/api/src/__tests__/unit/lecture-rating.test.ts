import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionActor } from '../../modules/auth/session.service.js'

// 与 activity-detail-http 一致：从 tsc 产物载入带装饰器元数据的服务实现
const { ActivityService } = require('../../../dist/modules/activities/activity.service.js')

/** 讲题满意度：资格口径（到场 + 活动已结束 + 非本人）与匿名可见性收敛 */

const activityId = '11111111-1111-4111-8111-111111111111'
const lectureRequestId = '22222222-2222-4222-8222-222222222222'
const lecturerUserId = '33333333-3333-4333-8333-333333333333'
const viewerUserId = '44444444-4444-4444-8444-444444444444'

const PAST = new Date(Date.now() - 3_600_000)
const FUTURE = new Date(Date.now() + 3_600_000)

let ratingSeq = 0
/** 评分行 id 生产中为随机 uuid，这里也不要从 raterUserId 派生，否则匿名性断言失真 */
function makeRating(score: number, comment: string | null, raterUserId = viewerUserId) {
  ratingSeq += 1
  return { id: `rating-${ratingSeq}`, raterUserId, score, comment, createdAt: PAST }
}

function makeDb(opts: {
  endAt?: Date
  hasPolicy?: boolean
  lectures?: unknown[]
  checkin?: boolean
  attendanceStatus?: string | null
  registrationStatus?: string | null
} = {}) {
  const lectureRatingFindUnique = vi.fn().mockResolvedValue(null)
  const lectureRatingCreate = vi.fn().mockResolvedValue({})
  const lectureRatingUpdate = vi.fn().mockResolvedValue({})
  const lectureRatingDelete = vi.fn().mockResolvedValue({})
  const lectures = opts.lectures ?? []
  const db = {
    activity: {
      findUnique: vi.fn().mockResolvedValue({
        endAt: opts.endAt ?? PAST,
        policy: opts.hasPolicy === false ? null : { id: 'policy-1' },
      }),
    },
    lectureRequest: {
      findMany: vi.fn().mockResolvedValue(lectures),
      findUnique: vi.fn().mockResolvedValue({
        id: lectureRequestId,
        activityId,
        userId: lecturerUserId,
        status: 'approved',
        activity: { endAt: opts.endAt ?? PAST, policy: opts.hasPolicy === false ? null : { id: 'policy-1' } },
      }),
    },
    lectureRating: {
      findUnique: lectureRatingFindUnique,
      create: lectureRatingCreate,
      update: lectureRatingUpdate,
      delete: lectureRatingDelete,
    },
    attendanceCheckpoint: {
      findUnique: vi.fn().mockResolvedValue(opts.checkin === false ? null : { id: 'cp-1' }),
    },
    attendanceAttendanceResult: {
      findUnique: vi.fn().mockResolvedValue(
        opts.attendanceStatus ? { status: opts.attendanceStatus } : null,
      ),
    },
    activityRegistration: {
      findUnique: vi.fn().mockResolvedValue(
        opts.registrationStatus ? { status: opts.registrationStatus } : null,
      ),
    },
  }
  return db
}

const audit = { log: vi.fn() }

function makeService(db: unknown) {
  return new ActivityService(db, audit, {}, {})
}

function approvedLecture(ratings: unknown[] = []) {
  return {
    id: lectureRequestId,
    activityId,
    userId: lecturerUserId,
    topic: '最短路专题',
    status: 'approved',
    reviewedAt: PAST,
    createdAt: PAST,
    user: { id: lecturerUserId, verifiedRealName: '讲题同学', profile: null },
    ratings,
  }
}

function actorWith(roles: string[], userId: string): SessionActor {
  return {
    sessionId: 'session-1', principalId: 'principal-1', principalKind: 'student',
    userId, authzVersion: 1, roles,
  }
}

beforeEach(() => {
  audit.log.mockReset()
})

describe('讲题满意度区块', () => {
  it('活动没有获批讲题时不返回任何评价块', async () => {
    const db = makeDb({ lectures: [] })
    const rows = await makeService(db).lectureRatings(viewerUserId, activityId)
    expect(rows).toEqual([])
    // 提前返回，不再去查出勤口径
    expect(db.attendanceCheckpoint.findUnique).not.toHaveBeenCalled()
  })

  it('活动未结束时不开放评分', async () => {
    const db = makeDb({ endAt: FUTURE, lectures: [approvedLecture()] })
    const [row] = await makeService(db).lectureRatings(viewerUserId, activityId)
    expect(row.canRate).toBe(false)
    expect(row.blockedReason).toBe('活动结束后开放满意度评分')
  })

  it('已结束且有入场打点的成员可评分，但看不到汇总', async () => {
    const db = makeDb({ lectures: [approvedLecture([makeRating(5, '讲得好', 'other-user')])] })
    const [row] = await makeService(db).lectureRatings(viewerUserId, activityId)
    expect(row).toMatchObject({ canRate: true, blockedReason: null, isLecturer: false, myScore: null })
    expect(row.stats).toBeNull()
    expect(row.comments).toBeNull()
  })

  it('未到场的成员不能评分', async () => {
    const db = makeDb({ checkin: false, attendanceStatus: 'absent', lectures: [approvedLecture()] })
    const [row] = await makeService(db).lectureRatings(viewerUserId, activityId)
    expect(row.canRate).toBe(false)
    expect(row.blockedReason).toBe('仅本次活动的到场成员可以评分')
  })

  it('活动未设签到环节时退回「已报名」口径', async () => {
    const enrolled = makeDb({ hasPolicy: false, checkin: false, registrationStatus: 'enrolled', lectures: [approvedLecture()] })
    expect((await makeService(enrolled).lectureRatings(viewerUserId, activityId))[0].canRate).toBe(true)
    const cancelled = makeDb({ hasPolicy: false, checkin: false, registrationStatus: 'cancelled', lectures: [approvedLecture()] })
    expect((await makeService(cancelled).lectureRatings(viewerUserId, activityId))[0].canRate).toBe(false)
  })

  it('讲题人本人看汇总但不自评，样本不足时不展示匿名评语', async () => {
    const db = makeDb({
      lectures: [approvedLecture([makeRating(5, '讲得好', 'u1'), makeRating(3, '节奏偏快', 'u2')])],
    })
    const [row] = await makeService(db).lectureRatings(lecturerUserId, activityId)
    expect(row).toMatchObject({ isLecturer: true, canRate: false, blockedReason: '讲题人不对本人讲题评分' })
    expect(row.stats).toMatchObject({ count: 2, average: 4 })
    expect(row.stats?.distribution).toEqual([0, 0, 1, 0, 1])
    expect(row.comments).toBeNull()
    expect(row.hiddenComments).toBe(2)
  })

  it('样本达到 3 人后讲题人可见匿名评语，且不含评价人身份', async () => {
    const db = makeDb({
      lectures: [approvedLecture([
        makeRating(5, '讲得好', 'u1'), makeRating(4, null, 'u2'), makeRating(3, '节奏偏快', 'u3'),
      ])],
    })
    const [row] = await makeService(db).lectureRatings(lecturerUserId, activityId)
    expect(row.stats).toMatchObject({ count: 3, average: 4 })
    expect(row.comments).toHaveLength(2)
    expect(JSON.stringify(row)).not.toContain('u1')
    expect(JSON.stringify(row)).not.toContain('raterUserId')
  })

  it('activity.manage 可见汇总与全部匿名评语', async () => {
    const db = makeDb({ lectures: [approvedLecture([makeRating(2, '希望多讲例题', 'u1')])] })
    const [row] = await makeService(db).lectureRatings(
      viewerUserId, activityId, actorWith(['activity_manager'], viewerUserId),
    )
    expect(row.stats).toMatchObject({ count: 1, average: 2 })
    expect(row.comments).toHaveLength(1)
    expect(row.hiddenComments).toBe(0)
  })

  it('本人已评分时回显自己的分数与评语', async () => {
    const db = makeDb({ lectures: [approvedLecture([makeRating(4, '很有收获')])] })
    const [row] = await makeService(db).lectureRatings(viewerUserId, activityId)
    expect(row).toMatchObject({ myScore: 4, myComment: '很有收获' })
  })
})

describe('提交讲题评分', () => {
  it('首次提交写入评分，审计不记录评价人主体', async () => {
    const db = makeDb()
    await makeService(db).submitLectureRating(viewerUserId, activityId, lectureRequestId, { score: 4, comment: ' 讲得好 ' })
    expect(db.lectureRating.create.mock.calls[0][0].data).toMatchObject({
      lectureRequestId, raterUserId: viewerUserId, score: 4, comment: '讲得好',
    })
    expect(audit.log.mock.calls[0][0]).toMatchObject({ action: 'activity.lecture_rating_create' })
    expect(audit.log.mock.calls[0][0].actorPrincipalId).toBeUndefined()
  })

  it('重复提交改为更新，空评语落为 null', async () => {
    const db = makeDb()
    db.lectureRating.findUnique.mockResolvedValue({ id: 'existing-rating' })
    await makeService(db).submitLectureRating(viewerUserId, activityId, lectureRequestId, { score: 2, comment: '   ' })
    expect(db.lectureRating.create).not.toHaveBeenCalled()
    expect(db.lectureRating.update.mock.calls[0][0].data).toEqual({ score: 2, comment: null })
    expect(audit.log.mock.calls[0][0].action).toBe('activity.lecture_rating_update')
  })

  it('讲题人不能给自己评分', async () => {
    const db = makeDb()
    await expect(
      makeService(db).submitLectureRating(lecturerUserId, activityId, lectureRequestId, { score: 5 }),
    ).rejects.toMatchObject({ code: 'RECUSED' })
    expect(db.lectureRating.create).not.toHaveBeenCalled()
  })

  it('活动未结束或未到场时拒绝提交', async () => {
    const early = makeDb({ endAt: FUTURE })
    await expect(
      makeService(early).submitLectureRating(viewerUserId, activityId, lectureRequestId, { score: 5 }),
    ).rejects.toMatchObject({ code: 'STATE_INVALID' })
    const absent = makeDb({ checkin: false })
    await expect(
      makeService(absent).submitLectureRating(viewerUserId, activityId, lectureRequestId, { score: 5 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('讲题申请未获批时拒绝提交', async () => {
    const db = makeDb()
    db.lectureRequest.findUnique.mockResolvedValue({
      id: lectureRequestId, activityId, userId: lecturerUserId, status: 'pending',
      activity: { endAt: PAST, policy: { id: 'policy-1' } },
    })
    await expect(
      makeService(db).submitLectureRating(viewerUserId, activityId, lectureRequestId, { score: 5 }),
    ).rejects.toMatchObject({ code: 'STATE_INVALID' })
  })

  it('撤销评分需先有本人评分', async () => {
    const db = makeDb()
    await expect(
      makeService(db).deleteLectureRating(viewerUserId, activityId, lectureRequestId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    db.lectureRating.findUnique.mockResolvedValue({ id: 'existing-rating' })
    await makeService(db).deleteLectureRating(viewerUserId, activityId, lectureRequestId)
    expect(db.lectureRating.delete.mock.calls[0][0]).toEqual({ where: { id: 'existing-rating' } })
    expect(audit.log.mock.calls[0][0].action).toBe('activity.lecture_rating_delete')
  })
})
