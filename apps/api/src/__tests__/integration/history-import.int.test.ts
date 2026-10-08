import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { ensureTestDatabase, TEST_URL } from './setup.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { ActivityService } from '../../modules/activities/activity.service.js'
import type { ContestStandingsService, StandingsSnapshot } from '../../modules/activities/contest-standings.service.js'
import { ScoringService } from '../../modules/scoring/scoring.service.js'
import { HistoryImportService, historyExcelSchema } from '../../modules/scoring/history-import.service.js'
import { createTestUser, makeActor } from './helpers.js'

/**
 * 历史积分导入（真实 PostgreSQL）：
 * - Excel 行按「活动名称 + 日期」建归档存档活动，积分挂到活动；整份重导不重复计分、不重复建活动；
 * - 未注册学号逐行失败，不影响其它行；
 * - 平台比赛行：只抓表格里的比赛、只按表格里的平台账号查成绩，积分留空按 W 公式补全；
 *   与结算引擎共用 sourceKey，重复导入不重复入账。
 */

process.env.DATABASE_URL = TEST_URL

let db: PrismaService
let history: HistoryImportService
let snapshot: StandingsSnapshot

beforeAll(async () => {
  const url = ensureTestDatabase()
  db = new PrismaService(url)
  const audit = new AuditService(db)
  const activities = new ActivityService(db, audit, {} as never, {} as never)
  const standings = { fetch: async () => snapshot } as unknown as ContestStandingsService
  const scoring = new ScoringService(db, audit, activities, standings)
  history = new HistoryImportService(db, audit, scoring, standings)
})

afterAll(async () => {
  await db.$disconnect()
})

describe('Excel 历史积分导入', () => {
  it('按活动名称 + 日期归组建归档活动，重导幂等', async () => {
    const a = await createTestUser(db, { studentNo: '202605001' })
    const b = await createTestUser(db, { studentNo: '202605002' })
    const importer = makeActor()
    const input = historyExcelSchema.parse({
      rows: [
        { row: 2, studentNo: '202605001', amount: '12', category: 'contest', activityTitle: '2025 春季校赛', activityDate: '2025-04-12' },
        { row: 3, studentNo: '202605002', amount: '8.5', category: 'contest', activityTitle: '2025 春季校赛', activityDate: '2025-04-12' },
        { row: 4, studentNo: '202605001', amount: '3', category: 'contribution', activityTitle: '图论专题讲座', activityDate: '2025-05-01', note: '主讲' },
        { row: 5, studentNo: '209999999', amount: '5', category: 'activity', activityTitle: '图论专题讲座', activityDate: '2025-05-01' },
      ],
    })
    const first = await history.importExcel(importer, input)
    expect(first).toMatchObject({ posted: 3, duplicate: 0, failed: 1 })
    expect(first.activities.map((x) => x.created)).toEqual([true, true])
    expect(first.rows.find((r) => r.row === 5)?.error).toContain('学号未注册')

    const contest = await db.activity.findUniqueOrThrow({ where: { id: first.activities[0].id } })
    expect(contest).toMatchObject({ status: 'archived', sourceType: 'history', type: 'custom_contest', title: '2025 春季校赛' })
    // 活动日期按上海时区解释
    expect(contest.startAt.toISOString()).toBe('2025-04-11T16:00:00.000Z')

    const entryA = await db.pointsLedgerEntry.findFirstOrThrow({ where: { userId: a.userId, category: 'contest' } })
    expect(entryA.scoreMonth).toBe('2025-04')
    expect((entryA.detail as { activityId: string }).activityId).toBe(contest.id)
    expect(Number((await db.pointsLedgerEntry.findFirstOrThrow({ where: { userId: b.userId } })).amount)).toBe(8.5)

    const second = await history.importExcel(importer, input)
    expect(second).toMatchObject({ posted: 0, duplicate: 3, failed: 1 })
    expect(second.activities.every((x) => !x.created)).toBe(true)
    expect(await db.activity.count({ where: { sourceType: 'history' } })).toBe(2)
    expect(await db.pointsLedgerEntry.count({ where: { userId: { in: [a.userId, b.userId] } } })).toBe(3)
  })
})

