import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { ensureTestDatabase, TEST_URL } from './setup.js'
import { ScoringService, ledgerEntrySchema } from '../../modules/scoring/scoring.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { createTestUser, makeActor } from './helpers.js'
import { monthKey } from '../../common/utils.js'

/**
 * 积分账本/公示/冻结/复核（真实 PostgreSQL）：
 * - 同一 source_key 只有一条 approved（重复入账幂等；冲正后可写替代）
 * - 冲正+替代保留历史
 * - 月度批次 R01 阻塞（无正式 M）
 * - 公示 <48h 拒绝；冻结后回填不改名单
 * - 复核：同人两票拒绝；涉本人回避
 */

process.env.DATABASE_URL = TEST_URL

let db: PrismaService
let scoring: ScoringService

beforeAll(async () => {
  const url = ensureTestDatabase()
  db = new PrismaService(url)
  scoring = new ScoringService(db, new AuditService(db), {} as never, {} as never)
  await db.ruleVersion
    .create({
      data: {
        id: crypto.randomUUID(), version: 1, source: 'integration-test',
        params: { monthlyRounding: 'pending', lambdas: [] } as never,
        status: 'published', effectiveFrom: new Date(),
      },
    })
    .catch(() => undefined)
})

afterAll(async () => {
  await db.$disconnect()
})

describe('账本幂等与冲正', () => {
  it('同一 source_key 重复入账返回原记录（deduplicated）', async () => {
    const u = await createTestUser(db, { studentNo: '202604001' })
    const input = ledgerEntrySchema.parse({
      userId: u.userId, sourceKey: `contest:codeforces:2268:W`, category: 'contest',
      amount: '10.5', scoreMonth: '2026-09',
    })
    const r1 = await scoring.postLedgerEntry(makeActor(), input)
    const r2 = await scoring.postLedgerEntry(makeActor(), input)
    expect(r1.deduplicated).toBe(false)
    expect(r2.deduplicated).toBe(true)
    expect(r2.entryId).toBe(r1.entryId)
    const count = await db.pointsLedgerEntry.count({ where: { sourceKey: input.sourceKey } })
    expect(count).toBe(1)
  })

  it('冲正+替代：原记录 reversed，新记录生效，历史保留', async () => {
    const u = await createTestUser(db, { studentNo: '202604002' })
    const reviewer = makeActor()
    const input = ledgerEntrySchema.parse({
      userId: u.userId, sourceKey: 'contest:custom:abc1:W', category: 'contest',
      amount: '10', scoreMonth: '2026-09',
    })
    const { entryId } = await scoring.postLedgerEntry(reviewer, input)
    const reversal = await scoring.reverseEntry(reviewer, entryId, '榜单更正', '8')
    expect(reversal.replacementId).toBeTruthy()
    const original = await db.pointsLedgerEntry.findUnique({ where: { id: entryId } })
    expect(original!.status).toBe('reversed')
    expect(original!.replacedByEntryId).toBe(reversal.replacementId)
    const entries = await db.pointsLedgerEntry.findMany({ where: { userId: u.userId }, orderBy: { recordedAt: 'asc' } })
    expect(entries).toHaveLength(3) // 原始 + 冲正负项 + 替代
    const net = entries.reduce((acc, e) => acc + Number(e.amount), 0)
    expect(net).toBe(8) // 10 - 10 + 8
  })

  it('冲正本人积分被回避拒绝', async () => {
    const u = await createTestUser(db, { studentNo: '202604003' })
    const input = ledgerEntrySchema.parse({
      userId: u.userId, sourceKey: 'activity:act1:participation', category: 'activity',
      amount: '2', scoreMonth: '2026-09',
    })
    const { entryId } = await scoring.postLedgerEntry(makeActor(), input)
    await expect(scoring.reverseEntry(u.actor, entryId, '本人尝试', null)).rejects.toMatchObject({ code: 'RECUSED' })
  })

  it('月度批次：R01 未决时 blocked，不产出正式 M', async () => {
    const u = await createTestUser(db, { studentNo: '202604004' })
    await scoring.postLedgerEntry(makeActor(), ledgerEntrySchema.parse({
      userId: u.userId, sourceKey: 'contest:x1:W', category: 'contest', amount: '10.5', scoreMonth: '2026-09',
    }))
    const batch = await scoring.buildMonthlyBatch(makeActor(), '2026-09')
    expect(batch.blocked).toBe(true)
    expect(batch.blockedReason).toContain('R01')
    const ms = await db.monthlyScore.findFirst({ where: { userId: u.userId, scoreMonth: '2026-09' } })
    expect(ms!.m).toBeNull() // 无正式 M
    expect(Number(ms!.rawTotal)).toBe(10.5) // 原分保留
  })
})

