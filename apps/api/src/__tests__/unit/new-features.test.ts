import { describe, expect, it, vi } from 'vitest'
import type { SessionActor } from '../../modules/auth/session.service.js'

const { NotificationsService } = require('../../../dist/modules/notifications/notifications.service.js')
const { ActivityService } = require('../../../dist/modules/activities/activity.service.js')
const { ScoringService } = require('../../../dist/modules/scoring/scoring.service.js')
const { ProfilesService } = require('../../../dist/modules/profiles/profiles.service.js')

const ACTOR: SessionActor = {
  sessionId: 'sess-1',
  principalId: '11111111-1111-4111-8111-111111111111',
  principalKind: 'system',
  userId: null,
  authzVersion: 1,
  roles: ['presidium', 'system_admin'],
}

const USER_ID = '22222222-2222-4222-8222-222222222222'

describe('NotificationsService', () => {
  it('表未迁移时降级为空列表且写入静默跳过', async () => {
    const db = {
      userNotification: {
        create: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
      },
    }
    const svc = new NotificationsService(db, { notificationsReady: false })
    await svc.notify({ userId: USER_ID, kind: 'general', title: '测试', body: '内容' })
    expect(db.userNotification.create).not.toHaveBeenCalled()
    expect(await svc.listForUser(USER_ID)).toEqual({ items: [], unreadCount: 0 })
  })

  it('正常返回个人通知列表并计算未读数', async () => {
    const now = new Date('2026-11-23T10:00:00.000Z')
    const db = {
      userNotification: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'n1', kind: 'appeal_decision', title: '申诉结案', body: '已补分', link: '/app?section=points', readAt: null, createdAt: now },
        ]),
        count: vi.fn().mockResolvedValue(1),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    }
    const svc = new NotificationsService(db, { notificationsReady: true })
    const res = await svc.listForUser(USER_ID)
    expect(res.unreadCount).toBe(1)
    expect(res.items[0]).toMatchObject({ id: 'n1', read: false, title: '申诉结案' })
    expect(await svc.markAllRead(USER_ID)).toEqual({ updated: 1 })
  })
})

describe('ActivityService 日历与 iCalendar 订阅', () => {
  it('生成符合 RFC 5545 的 .ics 文本并转义特殊字符', async () => {
    const db = {
      activity: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: '33333333-3333-4333-8333-333333333333',
            title: '第 12 场周赛; Div.2, 联考',
            announcement: '第一行\n第二行',
            startAt: new Date('2026-11-25T10:00:00.000Z'),
            endAt: new Date('2026-11-25T12:30:00.000Z'),
            venueVersion: { name: '综合楼', building: '10B', room: '405' },
          },
        ]),
      },
    }
    const svc = new ActivityService(db, { log: vi.fn() }, {}, {})
    const ics = await svc.buildCalendarIcs(USER_ID, 'all')
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).toContain('DTSTART:20261125T100000Z')
    expect(ics).toContain('DTEND:20261125T123000Z')
    expect(ics).toContain('SUMMARY:第 12 场周赛\\; Div.2\\, 联考')
    expect(ics).toContain('LOCATION:综合楼 10B 405')
    expect(ics).toContain('END:VCALENDAR')
  })

  it('签名订阅链接可验真，篡改参数被拒绝', async () => {
    const secret = 'a'.repeat(64)
    const db = {
      appMeta: {
        findUnique: vi.fn().mockResolvedValue({ key: 'calendar:hmac_secret', value: { secret } }),
      },
    }
    const svc = new ActivityService(db, { log: vi.fn() }, {}, {})
    const links = await svc.calendarSubscriptionLinks(USER_ID)
    const url = new URL(links.mineUrl)
    const sig = url.searchParams.get('sig')!
    expect(await svc.verifyCalendarSignature(USER_ID, 'mine', sig)).toBe(true)
    expect(await svc.verifyCalendarSignature(USER_ID, 'all', sig)).toBe(false)
    expect(await svc.verifyCalendarSignature(USER_ID, 'mine', '0'.repeat(32))).toBe(false)
  })
})

describe('ScoringService.decideAppeal', () => {
  it('结案申诉时写入处理结论、审计日志与个人通知', async () => {
    const appealId = '44444444-4444-4444-8444-444444444444'
    const db = {
      appeal: {
        findUnique: vi.fn().mockResolvedValue({
          id: appealId,
          userId: USER_ID,
          subject: '缺少周赛签退记录',
          user: { verifiedRealName: '张三', studentNo: '202600002' },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    }
    const audit = { log: vi.fn().mockResolvedValue(undefined) }
    const notifications = { notify: vi.fn().mockResolvedValue(undefined) }
    const svc = new ScoringService(db, audit, {}, {}, notifications)
    const res = await svc.decideAppeal(ACTOR, appealId, 'resolved', '已核对现场记录并补录 +2 分')
    expect(res).toEqual({ appealId, status: 'resolved' })
    expect(db.appeal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: appealId },
        data: expect.objectContaining({ status: 'resolved', resolutionNote: '已核对现场记录并补录 +2 分' }),
      }),
    )
    expect(audit.log).toHaveBeenCalledTimes(1)
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, kind: 'appeal_decision' }),
    )
  })
})

describe('ProfilesService.autoGrantBadges', () => {
  it('dryRun 预览命中规则但不写库，正式执行幂等授予并推送通知', async () => {
    const db = {
      badgeDefinition: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'def-1', key: 'first_lecture', name: '首讲达人' },
          { id: 'def-2', key: 'cf_specialist', name: 'CF Specialist' },
        ]),
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([
          { id: USER_ID, studentNo: '202600002', verifiedRealName: '张三', profile: null },
        ]),
      },
      lectureRequest: { groupBy: vi.fn().mockResolvedValue([{ userId: USER_ID, _count: { _all: 2 } }]) },
      attendanceAttendanceResult: { groupBy: vi.fn().mockResolvedValue([]) },
      activityMaterial: { groupBy: vi.fn().mockResolvedValue([]) },
      pointsClaim: { groupBy: vi.fn().mockResolvedValue([]) },
      platformResult: { findMany: vi.fn().mockResolvedValue([]) },
      platformRatingPoint: {
        findMany: vi.fn().mockResolvedValue([
          { newValue: 1450, platformAccount: { userId: USER_ID } },
        ]),
      },
      badgeAward: {
        findMany: vi.fn().mockResolvedValue([{ sourceKey: `badge:auto:first_lecture:${USER_ID}` }]),
        create: vi.fn().mockResolvedValue({}),
      },
    }
    const notifications = { notify: vi.fn().mockResolvedValue(undefined) }
    const svc = new ProfilesService(db, {}, notifications)

    const preview = await svc.autoGrantBadges(ACTOR, true)
    expect(preview.dryRun).toBe(true)
    expect(preview.matchedCount).toBe(1) // first_lecture 已有跳过，仅命中 cf_specialist
    expect(preview.items[0].badgeKey).toBe('cf_specialist')
    expect(db.badgeAward.create).not.toHaveBeenCalled()

    const exec = await svc.autoGrantBadges(ACTOR, false)
    expect(exec.grantedCount).toBe(1)
    expect(db.badgeAward.create).toHaveBeenCalledTimes(1)
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, kind: 'badge_awarded' }),
    )
  })
})
