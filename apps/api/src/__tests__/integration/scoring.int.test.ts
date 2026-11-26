import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { ensureTestDatabase, TEST_URL } from './setup.js'
import { ScoringService, ledgerEntrySchema } from '../../modules/scoring/scoring.service.js'
import { ScoringAdminController } from '../../modules/scoring/scoring.controller.js'
import { CompetitionEventService } from '../../modules/competitions/competition-event.service.js'
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

  it('可冲正本人积分（不再要求回避）', async () => {
    const u = await createTestUser(db, { studentNo: '202604003' })
    const input = ledgerEntrySchema.parse({
      userId: u.userId, sourceKey: 'activity:act1:participation', category: 'activity',
      amount: '2', scoreMonth: '2026-09',
    })
    const { entryId } = await scoring.postLedgerEntry(makeActor(), input)
    const result = await scoring.reverseEntry(u.actor, entryId, '本人更正', null)
    expect(result.reversalId).toBeTruthy()
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

describe('学期共享加分明细', () => {
  it('按积分归属月、可见性与生效状态过滤，同一秒多笔记录跨页完整', async () => {
    const semester = await db.semester.create({ data: {
      id: crypto.randomUUID(), code: 'BONUS', name: '公示测试',
      startsOn: new Date('2021-08-31T16:00:00Z'), endsOn: new Date('2021-10-31T15:59:59Z'),
    } })
    const viewer = await createTestUser(db, { studentNo: '202606071', membership: 'observing' })
    const owner = await createTestUser(db, { studentNo: '202606072', name: '加分成员' })
    const reviewer = makeActor()
    const record = (amount: string, scoreMonth = '2021-09', category = 'service', status = 'approved') => ({
      id: crypto.randomUUID(), userId: owner.userId, sourceKey: crypto.randomUUID(), category, amount, scoreMonth, status,
      recordedAt: new Date('2022-01-01T00:00:00Z'), detail: { note: '审核备注仅本人可见' },
    })
    const visible = Array.from({ length: 27 }, (_, i) => record('3.75', i === 0 ? '2021-10' : '2021-09'))
    const others = [
      record('0'), record('-2'), record('2', '2021-09', 'reversal'), record('3', '2021-09', 'service', 'reversed'),
      record('1', '2021-08'), record('1', '2021-11'),
    ]
    await db.pointsLedgerEntry.createMany({ data: [...visible, ...others] })
    const first = await scoring.memberBonusRecords(viewer.userId, semester.id)
    expect(first.items).toHaveLength(25)
    expect(first.items[0]).toEqual({
      id: expect.any(String), displayName: '加分成员', amount: '3.75', scoreMonth: expect.any(String),
      recordedAt: '2022-01-01T00:00:00.000Z', category: 'service', eventName: expect.stringMatching(/^服务积分/),
    })
    expect(first.nextCursor).toBe(first.items[24]!.id)
    const second = await scoring.memberBonusRecords(viewer.userId, semester.id, first.nextCursor)
    expect(second.nextCursor).toBeUndefined()
    expect([...first.items, ...second.items].map((r) => r.id).sort()).toEqual(visible.map((r) => r.id).sort())

    const id = first.nextCursor!
    await scoring.setBonusVisibility(reviewer, id, false)
    await scoring.setBonusVisibility(reviewer, id, false)
    expect((await scoring.memberBonusRecords(viewer.userId, semester.id)).items.some((r) => r.id === id)).toBe(false)
    expect((await scoring.memberBonusRecords(viewer.userId, semester.id, id)).items).toEqual(second.items)
    const admin = await scoring.listAdminLedgerEntries({ scope: 'all', q: '202606072' })
    expect(admin.items.find((r) => r.id === id)).toMatchObject({ bonusVisible: false, status: 'approved', amount: '3.75' })
    expect((await db.pointsLedgerEntry.findUniqueOrThrow({ where: { id } })).userId).toBe(owner.userId)
    await scoring.setBonusVisibility(reviewer, id, true)
    expect((await scoring.memberBonusRecords(viewer.userId, semester.id)).items).toEqual(first.items)
    expect(await db.auditLog.count({ where: { resourceId: id, action: 'points.bonus_visibility' } })).toBe(2)
    await expect(scoring.setBonusVisibility(reviewer, others[0]!.id, false)).rejects.toMatchObject({ code: 'STATE_INVALID' })

    await scoring.setBonusVisibility(reviewer, id, false)
    const { replacementId } = await scoring.reverseEntry(reviewer, id, '修正分值', '4')
    expect(await db.pointsLedgerEntry.findUniqueOrThrow({ where: { id: replacementId! } })).toMatchObject({ bonusVisible: false })
    expect((await scoring.myLedger(owner.userId, { month: first.items[24]!.scoreMonth })).items.some((r) => r.id === replacementId)).toBe(true)
  })

  it('要求在册成员，拒绝未来学期，只返回已经开始的归属月', async () => {
    const viewer = await createTestUser(db, { studentNo: '202606073', membership: 'provisional' })
    await expect(scoring.memberBonusRecords(viewer.userId, crypto.randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const future = await db.semester.create({ data: {
      id: crypto.randomUUID(), code: 'BONUS-FUTURE', name: '未来学期',
      startsOn: new Date('2100-01-01'), endsOn: new Date('2100-06-30'),
    } })
    await expect(scoring.memberBonusRecords(viewer.userId, future.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const semester = await db.semester.create({ data: {
      id: crypto.randomUUID(), code: 'BONUS-ONGOING', name: '当前学期', startsOn: new Date(), endsOn: new Date('2100-06-30'),
    } })
    const reviewer = makeActor()
    const { entryId } = await scoring.postLedgerEntry(reviewer, {
      userId: viewer.userId, sourceKey: 'manual:future-bonus', category: 'activity', amount: '5', scoreMonth: '2100-05',
    })
    expect((await scoring.memberBonusRecords(viewer.userId, semester.id)).items.map((r) => r.id)).not.toContain(entryId)
    const applicant = await createTestUser(db, { studentNo: '202606074', membership: 'applicant' })
    await expect(scoring.memberBonusRecords(applicant.userId, semester.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const adminController = new ScoringAdminController(scoring, db, {} as never, {} as never)
    await expect(adminController.setBonusVisibility(reviewer, entryId, { visible: 'false' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('单笔及批量入账可直接隐藏，幂等重试与撤回重记都保留隐藏状态', async () => {
    const owner = await createTestUser(db, { studentNo: '202606075' })
    await createTestUser(db, { studentNo: '202606076' })
    const reviewer = makeActor()
    const controller = new ScoringAdminController(scoring, db, {} as never, {} as never)
    const input = { userId: owner.userId, sourceKey: 'manual:hidden-at-post', category: 'activity', amount: '2.5', scoreMonth: '2021-09' }
    const { data: { entryId } } = await controller.postEntry(reviewer, { ...input, bonusVisible: false })
    expect(await db.pointsLedgerEntry.findUniqueOrThrow({ where: { id: entryId } })).toMatchObject({ bonusVisible: false })
    expect((await db.auditLog.findFirstOrThrow({ where: { resourceId: entryId, action: 'points.post' } })).summary).toContain('不公示')
    expect((await controller.postEntry(reviewer, { ...input, bonusVisible: true })).data).toEqual({ entryId, deduplicated: true })
    await scoring.reverseEntry(reviewer, entryId, '重新核定积分', null)
    const repost = await controller.postEntry(reviewer, { ...input, idempotencyKey: 'manual:post-again' })
    expect(await db.pointsLedgerEntry.findUniqueOrThrow({ where: { id: repost.data.entryId } })).toMatchObject({ bonusVisible: false })

    const batch = await controller.postEntriesBatch(reviewer, { scoreMonth: '2021-09', bonusVisible: false, rows: [
      { studentNo: '202606075', amount: '4' }, { studentNo: '202606076', amount: '-1' },
    ] })
    expect(batch.data.posted).toBe(2)
    const rows = await db.pointsLedgerEntry.findMany({
      where: { sourceKey: { startsWith: `manual:${batch.data.batchId}:` } }, orderBy: { amount: 'desc' },
    })
    expect(rows.map((r) => r.bonusVisible)).toEqual([false, true])
    await expect(controller.postEntry(reviewer, { ...input, bonusVisible: 'no' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('复核案件', () => {
  it('单人裁决即结案（含涉及本人），more_info 不结案', async () => {
    const target = await createTestUser(db, { studentNo: '202604020' })
    const caseRow = await db.reviewCase.create({
      data: { id: crypto.randomUUID(), type: 'points', subjectType: 'ledger', subjectId: crypto.randomUUID(), targetUserId: target.userId, createdBy: crypto.randomUUID() },
    })
    const info = await scoring.voteOnCase(makeActor(), caseRow.id, 'more_info', '请补充材料')
    expect(info.resolved).toBe(false)
    const decided = await scoring.voteOnCase(target.actor, caseRow.id, 'approve', '本人直接裁决')
    expect(decided).toEqual({ resolved: true, approvals: 1 })
    const updated = await db.reviewCase.findUnique({ where: { id: caseRow.id } })
    expect(updated!.status).toBe('resolved')

    const rejectCase = await db.reviewCase.create({
      data: { id: crypto.randomUUID(), type: 'points', subjectType: 'ledger', subjectId: crypto.randomUUID(), targetUserId: target.userId, createdBy: crypto.randomUUID() },
    })
    await scoring.voteOnCase(makeActor(), rejectCase.id, 'reject', '证据不足')
    expect((await db.reviewCase.findUnique({ where: { id: rejectCase.id } }))!.status).toBe('rejected')
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

describe('贡献申报审核撤回', () => {
  it('通过入账后可撤回：冲正流水并退回待审核，重新通过生成新的生效记录', async () => {
    const u = await createTestUser(db, { studentNo: '202604030', name: '撤回测试' })
    const reviewer = makeActor()
    const { claimId } = await scoring.submitClaim(u.userId, {
      category: 'contribution_lecture',
      title: '撤回测试申报',
      description: '用于验证撤回审核与冲正流程',
    })
    const approved = await scoring.decideClaim(reviewer, claimId, 'approve', '材料齐全', '3')
    expect(approved.decided).toBe(true)
    expect((await db.pointsClaim.findUniqueOrThrow({ where: { id: claimId } })).status).toBe('approved')

    const before = await db.pointsLedgerEntry.findMany({ where: { userId: u.userId }, orderBy: { recordedAt: 'asc' } })
    expect(before).toHaveLength(1)
    expect(Number(before[0]!.amount)).toBe(3)
    const originalId = before[0]!.id

    const withdrawn = await scoring.withdrawClaimDecision(reviewer, claimId, '分值填错')
    expect(withdrawn).toEqual({ withdrawn: true, reversedEntryId: originalId })
    const claim = await db.pointsClaim.findUniqueOrThrow({ where: { id: claimId } })
    expect(claim).toMatchObject({ status: 'pending', reviewedBy: null, reviewedAt: null, reviewNote: null })

    const afterWithdraw = await db.pointsLedgerEntry.findMany({ where: { userId: u.userId }, orderBy: { recordedAt: 'asc' } })
    expect(afterWithdraw).toHaveLength(2)
    expect(afterWithdraw.find((entry) => entry.id === originalId)?.status).toBe('reversed')
    expect(afterWithdraw.filter((entry) => entry.status === 'approved')).toHaveLength(1)
    expect(afterWithdraw.reduce((sum, entry) => sum + Number(entry.amount), 0)).toBe(0)

    // 撤回后可以重新审核；新审批生成新的入账记录，旧记录保持 reversed
    const reapproved = await scoring.decideClaim(reviewer, claimId, 'approve', '重新核定分值', '2')
    expect(reapproved.decided).toBe(true)
    const afterReapprove = await db.pointsLedgerEntry.findMany({ where: { userId: u.userId, status: 'approved', category: { not: 'reversal' } } })
    expect(afterReapprove).toHaveLength(1)
    expect(Number(afterReapprove[0]!.amount)).toBe(2)
    expect((await scoring.decideClaim(reviewer, claimId, 'approve', '重复点击', '2')).decided).toBe(false)
  })

  it('驳回的申报可撤回并回到待审核；未入账时只回退状态', async () => {
    const u = await createTestUser(db, { studentNo: '202604031' })
    const reviewer = makeActor()
    const { claimId } = await scoring.submitClaim(u.userId, {
      category: 'solution',
      title: '驳回撤回测试',
      description: '用于验证驳回后撤回',
    })
    expect((await scoring.decideClaim(reviewer, claimId, 'reject', '证据不足', undefined)).decided).toBe(true)
    const rejectedWithdraw = await scoring.withdrawClaimDecision(reviewer, claimId, '重新核对材料')
    expect(rejectedWithdraw.reversedEntryId).toBeNull()
    expect((await db.pointsClaim.findUniqueOrThrow({ where: { id: claimId } })).status).toBe('pending')

    expect((await scoring.decideClaim(reviewer, claimId, 'approve', '补充后通过', '2')).decided).toBe(true)
    const active = await db.pointsLedgerEntry.findMany({ where: { userId: u.userId, status: 'approved' } })
    expect(active).toHaveLength(1)
    const withdrawn = await scoring.withdrawClaimDecision(reviewer, claimId, '撤回复核')
    expect(withdrawn.reversedEntryId).toBe(active[0]!.id)
    expect((await db.pointsClaim.findUniqueOrThrow({ where: { id: claimId } })).status).toBe('pending')
  })
})

describe('批量加分：学号 / 姓名二选一', () => {
  it('姓名唯一可入账；同名多人在核对接口返回候选，入账时拒绝猜测', async () => {
    const unique = await createTestUser(db, { studentNo: '202604040', name: '批量独名' })
    const dupA = await createTestUser(db, { studentNo: '202604041', name: '批量同名' })
    const dupB = await createTestUser(db, { studentNo: '202604042', name: '批量同名' })
    const resolved = await scoring.resolveMemberQueries(['202604040', '批量独名', '批量同名', '查无此人'])
    const byQuery = new Map(resolved.map((row) => [row.query, row]))
    expect(byQuery.get('202604040')).toMatchObject({ match: { userId: unique.userId } })
    expect(byQuery.get('批量独名')).toMatchObject({ match: { studentNo: '202604040' } })
    expect(byQuery.get('批量同名')?.match).toBeNull()
    expect(byQuery.get('批量同名')?.candidates.map((candidate) => candidate.studentNo).sort()).toEqual(['202604041', '202604042'])
    expect(byQuery.get('查无此人')?.error).toContain('未找到')

    const batch = await scoring.batchPostEntries(makeActor(), {
      rows: [
        { name: '批量独名', amount: '2', note: '姓名匹配' },
        { studentNo: '202604041', amount: '3', note: '学号匹配' },
        { name: '批量同名', amount: '1' },
      ],
      category: 'activity',
      scoreMonth: '2026-09',
    })
    expect(batch).toMatchObject({ posted: 2 })
    expect(batch.failed).toHaveLength(1)
    expect(batch.failed[0]?.error).toContain('对应 2 位成员')
    expect(await db.pointsLedgerEntry.count({ where: { userId: unique.userId, status: 'approved' } })).toBe(1)
    expect(await db.pointsLedgerEntry.count({ where: { userId: dupB.userId, status: 'approved' } })).toBe(0)

    // 管理员在核对表选定后，带明确学号入账
    const chosen = await scoring.batchPostEntries(makeActor(), {
      rows: [{ studentNo: '202604042', amount: '1' }],
      category: 'activity',
      scoreMonth: '2026-09',
    })
    expect(chosen).toMatchObject({ posted: 1 })
    expect(chosen.failed).toHaveLength(0)
    expect(await db.pointsLedgerEntry.count({ where: { userId: dupB.userId, status: 'approved' } })).toBe(1)
    expect(await db.pointsLedgerEntry.count({ where: { userId: dupA.userId, status: 'approved' } })).toBe(1)
  })
})

describe('正式赛人工审核补发获奖分', () => {
  const reviewer = makeActor()
  async function createEvent(contestTier: 'provincial' | 'lanqiao', teamSize?: number) {
    const events = new CompetitionEventService(db, new AuditService(db), scoring, {} as never)
    const { eventId } = await events.createEvent(reviewer, {
      title: '历史正式赛审核测试', category: 'B', contestTier, scoringMode: 'manual_review', teamSize,
      announcement: '测试人工复核及补分', registerDeadline: '2026-04-01T00:00:00Z',
      startAt: '2026-04-10T00:00:00Z', endAt: '2026-04-10T04:00:00Z',
    })
    return { eventId, events }
  }

  it('个人先记参赛分，跨月审核和重复审核只在原月份补一次奖项差额', async () => {
    const { eventId, events } = await createEvent('provincial')
    const { userId } = await createTestUser(db, { studentNo: '202604060' })
    const { id } = await db.competitionRegistration.create({ data: { id: crypto.randomUUID(), eventId, userId } })
    await events.reviewRegistration(reviewer, id, 'approve', {})
    await db.pointsLedgerEntry.updateMany({ where: { userId }, data: { scoreMonth: '2026-04' } })
    const silver = { award: { medal: 'silver' } }
    await Promise.all([events.reviewRegistration(reviewer, id, 'approve', silver), events.reviewRegistration(reviewer, id, 'approve', silver)])
    const rows = await db.pointsLedgerEntry.findMany({ where: { userId }, orderBy: { recordedAt: 'asc' } })
    expect(rows.map((r) => [Number(r.amount), r.scoreMonth])).toEqual([[20, '2026-04'], [50, '2026-04']])
    await expect(events.reviewRegistration(reviewer, id, 'approve', { award: { medal: 'bronze' } })).rejects.toThrow('低于')
    const result = await db.competitionRegistration.findUniqueOrThrow({ where: { id } })
    expect(Number(result.resultScore)).toBe(70)
    expect(result.resultDetail).toMatchObject({ medal: 'silver' })
  })

  it('首次核定零分保留一条流水，重审和后续获奖不重复登记', async () => {
    const { eventId, events } = await createEvent('lanqiao')
    const { userId } = await createTestUser(db, { studentNo: '202604061' })
    const { id } = await db.competitionRegistration.create({ data: { id: crypto.randomUUID(), eventId, userId } })
    await events.reviewRegistration(reviewer, id, 'approve', {})
    await events.reviewRegistration(reviewer, id, 'approve', {})
    await events.reviewRegistration(reviewer, id, 'approve', { award: { group: 'B', awards: ['prov3'] } })
    const rows = await db.pointsLedgerEntry.findMany({ where: { userId }, orderBy: { recordedAt: 'asc' } })
    expect(rows.map((r) => Number(r.amount))).toEqual([0, 12])
  })

  it('老队伍按原参赛名单补分，拒绝已有人工更正的整队重审', async () => {
    const { eventId, events } = await createEvent('provincial', 2)
    const captain = await createTestUser(db, { studentNo: '202604062' })
    const former = await createTestUser(db, { studentNo: '202604063' })
    const newcomer = await createTestUser(db, { studentNo: '202604064' })
    const { id: teamId } = await db.team.create({ data: {
      id: crypto.randomUUID(), name: '原参赛队', teamSize: 2, captainUserId: captain.userId, createdBy: reviewer.principalId,
      members: { create: [captain, former].map((m) => ({ id: crypto.randomUUID(), role: m === captain ? 'captain' : 'member', userId: m.userId })) },
    } })
    const { id } = await db.teamCompetitionEntry.create({ data: { id: crypto.randomUUID(), eventId, teamId } })
    await events.reviewTeamEntry(reviewer, id, 'approve', {})
    // 旧版人工审核只保存队伍成绩，无法直接从成绩明细取原参赛队员。
    await db.teamCompetitionEntry.update({ where: { id }, data: { resultDetail: { tier: 'provincial' } } })
    await db.teamMember.update({ where: { teamId_userId: { teamId, userId: former.userId } }, data: { status: 'left', leftAt: new Date() } })
    await db.teamMember.create({ data: { id: crypto.randomUUID(), teamId, userId: newcomer.userId, role: 'member' } })
    const silver = { award: { medal: 'silver' } }
    await events.reviewTeamEntry(reviewer, id, 'approve', silver)
    await events.reviewTeamEntry(reviewer, id, 'approve', silver)
    for (const userId of [captain.userId, former.userId]) {
      const rows = await db.pointsLedgerEntry.findMany({ where: { userId }, orderBy: { recordedAt: 'asc' } })
      expect(rows.map((r) => Number(r.amount))).toEqual([20, 50])
    }
    expect(await db.pointsLedgerEntry.count({ where: { userId: newcomer.userId } })).toBe(0)

    const snapshot = await db.teamCompetitionEntry.findUniqueOrThrow({ where: { id } })
    const detail = snapshot.resultDetail as { memberResults: { userId: string; points: string }[] }
    await db.teamCompetitionEntry.update({ where: { id }, data: {
      resultDetail: { ...detail, memberResults: [...detail.memberResults, { userId: newcomer.userId, awardText: '打星', points: '0' }] },
    } })
    await events.reviewTeamEntry(reviewer, id, 'approve', silver)
    expect(await db.pointsLedgerEntry.count({ where: { userId: newcomer.userId } })).toBe(0)
    const myEvents = await events.myCompetitions(newcomer.userId)
    expect(myEvents.find((r) => r.eventId === eventId)).toMatchObject({ awardText: '打星', resultScore: '0.00' })
    expect(await events.exportRosterCsv(eventId)).toMatch(/202604064,[^\n]*,0\.00/)

    const original = await db.pointsLedgerEntry.findFirstOrThrow({ where: { sourceKey: `team-competition:${eventId}:${teamId}:${former.userId}` } })
    await scoring.reverseEntry(reviewer, original.id, '人工核对原比赛积分', null)
    await expect(events.reviewTeamEntry(reviewer, id, 'approve', { award: { medal: 'gold' } })).rejects.toThrow('人工更正')
    expect(await db.pointsLedgerEntry.count({ where: { userId: captain.userId } })).toBe(2)
    const retained = await db.teamCompetitionEntry.findUniqueOrThrow({ where: { id } })
    expect(Number(retained.resultScore)).toBe(70)
  })
})