describe('公示', () => {
  it('公示期 <48 小时被拒绝', async () => {
    const now = new Date()
    await expect(
      scoring.publishMonthlyDisclosure(makeActor(), '2026-09', now, new Date(now.getTime() + 24 * 3600_000)),
    ).rejects.toMatchObject({ code: 'DISCLOSURE_TOO_SHORT' })
  })
})

describe('双人复核', () => {
  it('同一主体不能投两票；涉及本人回避；两名不同主体通过', async () => {
    const target = await createTestUser(db, { studentNo: '202604020' })
    const caseRow = await db.reviewCase.create({
      data: { id: crypto.randomUUID(), type: 'points', subjectType: 'ledger', subjectId: crypto.randomUUID(), targetUserId: target.userId, createdBy: crypto.randomUUID() },
    })
    const reviewer1 = makeActor()
    const reviewer2 = makeActor()
    // 本人回避
    await expect(scoring.voteOnCase(target.actor, caseRow.id, 'approve', '本人投票')).rejects.toMatchObject({ code: 'RECUSED' })
    // 第一票
    const v1 = await scoring.voteOnCase(reviewer1, caseRow.id, 'approve', '第一票')
    expect(v1.resolved).toBe(false)
    // 同人第二票拒绝
    await expect(scoring.voteOnCase(reviewer1, caseRow.id, 'approve', '重复投票')).rejects.toMatchObject({ code: 'DOUBLE_VOTE' })
    // 第二名不同主体
    const v2 = await scoring.voteOnCase(reviewer2, caseRow.id, 'approve', '第二票')
    expect(v2.resolved).toBe(true)
    expect(v2.approvals).toBe(2)
    const updated = await db.reviewCase.findUnique({ where: { id: caseRow.id } })
    expect(updated!.status).toBe('resolved')
  })
})

/**
 * 当前有效榜口径（首页「当前有效榜排名」与榜单页共用 rankEligibleMembers）：
 * 全集是在册正式/预备/考察成员，不是「有账本记录的人」——
 * 新入社、尚无任何已生效记录的成员必须在榜上（E=0），否则首页会错误显示「未参与当前榜」。
 */
type CurrentBoardRow = { rank: number; userId: string; e: string; isMe: boolean }

/** leaderboard 的返回是 current/disclosure 联合类型，测试里按 current 形状取行 */
async function currentBoardRows(viewerId: string | null): Promise<CurrentBoardRow[]> {
  const board = await scoring.leaderboard('current', undefined, viewerId)
  return board.rows as CurrentBoardRow[]
}

describe('当前有效榜包含零积分成员', () => {
  it('无账本记录的正式成员仍在榜上且 E 为 0.0', async () => {
    const zero = await createTestUser(db, { studentNo: '202606001', name: '零分成员', membership: 'formal' })
    const scored = await createTestUser(db, { studentNo: '202606002', name: '有分成员', membership: 'formal' })
    await scoring.postLedgerEntry(
      makeActor(),
      ledgerEntrySchema.parse({
        userId: scored.userId,
        sourceKey: 'manual:board-current:202606002',
        category: 'activity',
        amount: '12',
        scoreMonth: monthKey(new Date()),
      }),
    )

    const rows = await currentBoardRows(zero.userId)
    const zeroRow = rows.find((r) => r.userId === zero.userId)
    const scoredRow = rows.find((r) => r.userId === scored.userId)

    expect(zeroRow, '零积分的正式成员必须在当前有效榜上').toBeDefined()
    expect(zeroRow!.e).toBe('0.0')
    expect(zeroRow!.isMe).toBe(true)
    expect(scoredRow).toBeDefined()
    // 有分的排在零分之前
    expect(scoredRow!.rank).toBeLessThan(zeroRow!.rank)
  })

  it('申请中成员即使有账本记录也不在榜上', async () => {
    const applicant = await createTestUser(db, { studentNo: '202606003', name: '申请中', membership: 'applicant' })
    await scoring.postLedgerEntry(
      makeActor(),
      ledgerEntrySchema.parse({
        userId: applicant.userId,
        sourceKey: 'manual:board-current:202606003',
        category: 'activity',
        amount: '50',
        scoreMonth: monthKey(new Date()),
      }),
    )
    const rows = await currentBoardRows(null)
    expect(rows.find((r) => r.userId === applicant.userId)).toBeUndefined()
  })

  it('名次连续且同分名次稳定（两次查询结果一致）', async () => {
    const first = await currentBoardRows(null)
    const second = await currentBoardRows(null)
    expect(first.map((r) => r.rank)).toEqual(first.map((_, i) => i + 1))
    expect(second.map((r) => r.userId)).toEqual(first.map((r) => r.userId))
  })
})
