import { describe, expect, it, vi } from 'vitest'
import type { SessionActor } from '../../modules/auth/session.service.js'

const { NotificationsService } = require('../../../dist/modules/notifications/notifications.service.js')
const { ActivityService } = require('../../../dist/modules/activities/activity.service.js')
const { ScoringService } = require('../../../dist/modules/scoring/scoring.service.js')
const { ProfilesService } = require('../../../dist/modules/profiles/profiles.service.js')
const { ProfilesController } = require('../../../dist/modules/profiles/profiles.controller.js')

const ACTOR: SessionActor = {
  sessionId: 'sess-1',
  principalId: '11111111-1111-4111-8111-111111111111',
  principalKind: 'system',
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

  it('myLedger 自动把内部 sourceKey 解析为事件名称与活动跳转链接', async () => {
    const activityId = '55555555-5555-4555-8555-555555555555'
    const claimId = '66666666-6666-4666-8666-666666666666'
    const now = new Date('2026-11-20T10:00:00.000Z')
    const db = {
      pointsLedgerEntry: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'e1',
            sourceKey: `contest:codeforces:2000:W:${USER_ID}`,
            category: 'contest',
            amount: '10.50',
            scoreMonth: '2026-11',
            recordedAt: now,
            status: 'approved',
            ruleVersionId: null,
            reversesEntryId: null,
            replacedByEntryId: null,
            reversalReason: null,
            detail: { activityId, formula: { B: 2, lambda: 1, S: 2, R: 4.5, X: 2, W: 10.5 } },
          },
          {
            id: 'e2',
            sourceKey: `contribution:${USER_ID}:${claimId}`,
            category: 'contribution',
            amount: '3.00',
            scoreMonth: '2026-11',
            recordedAt: now,
            status: 'approved',
            ruleVersionId: null,
            reversesEntryId: null,
            replacedByEntryId: null,
            reversalReason: null,
            detail: { claimId, title: '最短路专题讲题' },
          },
        ]),
      },
      activity: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: activityId,
            title: '第 10 场算法周赛',
            type: 'weekly_contest',
            startAt: now,
            endAt: now,
            platform: 'codeforces',
            platformContestId: '2000',
            venueVersion: { name: '综合楼', building: '10B', room: '405' },
          },
        ]),
      },
      competitionEvent: { findMany: vi.fn().mockResolvedValue([]) },
      pointsClaim: {
        findMany: vi.fn().mockResolvedValue([
          { id: claimId, title: '最短路专题讲题', category: 'contribution_lecture', description: '讲解 Dijkstra 与 SPFA', reviewNote: '通过', createdAt: now },
        ]),
      },
    }
    const svc = new ScoringService(db, { log: vi.fn() }, {}, {})
    const res = await svc.myLedger(USER_ID, {})
    expect(res.items[0]).toMatchObject({
      eventName: '第 10 场算法周赛',
      eventKind: 'activity',
      eventLink: `/app?section=activities&activity=${activityId}`,
    })
    expect(res.items[1]).toMatchObject({
      eventName: '最短路专题讲题',
      eventKind: 'claim',
      eventLink: '/app?section=contributions',
    })
  })

  it('submitAppeal 校验流水归属并阻止同流水重复申诉', async () => {
    const ledgerEntryId = '77777777-7777-4777-8777-777777777777'
    const dbMissing = {
      pointsLedgerEntry: { findFirst: vi.fn().mockResolvedValue(null) },
      appeal: { findFirst: vi.fn(), create: vi.fn() },
    }
    const svcMissing = new ScoringService(dbMissing, { log: vi.fn() }, {}, {})
    await expect(
      svcMissing.submitAppeal(USER_ID, { ledgerEntryId, subject: '积分统计与榜单不符' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const dbConflict = {
      pointsLedgerEntry: { findFirst: vi.fn().mockResolvedValue({ id: ledgerEntryId }) },
      appeal: { findFirst: vi.fn().mockResolvedValue({ id: 'open-appeal' }), create: vi.fn() },
    }
    const svcConflict = new ScoringService(dbConflict, { log: vi.fn() }, {}, {})
    await expect(
      svcConflict.submitAppeal(USER_ID, { ledgerEntryId, subject: '积分统计与榜单不符' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const dbOk = {
      pointsLedgerEntry: { findFirst: vi.fn().mockResolvedValue({ id: ledgerEntryId }) },
      appeal: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    }
    const svcOk = new ScoringService(dbOk, { log: vi.fn() }, {}, {})
    const created = await svcOk.submitAppeal(USER_ID, {
      ledgerEntryId,
      subject: '积分统计与榜单不符',
      materials: '附赛后截图说明',
    })
    expect(created.appealId).toBeTruthy()
    expect(dbOk.appeal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: USER_ID, ledgerEntryId, subject: '积分统计与榜单不符' }),
      }),
    )
  })

  it('decideAppeal 采纳并冲正替换时在事务中冲正原流水、生成替代条目并通知成员', async () => {
    const appealId = '88888888-8888-4888-8888-888888888888'
    const entryId = '99999999-9999-4999-8999-999999999999'
    const activityId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pointsLedgerEntry: {
        findUnique: vi.fn().mockResolvedValue({
          id: entryId,
          userId: USER_ID,
          sourceKey: `activity:${activityId}:${USER_ID}`,
          category: 'activity',
          amount: { neg: () => ({ toFixed: (d: number) => (-2).toFixed(d) }), toString: () => '2' },
          scoreMonth: '2026-11',
          status: 'approved',
          ruleVersionId: null,
          detail: { activityId, activityTitle: '第 11 场算法周赛' },
        }),
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      appeal: { update: vi.fn().mockResolvedValue({}) },
    }
    const db = {
      appeal: {
        findUnique: vi.fn().mockResolvedValue({
          id: appealId,
          userId: USER_ID,
          ledgerEntryId: entryId,
          status: 'submitted',
          subject: '漏算组队加分',
          user: { verifiedRealName: '张三', studentNo: '202600002' },
        }),
      },
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    }
    const audit = { log: vi.fn().mockResolvedValue(undefined) }
    const notifications = { notify: vi.fn().mockResolvedValue(undefined) }
    const svc = new ScoringService(db, audit, {}, {}, notifications)

    const res = await svc.decideAppeal(ACTOR, appealId, 'resolved', '核实无误，更正为 4 分', {
      ledgerAction: 'replace',
      replacementAmount: '4',
    })
    expect(res).toMatchObject({
      appealId,
      status: 'resolved',
      ledgerAction: 'replace',
    })
    expect(res.reversalId).toBeTruthy()
    expect(res.replacementId).toBeTruthy()
    expect(tx.pointsLedgerEntry.create).toHaveBeenCalledTimes(2)
    expect(tx.pointsLedgerEntry.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER_ID,
          amount: '4',
          scoreMonth: '2026-11',
          detail: expect.objectContaining({ activityId, replacesEntryId: entryId }),
        }),
      }),
    )
    expect(tx.appeal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: appealId },
        data: expect.objectContaining({ status: 'resolved', resolutionNote: '核实无误，更正为 4 分' }),
      }),
    )
    expect(audit.log).toHaveBeenCalledTimes(1)
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        kind: 'appeal_decision',
        body: expect.stringContaining('+4 分'),
      }),
    )
  })

  it('decideAppeal 采纳并补录调账时写入 appeal:<id> 流水并拒绝已结案或非采纳态调账', async () => {
    const appealId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const entryId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const tx = {
      pointsLedgerEntry: {
        findUnique: vi.fn().mockResolvedValue({
          id: entryId,
          category: 'contest',
          scoreMonth: '2026-10',
          detail: { activityTitle: '国庆专题赛' },
        }),
        create: vi.fn().mockResolvedValue({}),
      },
      appeal: { update: vi.fn().mockResolvedValue({}) },
    }
    const db = {
      appeal: {
        findUnique: vi.fn().mockResolvedValue({
          id: appealId,
          userId: USER_ID,
          ledgerEntryId: entryId,
          status: 'in_review',
          subject: '补发题解加分',
          user: { verifiedRealName: '张三', studentNo: '202600002' },
        }),
      },
      ruleVersion: { findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    }
    const audit = { log: vi.fn().mockResolvedValue(undefined) }
    const notifications = { notify: vi.fn().mockResolvedValue(undefined) }
    const svc = new ScoringService(db, audit, {}, {}, notifications)

    await expect(
      svc.decideAppeal(ACTOR, appealId, 'rejected', '不符合加分条件', { ledgerAction: 'supplement', adjustmentAmount: '2' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    const res = await svc.decideAppeal(ACTOR, appealId, 'resolved', '补录 1.5 分', {
      ledgerAction: 'supplement',
      adjustmentAmount: '1.5',
    })
    expect(res).toMatchObject({
      appealId,
      status: 'resolved',
      ledgerAction: 'supplement',
    })
    expect(res.supplementEntryId).toBeTruthy()
    expect(tx.pointsLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER_ID,
          sourceKey: `appeal:${appealId}`,
          category: 'contest',
          amount: '1.5',
          scoreMonth: '2026-10',
          detail: expect.objectContaining({ appealId, activityTitle: '国庆专题赛' }),
        }),
      }),
    )

    db.appeal.findUnique.mockResolvedValueOnce({
      id: appealId,
      userId: USER_ID,
      status: 'resolved',
      subject: '已结案申诉',
      user: { verifiedRealName: '张三', studentNo: '202600002' },
    })
    await expect(svc.decideAppeal(ACTOR, appealId, 'resolved', '重复操作')).rejects.toMatchObject({
      code: 'STATE_INVALID',
    })
  })

  it('myAppeals 附带关联流水事件名称与替代分值', async () => {
    const entryId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const repId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const now = new Date('2026-11-22T08:00:00.000Z')
    const db = {
      appeal: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'a1',
            ledgerEntryId: entryId,
            subject: '分数偏低请核查',
            materials: '详见榜单截图',
            status: 'resolved',
            resolutionNote: '已更正为 5 分',
            createdAt: now,
            closedAt: now,
          },
        ]),
      },
      pointsLedgerEntry: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: entryId,
              sourceKey: `manual:batch-01:${USER_ID}`,
              category: 'activity',
              amount: '2.00',
              scoreMonth: '2026-11',
              recordedAt: now,
              status: 'reversed',
              detail: { note: '周赛到场加分' },
              reversesEntryId: null,
              replacedByEntryId: repId,
              reversalReason: '申诉采纳处理：已更正为 5 分',
            },
          ])
          .mockResolvedValueOnce([
            { id: repId, amount: '5.00', scoreMonth: '2026-11', recordedAt: now },
          ]),
      },
    }
    const svc = new ScoringService(db, { log: vi.fn() }, {}, {})
    const res = await svc.myAppeals(USER_ID)
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({
      id: 'a1',
      status: 'resolved',
      ledgerEntry: {
        id: entryId,
        eventName: '周赛到场加分',
        amount: '2.00',
        replacementAmount: '5.00',
      },
    })
  })

  it('listAdminLedgerEntries 筛选批量手动加分并解析 batchId 与分页游标', async () => {
    const now = new Date('2026-11-23T09:00:00.000Z')
    const batchId = '12345678-1234-4123-8123-123456789abc'
    const db = {
      pointsLedgerEntry: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'le-1',
            userId: USER_ID,
            user: { id: USER_ID, verifiedRealName: '张三', studentNo: '202600002' },
            sourceKey: `manual:${batchId}:${USER_ID}`,
            category: 'activity',
            amount: '3.50',
            scoreMonth: '2026-11',
            recordedAt: now,
            status: 'approved',
            reversesEntryId: null,
            replacedByEntryId: null,
            reversalReason: null,
            detail: { batchId, note: '周赛志愿服务' },
          },
        ]),
      },
    }
    const svc = new ScoringService(db, { log: vi.fn() }, {}, {})
    const res = await svc.listAdminLedgerEntries({
      scope: 'manual_batch',
      month: '2026-11',
      status: 'approved',
      q: '张三',
    })
    expect(db.pointsLedgerEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: expect.arrayContaining([
            { sourceKey: { startsWith: 'manual:' } },
            { scoreMonth: '2026-11' },
            { status: 'approved' },
          ]),
        },
        take: 51,
      }),
    )
    expect(res.nextCursor).toBeUndefined()
    expect(res.items[0]).toMatchObject({
      id: 'le-1',
      batchId,
      note: '周赛志愿服务',
      eventName: '周赛志愿服务',
      amount: '3.50',
    })
  })
})

