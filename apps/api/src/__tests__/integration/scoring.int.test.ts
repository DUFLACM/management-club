import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { ensureTestDatabase, TEST_URL } from './setup.js'
import { ScoringService, ledgerEntrySchema } from '../../modules/scoring/scoring.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { createTestUser, makeActor } from './helpers.js'

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
  scoring = new ScoringService(db, new AuditService(db))
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

describe('公示与冻结', () => {
  it('公示期 <48 小时被拒绝', async () => {
    const now = new Date()
    await expect(
      scoring.publishMonthlyDisclosure(makeActor(), '2026-09', now, new Date(now.getTime() + 24 * 3600_000)),
    ).rejects.toMatchObject({ code: 'DISCLOSURE_TOO_SHORT' })
  })

  it('冻结后回填积分不改变冻结名单（水位）', async () => {
    const u1 = await createTestUser(db, { studentNo: '202604010' })
    const u2 = await createTestUser(db, { studentNo: '202604011' })
    const reviewer = makeActor()
    await scoring.postLedgerEntry(reviewer, ledgerEntrySchema.parse({ userId: u1.userId, sourceKey: 'fz:a:W', category: 'contest', amount: '30', scoreMonth: '2026-09' }))
    await scoring.postLedgerEntry(reviewer, ledgerEntrySchema.parse({ userId: u2.userId, sourceKey: 'fz:b:W', category: 'contest', amount: '20', scoreMonth: '2026-09' }))
    // 冻结（通过 worker handler 的核心逻辑直接验证水位语义）
    const freezeId = crypto.randomUUID()
    const rule = await db.ruleVersion.findFirst({ orderBy: { version: 'desc' } })
    const watermark = new Date() // 冻结时点：晚于已入账的两笔
    await db.rankingFreeze.create({
      data: { id: freezeId, contestKey: 'test-contest', title: '冻结测试', freezeAt: watermark, ruleVersionId: rule!.id, status: 'scheduled' },
    })
    await expect(scoring.leaderboard('frozen', freezeId, u1.userId)).rejects.toMatchObject({ code: 'FREEZE_PENDING' })
    const { computeEffectiveScore } = await import('@acm/scoring-core')
    const entries = await db.pointsLedgerEntry.findMany({ where: { status: 'approved', recordedAt: { lte: watermark } }, select: { userId: true, amount: true, scoreMonth: true } })
    const byUser = new Map<string, Record<string, number>>()
    for (const e of entries) {
      byUser.set(e.userId, { ...(byUser.get(e.userId) ?? {}), [e.scoreMonth]: (byUser.get(e.userId)?.[e.scoreMonth] ?? 0) + Number(e.amount) })
    }
    const rowsBefore = [...byUser.entries()].map(([userId, ms]) => {
      const eff = computeEffectiveScore({ monthlyScores: ms, currentMonth: '2026-09' }, { effectiveWeights: [1, 0.85, 0.7, 0.55, 0.4, 0.25] })
      return { userId, e: Number(eff.e) }
    }).sort((a, b) => b.e - a.e)
    for (const [i, row] of rowsBefore.entries()) {
      await db.frozenRankingRow.create({ data: { id: crypto.randomUUID(), freezeId, userId: row.userId, position: i + 1, eSnapshot: row.e.toFixed(4) } })
    }
    await db.rankingFreeze.update({ where: { id: freezeId }, data: { status: 'frozen' } })
    const leaderboard = await scoring.leaderboard('frozen', freezeId, u1.userId)
    expect(leaderboard.kind).toBe('frozen')
    // 冻结后回填一笔（recordedAt 晚于水位）
    await scoring.postLedgerEntry(reviewer, ledgerEntrySchema.parse({ userId: u2.userId, sourceKey: 'fz:b2:W', category: 'contest', amount: '50', scoreMonth: '2026-09' }))
    const frozenRows = await db.frozenRankingRow.findMany({ where: { freezeId }, orderBy: { position: 'asc' } })
    expect(frozenRows[0].userId).toBe(u1.userId) // 名单不变
    const u2Row = frozenRows.find((r) => r.userId === u2.userId)!
    expect(Number(u2Row.eSnapshot)).toBeLessThan(50) // 回填不进入冻结快照
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