describe('Excel 平台比赛行', () => {
  it('按表格中的平台 / 场次 / 账号抓榜单补全积分、名称、日期；导入建存档且幂等', async () => {
    const top = await createTestUser(db, { studentNo: '202605010', name: '甲同学' })
    const second = await createTestUser(db, { studentNo: '202605011', name: '乙同学' })
    await createTestUser(db, { studentNo: '202605012', name: '丙同学' })
    // 系统里绑定的账号与表格无关：故意绑一个榜上不存在的 handle，证明不按系统绑定匹配
    await db.platformAccount.create({ data: { id: randomUUID(), platform: 'codeforces', externalId: 'not-on-board', userId: top.userId, status: 'verified' } })
    const cell = (solved: boolean) => ({ index: 'A', score: solved ? 1 : 0, solved, failedCount: 0 })
    snapshot = {
      platform: 'codeforces', contestId: '1999', available: true, fetchedAt: new Date().toISOString(), note: null,
      problems: [{ index: 'A', name: null, fullScore: null, url: null }, { index: 'B', name: null, fullScore: null, url: null }],
      entries: [
        { handle: 'Alpha', displayName: null, rank: 5, score: 2, solvedCount: 2, cells: [cell(true), cell(true)] },
        { handle: 'beta', displayName: null, rank: 150, score: 1, solvedCount: 1, cells: [cell(true), cell(false)] },
        { handle: 'gamma', displayName: null, rank: 200, score: 0, solvedCount: 0, cells: [cell(false)] },
        ...Array.from({ length: 197 }, (_, i) => ({ handle: `other${i}`, displayName: null, rank: i + 6, score: 0, solvedCount: 0, cells: [] })),
      ],
      contest: { name: 'Codeforces Round 1999 (Div. 3)', startAt: '2025-06-01T14:35:00.000Z', endAt: '2025-06-01T16:35:00.000Z' },
    }
    const contestRow = (row: number, studentNo: string, handle: string, extra: Record<string, unknown> = {}) =>
      ({ row, studentNo, category: 'contest' as const, platform: 'codeforces' as const, contestId: '1999', handle, ...extra })

    const preview = await history.preview({
      lambdaKey: 'B', cap: 20,
      rows: [
        contestRow(2, '202605010', 'alpha'),
        contestRow(3, '202605011', 'beta', { amount: '6' }),
        contestRow(4, '202605012', 'gamma'),
        contestRow(5, '202605012', 'nobody'),
      ],
    })
    expect(preview.contests).toHaveLength(1)
    expect(preview.contests[0]).toMatchObject({ available: true, name: 'Codeforces Round 1999 (Div. 3)', existingActivity: null })
    const [a, b, c, d] = preview.rows
    // 大小写不敏感匹配；S=1、R=0.5（两人有效名次分减半）、X=3：2 + 7 + 3 = 12
    expect(a).toMatchObject({ amount: '12.00', activityTitle: 'Codeforces Round 1999 (Div. 3)', activityDate: '2025-06-01', memberName: '甲同学' })
    expect(a.computed?.formula).toMatchObject({ S: 1, R: 0.5, X: 3, W: 12 })
    expect(b.amount).toBe('6')
    expect(c.error).toContain('无有效提交')
    expect(d.error).toContain('未找到账号「nobody」')
    expect(preview.validCount).toBe(2)

    const importer = makeActor()
    const commitRows = historyExcelSchema.parse({ rows: preview.rows.filter((row) => !row.error) }).rows
    const first = await history.importExcel(importer, { rows: commitRows })
    expect(first).toMatchObject({ posted: 2, duplicate: 0, failed: 0 })
    expect(first.activities[0].created).toBe(true)
    const activity = await db.activity.findUniqueOrThrow({ where: { id: first.activities[0].id } })
    expect(activity).toMatchObject({ status: 'archived', platform: 'codeforces', platformContestId: '1999', title: 'Codeforces Round 1999 (Div. 3)' })
    expect(activity.startAt.toISOString()).toBe('2025-06-01T14:35:00.000Z')
    const entry = await db.pointsLedgerEntry.findFirstOrThrow({ where: { sourceKey: `contest:codeforces:1999:W:${top.userId}` } })
    expect(Number(entry.amount)).toBe(12)
    expect(entry.scoreMonth).toBe('2025-06')

    const again = await history.importExcel(importer, { rows: commitRows })
    expect(again).toMatchObject({ posted: 0, duplicate: 2 })
    expect(again.activities[0]).toMatchObject({ id: activity.id, created: false })

    const afterPreview = await history.preview({ lambdaKey: 'B', cap: 20, rows: [contestRow(2, '202605010', 'alpha')] })
    expect(afterPreview.contests[0].existingActivity?.id).toBe(activity.id)
  })

  it('榜单不可用时，积分留空的比赛行报错，手填积分的行仍可导入', async () => {
    await createTestUser(db, { studentNo: '202605020' })
    snapshot = { platform: 'atcoder', contestId: 'abc380', available: false, reason: 'AtCoder 榜单接口需要登录态' } as never
    const preview = await history.preview({
      lambdaKey: 'auto', cap: 20,
      rows: [
        { row: 2, studentNo: '202605020', category: 'contest', platform: 'atcoder', contestId: 'abc380', handle: 'someone' },
        { row: 3, studentNo: '202605020', category: 'contest', platform: 'atcoder', contestId: 'abc380', handle: 'someone', amount: '5', activityTitle: 'ABC 380', activityDate: '2024-11-16' },
      ],
    })
    expect(preview.rows[0].error).toContain('榜单抓取失败')
    expect(preview.rows[1].error).toBeUndefined()
  })
})