describe('ProfilesController.competitionResults', () => {
  it('合并平台同步结果与已结算平台赛流水并按 platform:contestId 去重', async () => {
    const activityId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    const t1 = new Date('2026-11-20T12:00:00.000Z')
    const t2 = new Date('2026-11-22T12:00:00.000Z')
    const db = {
      platformAccount: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'acc-cf', platform: 'codeforces', status: 'verified' },
          { id: 'acc-vj', platform: 'vjudge', status: 'verified' },
        ]),
      },
      platformResult: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'pr-1',
            participationType: 'OFFICIAL',
            score: '1200',
            fullScore: '2000',
            acceptedCount: 4,
            problemCount: 6,
            rank: 300,
            rankTotal: 5000,
            status: 'complete',
            platformAccount: { status: 'verified' },
            platformContest: {
              platform: 'codeforces',
              externalContestId: '2000',
              name: 'Codeforces Round 2000',
              startTime: t1,
            },
          },
        ]),
      },
      pointsLedgerEntry: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'le-dup',
            sourceKey: `contest:codeforces:2000:W:${USER_ID}`,
            amount: '10',
            recordedAt: t1,
            detail: {},
          },
          {
            id: 'le-vj',
            sourceKey: `contest:vjudge:654321:W:${USER_ID}`,
            amount: '8.5',
            recordedAt: t2,
            detail: { activityId, teamName: '三人小队' },
          },
        ]),
      },
      activity: {
        findMany: vi.fn().mockResolvedValue([
          { id: activityId, title: 'VJudge 组队训练赛 #3', startAt: t2, teamSize: 3 },
        ]),
      },
    }
    const profiles = { assertMemberVisible: vi.fn().mockResolvedValue(undefined) }
    const ctrl = new ProfilesController(profiles, db, {}, {})
    const response = await ctrl.competitionResults(ACTOR, USER_ID)
    expect(response.data.items).toHaveLength(2)
    expect(response.data.items[0]).toMatchObject({
      platform: 'vjudge',
      contestId: '654321',
      contestName: 'VJudge 组队训练赛 #3',
      participationType: 'TEAM',
      score: 8.5,
      verifiedBinding: true,
    })
    expect(response.data.items[1]).toMatchObject({
      platform: 'codeforces',
      contestId: '2000',
      contestName: 'Codeforces Round 2000',
    })
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
