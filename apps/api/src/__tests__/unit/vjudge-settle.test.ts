import { describe, expect, it, vi } from 'vitest'
import { ScoringService } from '../../modules/scoring/scoring.service.js'
import { ActivityService } from '../../modules/activities/activity.service.js'
import type { StandingsSnapshot } from '../../modules/activities/contest-standings.service.js'

/**
 * VJudge 个人赛与组队赛结算测试（不依赖真实数据库与外网）：
 * - 验证按正常周赛乙类档（λ=1.0）计算 W；
 * - 验证组队赛按队伍映射榜单与排名（即使仅队长绑定了 VJudge 账号），
 *   同队成员按各自到场 / 远程状态入账，未到场成员跳过。
 */
describe('VJudge 个人赛与组队赛结算', () => {
  const endedAt = new Date(Date.now() - 30 * 60_000)

  const snapshot: StandingsSnapshot = {
    platform: 'vjudge',
    contestId: '654321',
    available: true,
    fetchedAt: new Date().toISOString(),
    note: 'VJudge test',
    totalEntries: 100,
    problems: [
      { index: 'A', name: 'P1', fullScore: null, url: null },
      { index: 'B', name: 'P2', fullScore: null, url: null },
      { index: 'C', name: 'P3', fullScore: null, url: null },
      { index: 'D', name: 'P4', fullScore: null, url: null },
    ],
    entries: [
      {
        handle: 'Team_Alpha',
        displayName: 'Alpha 队',
        rank: 5,
        score: 2,
        solvedCount: 2,
        cells: [
          { index: 'A', score: 1, solved: true, failedCount: 0 },
          { index: 'B', score: 1, solved: true, failedCount: 1 },
          { index: 'C', score: 0, solved: false, failedCount: 0 },
          { index: 'D', score: 0, solved: false, failedCount: 0 },
        ],
      },
      {
        handle: 'team_beta',
        displayName: 'Beta 队',
        rank: 20,
        score: 1,
        solvedCount: 1,
        cells: [
          { index: 'A', score: 1, solved: true, failedCount: 0 },
          { index: 'B', score: 0, solved: false, failedCount: 2 },
          { index: 'C', score: 0, solved: false, failedCount: 0 },
          { index: 'D', score: 0, solved: false, failedCount: 0 },
        ],
      },
      {
        handle: 'team_gamma',
        displayName: 'Gamma 队',
        rank: 50,
        score: 0,
        solvedCount: 0,
        cells: [
          { index: 'A', score: 0, solved: false, failedCount: 3 },
          { index: 'B', score: 0, solved: false, failedCount: 0 },
          { index: 'C', score: 0, solved: false, failedCount: 0 },
          { index: 'D', score: 0, solved: false, failedCount: 0 },
        ],
      },
    ],
  }

  it('组队赛：仅队长绑定 VJudge 账号（大小写不敏感匹配），全队按周赛乙类档入账且各成员独立核验到场/远程', async () => {
    const postedEntries: Array<{ userId: string; sourceKey: string; category: string; amount: string; detail: Record<string, unknown> }> = []
    const db = {
      activity: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'act-team-1',
          title: 'VJudge 周赛 #12（组队）',
          platform: 'vjudge',
          platformContestId: '654321',
          endAt: endedAt,
          teamSize: 3,
          scoringConfig: null,
        }),
      },
      activityRegistration: {
        findMany: vi.fn().mockResolvedValue([
          // Alpha 队：队长 u1 绑定 team_alpha（小写匹配榜单 Team_Alpha）；u2/u3 未绑定 VJudge
          { teamId: 't-alpha', team: { id: 't-alpha', name: 'Alpha', captainUserId: 'u1' }, user: { id: 'u1', studentNo: '001', verifiedRealName: '甲一', profile: null, platformAccounts: [{ externalId: 'team_alpha', displayHandle: 'team_alpha', status: 'verified' }] } },
          { teamId: 't-alpha', team: { id: 't-alpha', name: 'Alpha', captainUserId: 'u1' }, user: { id: 'u2', studentNo: '002', verifiedRealName: '甲二', profile: null, platformAccounts: [] } },
          { teamId: 't-alpha', team: { id: 't-alpha', name: 'Alpha', captainUserId: 'u1' }, user: { id: 'u3', studentNo: '003', verifiedRealName: '甲三', profile: null, platformAccounts: [] } },
          // Beta 队：u4 绑定 team_beta
          { teamId: 't-beta', team: { id: 't-beta', name: 'Beta', captainUserId: 'u4' }, user: { id: 'u4', studentNo: '004', verifiedRealName: '乙一', profile: null, platformAccounts: [{ externalId: 'team_beta', displayHandle: null, status: 'verified' }] } },
          // Gamma 队：u5 绑定 team_gamma（0 题但有 WA 有效提交）
          { teamId: 't-gamma', team: { id: 't-gamma', name: 'Gamma', captainUserId: 'u5' }, user: { id: 'u5', studentNo: '005', verifiedRealName: '丙一', profile: null, platformAccounts: [{ externalId: 'team_gamma', displayHandle: null, status: 'verified' }] } },
        ]),
      },
      designatedContest: { findMany: vi.fn().mockResolvedValue([]) },
      attendanceCheckpoint: { findMany: vi.fn().mockResolvedValue([{ userId: 'u1' }, { userId: 'u4' }, { userId: 'u5' }]) },
      remotePermission: { findMany: vi.fn().mockResolvedValue([{ userId: 'u2' }]) }, // u2 获批远程，u3 缺席
      attendanceAttendanceResult: { findMany: vi.fn().mockResolvedValue([]) },
      ruleVersion: { findFirst: vi.fn().mockResolvedValue(null) },
      pointsLedgerEntry: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async ({ data }) => {
          postedEntries.push({
            userId: data.userId,
            sourceKey: data.sourceKey,
            category: data.category,
            amount: data.amount,
            detail: data.detail,
          })
        }),
      },
    }
    const audit = { log: vi.fn().mockResolvedValue(undefined) }
    const standings = { fetch: vi.fn().mockResolvedValue(snapshot) }
    const activityService = new ActivityService(db as never, audit as never, {} as never, {} as never)
    const scoringService = new ScoringService(db as never, audit as never, activityService, standings as never)

    const result = await scoringService.settleContestScores(null, 'act-team-1')

    expect(result.lambda.key).toBe('B') // 默认周赛乙类 λ=1.0
    expect(result.validCount).toBe(3) // 3 支有效队伍（不按人头重复计数）
    expect(result.posted).toBe(4) // u1(线下) + u2(远程) + u4(线下) + u5(线下)
    expect(result.skipped).toEqual([
      expect.objectContaining({ name: '甲三', reason: expect.stringContaining('无到场记录') }),
    ])

    // Alpha 队第 1 名：S=2/4=0.5, R=1, X=3(5/100≤5%), λ=1.0 → 线下 W = 2 + (2+6) + 3 = 13.00；远程 = 0.5*(8+3) = 5.50
    expect(postedEntries.find((e) => e.userId === 'u1')).toMatchObject({ category: 'contest', amount: '13.00', detail: expect.objectContaining({ teamName: 'Alpha' }) })
    expect(postedEntries.find((e) => e.userId === 'u2')).toMatchObject({ category: 'remote_contest', amount: '5.50', detail: expect.objectContaining({ teamName: 'Alpha' }) })
    // Beta 队第 2 名：S=0.25, R=0.5, X=1(20/100≤30%) → W = 2 + (1+3) + 1 = 7.00
    expect(postedEntries.find((e) => e.userId === 'u4')).toMatchObject({ category: 'contest', amount: '7.00' })
    // Gamma 队第 3 名（有 WA 有效提交）：S=0, R=0, X=0 → W = 2.00
    expect(postedEntries.find((e) => e.userId === 'u5')).toMatchObject({ category: 'contest', amount: '2.00' })
  })

  it('个人赛：按大小写不敏感匹配 VJudge 账号并按周赛乙类档结算', async () => {
    const postedEntries: Array<{ userId: string; amount: string }> = []
    const db = {
      activity: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'act-ind-1',
          title: 'VJudge 周赛 #13',
          platform: 'vjudge',
          platformContestId: '654321',
          endAt: endedAt,
          teamSize: null,
          scoringConfig: null,
        }),
      },
      platformAccount: {
        findMany: vi.fn().mockResolvedValue([
          { externalId: 'team_alpha', displayHandle: 'team_alpha', userId: 'u1', user: { id: 'u1', studentNo: '001', verifiedRealName: '张一', profile: null } },
        ]),
      },
      designatedContest: { findMany: vi.fn().mockResolvedValue([]) },
      attendanceCheckpoint: { findMany: vi.fn().mockResolvedValue([{ userId: 'u1' }]) },
      remotePermission: { findMany: vi.fn().mockResolvedValue([]) },
      attendanceAttendanceResult: { findMany: vi.fn().mockResolvedValue([]) },
      ruleVersion: { findFirst: vi.fn().mockResolvedValue(null) },
      pointsLedgerEntry: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async ({ data }) => {
          postedEntries.push({ userId: data.userId, amount: data.amount })
        }),
      },
    }
    const audit = { log: vi.fn().mockResolvedValue(undefined) }
    const standings = { fetch: vi.fn().mockResolvedValue(snapshot) }
    const activityService = new ActivityService(db as never, audit as never, {} as never, {} as never)
    const scoringService = new ScoringService(db as never, audit as never, activityService, standings as never)

    const result = await scoringService.settleContestScores(null, 'act-ind-1')
    expect(result.posted).toBe(1)
    expect(result.validCount).toBe(1)
    // 仅 1 名有效成员：S=0.5, R=0.5, X=3, λ=1.0 → W = 2 + (2 + 3) + 3 = 10.00
    expect(postedEntries).toEqual([{ userId: 'u1', amount: '10.00' }])
  })
})
