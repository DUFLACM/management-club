import { Inject, Injectable } from '@nestjs/common'
import { DomainError } from '../../common/domain-error.js'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { newId, monthKey, monthKeyPlus } from '../../common/utils.js'
import { loadEnv, isEvaluationTestModeEnabled } from '../../config/env.js'
import type { SessionActor } from '../auth/session.service.js'

/**
 * 综合素质评价建议折算（附录三）。
 *
 * 附录三只规定了结构，不规定分量的具体折算方式（§五「按…折算」、§九.2「具体折算口径可按学期微调」），
 * 因此本服务取下列可追溯口径，并把每个分量都做成可在管理页覆盖的字段（§九.3 公示期申诉复核）：
 * - 积分标准分：学期各月有效积分（MonthlyScore）平均值，在符合评价条件成员中的百分位 0–100（§五(一) 原文口径）
 * - 竞赛标准分：学期内 contest|remote_contest|award 账目合计的百分位 0–100
 * - 服务标准分：学期内 contribution|service 账目合计的百分位 0–100
 * - 纪律扣减：学期内 penalty 账目金额绝对值合计，1:1 扣减 H，上限 DISCIPLINE_CAP
 *
 * 输出只是社团内部排序与建议值，不等同学院最终结果（§一、§九.1）。
 */
export class EvaluationError extends DomainError {
  constructor(message: string, readonly code: string) {
    super(message, code)
  }
}

/** H 的三项权重（附录三·三公式） */
const WEIGHTS = { points: 0.7, contest: 0.2, service: 0.1 } as const
/** A/B/C 定档比例（附录三·四 1:2:7） */
const TIER_RATIOS = { a: 0.1, b: 0.2 } as const
/** 纪律扣减上限：避免单笔错误扣分把 H 推到不可比的负值 */
const DISCIPLINE_CAP = 20
/** 计入竞赛标准分的账目类别（附录三·五(二) 正式竞赛获奖/排名/代表学校参赛） */
const CONTEST_CATEGORIES = ['contest', 'remote_contest', 'award'] as const
/** 计入服务标准分的账目类别（附录三·五(三) 讲题/出题/题解/宣讲/工作人员/平台维护） */
const SERVICE_CATEGORIES = ['contribution', 'service'] as const
/** 纳入定档的在册状态；其余状态按附录三·六逐条给出排除理由 */
const TIERABLE_STATUSES = ['formal', 'provisional'] as const

type Weights = typeof WEIGHTS
type TierRatios = typeof TIER_RATIOS

interface Tiebreak {
  /** 近三个月有效积分（§七(一)） */
  recentPoints: number
  /** 近三个月正式竞赛积分（§七(二)） */
  recentContest: number
  /** 近三个月社团周赛月赛等活动积分（§七(三)） */
  recentActivity: number
  /** 四项仍相同：须主席团会同指导教师集体认定（§七(四)） */
  needsManual: boolean
}

interface Candidate {
  userId: string
  studentNo: string
  realName: string
  pointsAvg: number
  contestRaw: number
  serviceRaw: number
  penaltyRaw: number
  excluded: boolean
  excludeReason: string | null
  cadre: boolean
  tiebreak: Tiebreak
}

/** 学期覆盖的月份键（Asia/Shanghai），含首尾月 */
function semesterMonths(startsOn: Date, endsOn: Date): string[] {
  const first = monthKey(startsOn)
  const last = monthKey(endsOn)
  const months: string[] = [first]
  // 防御上限 24 个月，避免脏数据导致死循环
  while (months[months.length - 1] !== last && months.length < 24) {
    months.push(monthKeyPlus(months[months.length - 1]!, 1))
  }
  return months
}

/**
 * 百分位（0–100）：严格低于本人的人数 ÷ (总人数 − 1)。
 * 最低分得 0、最高分得 100，并列同分。
 */
export function percentile(value: number, sortedAsc: number[]): number {
  const n = sortedAsc.length
  if (n <= 1) return n === 1 ? 100 : 0
  let lower = 0
  for (const v of sortedAsc) {
    if (v < value) lower += 1
    else break
  }
  return (lower / (n - 1)) * 100
}

function round(value: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

/** 附录三·四：A=max(1,round(0.1N))，B=round(0.2N)，C=余量 */
export function tierCounts(n: number, ratios: TierRatios): { a: number; b: number; c: number } {
  if (n <= 0) return { a: 0, b: 0, c: 0 }
  const a = Math.min(n, Math.max(1, Math.round(ratios.a * n)))
  const b = Math.min(n - a, Math.round(ratios.b * n))
  return { a, b, c: n - a - b }
}

/** 附录三·五：A 档 1.0；B 档 1.0→0.5 等差；C 档 0.5→0 等差（j 为档内名次，从 1 起） */
export function tierScore(tier: 'A' | 'B' | 'C', j: number, counts: { b: number; c: number }): number {
  if (tier === 'A') return 1
  if (tier === 'B') return round(1 - 0.5 * ((j - 1) / Math.max(1, counts.b - 1)), 3)
  return round(0.5 * (1 - (j - 1) / Math.max(1, counts.c - 1)), 3)
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

@Injectable()
export class EvaluationService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** 学期列表 + 各自是否已达可折算时点（供管理页显示开启状态与测试口提示） */
  async semesters() {
    const rows = await this.db.semester.findMany({ orderBy: { startsOn: 'desc' }, take: 24 })
    const testMode = isEvaluationTestModeEnabled(loadEnv())
    const now = Date.now()
    return {
      testMode,
      semesters: rows.map((s) => {
        const ended = s.endsOn.getTime() <= now
        return {
          id: s.id,
          code: s.code,
          name: s.name,
          startsOn: s.startsOn,
          endsOn: s.endsOn,
          ended,
          // 学期未结束时只有测试口能生成，且产物固定标记为测试数据
          canGenerate: ended || testMode,
        }
      }),
    }
  }

  async batches() {
    const rows = await this.db.evaluationBatch.findMany({
      orderBy: { generatedAt: 'desc' },
      take: 30,
      include: { semester: { select: { code: true, name: true } }, _count: { select: { rows: true } } },
    })
    return rows.map((b) => ({
      id: b.id,
      semesterId: b.semesterId,
      semesterCode: b.semester.code,
      semesterName: b.semester.name,
      status: b.status,
      isTest: b.isTest,
      memberCount: b.memberCount,
      rowCount: b._count.rows,
      note: b.note,
      generatedAt: b.generatedAt,
      publishedAt: b.publishedAt,
    }))
  }

  /** 生成学期批次：先算分量与排除，再定档 */
  async generate(actor: SessionActor, semesterId: string) {
    const semester = await this.db.semester.findUnique({ where: { id: semesterId } })
    if (!semester) throw new EvaluationError('学期不存在', 'NOT_FOUND')

    const ended = semester.endsOn.getTime() <= Date.now()
    const testMode = isEvaluationTestModeEnabled(loadEnv())
    if (!ended && !testMode) {
      throw new EvaluationError('该学期尚未结束，综评折算未开启（本地测试请设置 EVALUATION_TEST_MODE=true）', 'SEMESTER_NOT_ENDED')
    }
    // 只要学期未结束就是测试数据，开关开着也不会把未结束学期的结果洗成正式批次
    const isTest = !ended

    const { candidates, diagnostics } = await this.collect(semester)

    const batchId = newId()
    const rows = this.assign(candidates)
    await this.db.$transaction(async (tx) => {
      await tx.evaluationBatch.create({
        data: {
          id: batchId,
          semesterId,
          status: 'draft',
          isTest,
          weights: WEIGHTS,
          tierRatios: TIER_RATIOS,
          memberCount: rows.filter((r) => r.tier !== null).length,
          note: diagnostics,
          generatedBy: actor.principalId,
        },
      })
      if (rows.length > 0) {
        await tx.evaluationRow.createMany({
          data: rows.map((r) => ({
            id: newId(),
            batchId,
            userId: r.userId,
            studentNo: r.studentNo,
            realName: r.realName,
            pointsAvg: r.pointsAvg.toFixed(10),
            pointsStd: r.pointsStd.toFixed(4),
            contestStd: r.contestStd.toFixed(4),
            serviceStd: r.serviceStd.toFixed(4),
            disciplinePenalty: r.disciplinePenalty.toFixed(4),
            hScore: r.hScore.toFixed(4),
            rankNo: r.rankNo,
            tier: r.tier,
            suggestedScore: r.suggestedScore.toFixed(3),
            excluded: r.excluded,
            excludeReason: r.excludeReason,
            cadre: r.cadre,
            tiebreak: jsonTiebreak(r.tiebreak),
          })),
        })
      }
    })

    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'evaluation.batch.generate',
      resourceType: 'evaluation_batch',
      resourceId: batchId,
      summary: `${semester.code} 综评批次：${rows.length} 人，定档 ${rows.filter((r) => r.tier !== null).length} 人${isTest ? '（测试数据）' : ''}`,
    })
    return { batchId, isTest, rowCount: rows.length }
  }

  /** 读取学期内的候选人与各分量原始值 */
  private async collect(semester: { id: string; startsOn: Date; endsOn: Date }) {
    const months = semesterMonths(semester.startsOn, semester.endsOn)
    const recentMonths = months.slice(-3)

    const terms = await this.db.membershipTerm.findMany({
      where: { semesterId: semester.id },
      include: { user: { select: { id: true, studentNo: true, verifiedRealName: true, principalId: true, accountStatus: true } } },
    })
    if (terms.length === 0) return { candidates: [] as Candidate[], diagnostics: '该学期没有在册成员记录' }

    const userIds = terms.map((t) => t.userId)
    const principalIds = terms.map((t) => t.user.principalId)

    const [monthly, ledger, recentLedger, restrictions, grants, publishedMonths] = await Promise.all([
      this.db.monthlyScore.findMany({
        where: { userId: { in: userIds }, scoreMonth: { in: months }, status: 'published' },
        orderBy: { revision: 'asc' },
        select: { userId: true, scoreMonth: true, m: true, rawTotal: true, revision: true },
      }),
      this.db.pointsLedgerEntry.groupBy({
        by: ['userId', 'category'],
        where: { userId: { in: userIds }, scoreMonth: { in: months }, status: 'approved' },
        _sum: { amount: true },
      }),
      this.db.pointsLedgerEntry.groupBy({
        by: ['userId', 'category'],
        where: { userId: { in: userIds }, scoreMonth: { in: recentMonths }, status: 'approved' },
        _sum: { amount: true },
      }),
      this.db.restriction.findMany({
        where: {
          userId: { in: userIds },
          type: 'discipline_hold',
          revokedAt: null,
          startsAt: { lte: semester.endsOn },
          OR: [{ endsAt: null }, { endsAt: { gte: semester.startsOn } }],
        },
        select: { userId: true, reason: true },
      }),
      this.db.roleGrant.findMany({
        where: {
          principalId: { in: principalIds },
          role: 'presidium',
          revokedAt: null,
          OR: [{ validUntil: null }, { validUntil: { gte: semester.startsOn } }],
        },
        select: { principalId: true },
      }),
      this.db.monthlyScore.findMany({
        where: { scoreMonth: { in: months }, status: 'published' },
        distinct: ['scoreMonth'],
        select: { scoreMonth: true },
      }),
    ])

    // 同一 (user, month) 取最大 revision；有效积分优先用 m，未定取整策略时退回 rawTotal
    const monthlyByUser = new Map<string, Map<string, number>>()
    for (const row of monthly) {
      const byMonth = monthlyByUser.get(row.userId) ?? new Map<string, number>()
      byMonth.set(row.scoreMonth, row.m ?? Number(row.rawTotal))
      monthlyByUser.set(row.userId, byMonth)
    }

    const sumBy = (rows: typeof ledger, userId: string, categories: readonly string[]) =>
      rows
        .filter((r) => r.userId === userId && categories.includes(r.category))
        .reduce((acc, r) => acc + Number(r._sum.amount ?? 0), 0)

    const disciplineHold = new Map(restrictions.map((r) => [r.userId, r.reason]))
    const cadrePrincipals = new Set(grants.map((g) => g.principalId))

    const candidates: Candidate[] = terms.map((term) => {
      const perMonth = monthlyByUser.get(term.userId)
      // 分母用整个学期月份数：少参与的月份按 0 计入平均
      const pointsAvg = months.reduce((acc, m) => acc + (perMonth?.get(m) ?? 0), 0) / Math.max(1, months.length)

      let excluded = false
      let excludeReason: string | null = null
      const hold = disciplineHold.get(term.userId)
      if (term.semesterRegisteredAt == null) {
        excluded = true
        excludeReason = '当学期未完成注册（附录三·六(一)）'
      } else if (term.membershipStatus === 'observing' || term.membershipStatus === 'applicant') {
        excluded = true
        excludeReason = '处于考察期且未通过（附录三·六(二)）'
      } else if (term.membershipStatus === 'vetoed') {
        excluded = true
        excludeReason = '受到一票否决处理（附录三·六(三)）'
      } else if (hold) {
        excluded = true
        excludeReason = `纪律处分影响评价：${hold}（附录三·六(三)）`
      } else if (!TIERABLE_STATUSES.includes(term.membershipStatus as (typeof TIERABLE_STATUSES)[number])) {
        excluded = true
        excludeReason = `在册状态 ${term.membershipStatus} 不计入定档`
      } else if (term.user.accountStatus !== 'active') {
        excluded = true
        excludeReason = '账号已停用'
      }

      return {
        userId: term.userId,
        studentNo: term.user.studentNo,
        realName: term.user.verifiedRealName,
        pointsAvg,
        contestRaw: sumBy(ledger, term.userId, CONTEST_CATEGORIES),
        serviceRaw: sumBy(ledger, term.userId, SERVICE_CATEGORIES),
        penaltyRaw: Math.abs(sumBy(ledger, term.userId, ['penalty'])),
        excluded,
        excludeReason,
        cadre: cadrePrincipals.has(term.user.principalId),
        tiebreak: {
          recentPoints: round(
            recentMonths.reduce((acc, m) => acc + (perMonth?.get(m) ?? 0), 0),
            4,
          ),
          recentContest: round(sumBy(recentLedger, term.userId, CONTEST_CATEGORIES), 4),
          recentActivity: round(sumBy(recentLedger, term.userId, ['activity']), 4),
          needsManual: false,
        },
      }
    })

    const publishedSet = new Set(publishedMonths.map((r) => r.scoreMonth))
    const missing = months.filter((m) => !publishedSet.has(m))
    const diagnostics = [
      `学期月份 ${months.join('、')}`,
      missing.length > 0
        ? `其中 ${missing.join('、')} 无已发布月度积分，这些月按 0 计入平均值`
        : '各月月度积分均已发布',
      `候选 ${candidates.length} 人，干部口径 ${candidates.filter((c) => c.cadre).length} 人，自动排除 ${candidates.filter((c) => c.excluded).length} 人`,
    ].join('；')

    return { candidates, diagnostics }
  }

  /** 标准分换算 + 排序 + 定档（附录三·三至五、七） */
  private assign(candidates: Candidate[]) {
    // 百分位的参照系是「符合评价条件的成员」（附录三·五(一)），不含排除与干部口径
    const pool = candidates.filter((c) => !c.excluded && !c.cadre)
    const sortedPoints = pool.map((c) => c.pointsAvg).sort((a, b) => a - b)
    const sortedContest = pool.map((c) => c.contestRaw).sort((a, b) => a - b)
    const sortedService = pool.map((c) => c.serviceRaw).sort((a, b) => a - b)

    const scored = candidates.map((c) => {
      const inPool = !c.excluded && !c.cadre
      const pointsStd = inPool ? round(percentile(c.pointsAvg, sortedPoints), 4) : 0
      const contestStd = inPool ? round(percentile(c.contestRaw, sortedContest), 4) : 0
      const serviceStd = inPool ? round(percentile(c.serviceRaw, sortedService), 4) : 0
      const disciplinePenalty = inPool ? round(Math.min(DISCIPLINE_CAP, c.penaltyRaw), 4) : 0
      return {
        ...c,
        pointsStd,
        contestStd,
        serviceStd,
        disciplinePenalty,
        hScore: hOf({ pointsStd, contestStd, serviceStd, disciplinePenalty }, WEIGHTS),
        rankNo: null as number | null,
        tier: null as 'A' | 'B' | 'C' | null,
        suggestedScore: 0,
      }
    })

    const tierable = scored.filter((r) => !r.excluded && !r.cadre)
    tierable.sort(compareForTier)
    // 四项全部相同的相邻成员需人工认定（附录三·七(四)）
    for (let i = 1; i < tierable.length; i += 1) {
      const prev = tierable[i - 1]!
      const curr = tierable[i]!
      if (compareForTier(prev, curr) === 0) {
        prev.tiebreak = { ...prev.tiebreak, needsManual: true }
        curr.tiebreak = { ...curr.tiebreak, needsManual: true }
      }
    }

    const counts = tierCounts(tierable.length, TIER_RATIOS)
    tierable.forEach((row, index) => {
      row.rankNo = index + 1
      if (index < counts.a) {
        row.tier = 'A'
        row.suggestedScore = tierScore('A', index + 1, counts)
      } else if (index < counts.a + counts.b) {
        row.tier = 'B'
        row.suggestedScore = tierScore('B', index - counts.a + 1, counts)
      } else {
        row.tier = 'C'
        row.suggestedScore = tierScore('C', index - counts.a - counts.b + 1, counts)
      }
    })
    return scored
  }

  async batchDetail(batchId: string) {
    const batch = await this.db.evaluationBatch.findUnique({
      where: { id: batchId },
      include: { semester: { select: { code: true, name: true, startsOn: true, endsOn: true } } },
    })
    if (!batch) throw new EvaluationError('批次不存在', 'NOT_FOUND')
    const rows = await this.db.evaluationRow.findMany({
      where: { batchId },
      orderBy: [{ rankNo: 'asc' }, { studentNo: 'asc' }],
    })
    return {
      batch: {
        id: batch.id,
        semesterId: batch.semesterId,
        semesterCode: batch.semester.code,
        semesterName: batch.semester.name,
        status: batch.status,
        isTest: batch.isTest,
        memberCount: batch.memberCount,
        weights: batch.weights,
        tierRatios: batch.tierRatios,
        note: batch.note,
        generatedAt: batch.generatedAt,
        publishedAt: batch.publishedAt,
      },
      rows: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        studentNo: r.studentNo,
        realName: r.realName,
        pointsAvg: Number(r.pointsAvg),
        pointsStd: Number(r.overridePointsStd ?? r.pointsStd),
        contestStd: Number(r.overrideContestStd ?? r.contestStd),
        serviceStd: Number(r.overrideServiceStd ?? r.serviceStd),
        disciplinePenalty: Number(r.overridePenalty ?? r.disciplinePenalty),
        hScore: Number(r.hScore),
        rankNo: r.rankNo,
        tier: r.tier,
        suggestedScore: Number(r.suggestedScore),
        finalScore: Number(r.overrideScore ?? r.suggestedScore),
        overridden:
          r.overrideScore != null ||
          r.overridePointsStd != null ||
          r.overrideContestStd != null ||
          r.overrideServiceStd != null ||
          r.overridePenalty != null,
        // 引擎原值与覆盖值分开给前端：修改表单要能区分「未覆盖」与「覆盖成同一个数」
        computed: {
          pointsStd: Number(r.pointsStd),
          contestStd: Number(r.contestStd),
          serviceStd: Number(r.serviceStd),
          penalty: Number(r.disciplinePenalty),
        },
        overrides: {
          pointsStd: r.overridePointsStd == null ? null : Number(r.overridePointsStd),
          contestStd: r.overrideContestStd == null ? null : Number(r.overrideContestStd),
          serviceStd: r.overrideServiceStd == null ? null : Number(r.overrideServiceStd),
          penalty: r.overridePenalty == null ? null : Number(r.overridePenalty),
          score: r.overrideScore == null ? null : Number(r.overrideScore),
        },
        overrideReason: r.overrideReason,
        overrideAt: r.overrideAt,
        excluded: r.excluded,
        excludeReason: r.excludeReason,
        cadre: r.cadre,
        tiebreak: r.tiebreak,
      })),
    }
  }

  /** 逐人修改：分量覆盖、最终分覆盖、排除与干部口径开关（附录三·六、九.3） */
  async overrideRow(
    actor: SessionActor,
    batchId: string,
    rowId: string,
    patch: {
      pointsStd?: number | null
      contestStd?: number | null
      serviceStd?: number | null
      penalty?: number | null
      score?: number | null
      excluded?: boolean
      excludeReason?: string | null
      cadre?: boolean
      reason: string
    },
  ) {
    const row = await this.db.evaluationRow.findUnique({ where: { id: rowId }, include: { batch: true } })
    if (!row || row.batchId !== batchId) throw new EvaluationError('记录不存在', 'NOT_FOUND')
    if (row.batch.status === 'published') throw new EvaluationError('批次已发布，如需更正请重新生成批次', 'BATCH_PUBLISHED')

    await this.db.evaluationRow.update({
      where: { id: rowId },
      data: {
        overridePointsStd: patch.pointsStd === undefined ? undefined : patch.pointsStd?.toFixed(4) ?? null,
        overrideContestStd: patch.contestStd === undefined ? undefined : patch.contestStd?.toFixed(4) ?? null,
        overrideServiceStd: patch.serviceStd === undefined ? undefined : patch.serviceStd?.toFixed(4) ?? null,
        overridePenalty: patch.penalty === undefined ? undefined : patch.penalty?.toFixed(4) ?? null,
        overrideScore: patch.score === undefined ? undefined : patch.score?.toFixed(3) ?? null,
        excluded: patch.excluded,
        excludeReason:
          patch.excluded === undefined && patch.excludeReason === undefined
            ? undefined
            : patch.excludeReason ?? (patch.excluded ? '主席团认定不纳入（附录三·六）' : null),
        cadre: patch.cadre,
        overrideReason: patch.reason,
        overrideBy: actor.principalId,
        overrideAt: new Date(),
      },
    })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'evaluation.row.override',
      resourceType: 'evaluation_row',
      resourceId: rowId,
      summary: `${row.studentNo} ${row.realName} 综评分量修改`,
      before: { pointsStd: row.pointsStd, score: row.overrideScore ?? row.suggestedScore, excluded: row.excluded, cadre: row.cadre },
      after: patch,
      reason: patch.reason,
    })
    // 分量变化会改变 H 与名次，排除/干部开关会改变 N，故改完即按现值重算定档
    await this.recompute(actor, batchId)
    return { updated: true }
  }

  /** 按「覆盖值优先」重算 H、名次与建议值；overrideScore 不被覆盖 */
  async recompute(actor: SessionActor, batchId: string) {
    const batch = await this.db.evaluationBatch.findUnique({ where: { id: batchId } })
    if (!batch) throw new EvaluationError('批次不存在', 'NOT_FOUND')
    if (batch.status === 'published') throw new EvaluationError('批次已发布，不可重算', 'BATCH_PUBLISHED')
    const rows = await this.db.evaluationRow.findMany({ where: { batchId } })

    const weights = parseWeights(batch.weights)
    const ratios = parseRatios(batch.tierRatios)
    const effective = rows.map((r) => {
      const pointsStd = Number(r.overridePointsStd ?? r.pointsStd)
      const contestStd = Number(r.overrideContestStd ?? r.contestStd)
      const serviceStd = Number(r.overrideServiceStd ?? r.serviceStd)
      const disciplinePenalty = Number(r.overridePenalty ?? r.disciplinePenalty)
      return {
        id: r.id,
        studentNo: r.studentNo,
        excluded: r.excluded,
        cadre: r.cadre,
        tiebreak: parseTiebreak(r.tiebreak),
        hScore: hOf({ pointsStd, contestStd, serviceStd, disciplinePenalty }, weights),
        rankNo: null as number | null,
        tier: null as 'A' | 'B' | 'C' | null,
        suggestedScore: 0,
      }
    })

    const tierable = effective.filter((r) => !r.excluded && !r.cadre)
    tierable.sort(compareForTier)
    const counts = tierCounts(tierable.length, ratios)
    tierable.forEach((row, index) => {
      row.rankNo = index + 1
      if (index < counts.a) {
        row.tier = 'A'
        row.suggestedScore = tierScore('A', index + 1, counts)
      } else if (index < counts.a + counts.b) {
        row.tier = 'B'
        row.suggestedScore = tierScore('B', index - counts.a + 1, counts)
      } else {
        row.tier = 'C'
        row.suggestedScore = tierScore('C', index - counts.a - counts.b + 1, counts)
      }
    })

    await this.db.$transaction([
      ...effective.map((r) =>
        this.db.evaluationRow.update({
          where: { id: r.id },
          data: { hScore: r.hScore.toFixed(4), rankNo: r.rankNo, tier: r.tier, suggestedScore: r.suggestedScore.toFixed(3) },
        }),
      ),
      this.db.evaluationBatch.update({ where: { id: batchId }, data: { memberCount: tierable.length } }),
    ])
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'evaluation.batch.recompute',
      resourceType: 'evaluation_batch',
      resourceId: batchId,
      summary: `重算定档：N=${tierable.length}，A ${counts.a} / B ${counts.b} / C ${counts.c}`,
    })
    return { memberCount: tierable.length, counts }
  }

  /** 发布：锁定批次，后续修改须重新生成（公示留痕） */
  async publish(actor: SessionActor, batchId: string) {
    const batch = await this.db.evaluationBatch.findUnique({ where: { id: batchId } })
    if (!batch) throw new EvaluationError('批次不存在', 'NOT_FOUND')
    if (batch.status === 'published') return { published: true }
    await this.db.evaluationBatch.update({ where: { id: batchId }, data: { status: 'published', publishedAt: new Date() } })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'evaluation.batch.publish',
      resourceType: 'evaluation_batch',
      resourceId: batchId,
      summary: batch.isTest ? '发布综评批次（测试数据）' : '发布综评批次',
    })
    return { published: true }
  }

  async deleteBatch(actor: SessionActor, batchId: string) {
    const batch = await this.db.evaluationBatch.findUnique({ where: { id: batchId } })
    if (!batch) throw new EvaluationError('批次不存在', 'NOT_FOUND')
    await this.db.evaluationBatch.delete({ where: { id: batchId } })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'evaluation.batch.delete',
      resourceType: 'evaluation_batch',
      resourceId: batchId,
      summary: '删除综评批次',
    })
    return { deleted: true }
  }

  /**
   * 导出表格：学号 / 姓名 / 加分。
   * 只导出定档成员与已手工给分者；排除名单与未给分的干部口径行不进导出。
   */
  async exportCsv(batchId: string): Promise<{ csv: string; filename: string }> {
    const batch = await this.db.evaluationBatch.findUnique({
      where: { id: batchId },
      include: { semester: { select: { code: true } } },
    })
    if (!batch) throw new EvaluationError('批次不存在', 'NOT_FOUND')
    const rows = await this.db.evaluationRow.findMany({
      where: { batchId },
      orderBy: [{ rankNo: 'asc' }, { studentNo: 'asc' }],
    })
    const lines = ['学号,姓名,加分']
    for (const r of rows) {
      const manual = r.overrideScore != null
      if (!manual && (r.excluded || r.cadre || r.tier == null)) continue
      const score = Number(r.overrideScore ?? r.suggestedScore)
      lines.push([csvCell(r.studentNo), csvCell(r.realName), score.toFixed(3)].join(','))
    }
    // 测试批次的文件名自带标记，避免测试产物被当成正式结果上报
    const filename = `综评建议-${batch.semester.code}${batch.isTest ? '-测试数据' : ''}-${batch.id.slice(0, 8)}.csv`
    return { csv: `${lines.join('\n')}\n`, filename }
  }
}

function hOf(
  parts: { pointsStd: number; contestStd: number; serviceStd: number; disciplinePenalty: number },
  weights: Weights,
): number {
  return round(
    weights.points * parts.pointsStd + weights.contest * parts.contestStd + weights.service * parts.serviceStd - parts.disciplinePenalty,
    4,
  )
}

/** 附录三·七：H 降序；并列依次比较近三个月有效积分、正式竞赛积分、周赛月赛积分 */
function compareForTier(
  a: { hScore: number; tiebreak: Tiebreak },
  b: { hScore: number; tiebreak: Tiebreak },
): number {
  if (a.hScore !== b.hScore) return b.hScore - a.hScore
  if (a.tiebreak.recentPoints !== b.tiebreak.recentPoints) return b.tiebreak.recentPoints - a.tiebreak.recentPoints
  if (a.tiebreak.recentContest !== b.tiebreak.recentContest) return b.tiebreak.recentContest - a.tiebreak.recentContest
  if (a.tiebreak.recentActivity !== b.tiebreak.recentActivity) return b.tiebreak.recentActivity - a.tiebreak.recentActivity
  return 0
}

function parseWeights(value: unknown): Weights {
  const v = value as Partial<Weights> | null
  return {
    points: typeof v?.points === 'number' ? v.points : WEIGHTS.points,
    contest: typeof v?.contest === 'number' ? v.contest : WEIGHTS.contest,
    service: typeof v?.service === 'number' ? v.service : WEIGHTS.service,
  }
}

function parseRatios(value: unknown): TierRatios {
  const v = value as Partial<TierRatios> | null
  return {
    a: typeof v?.a === 'number' ? v.a : TIER_RATIOS.a,
    b: typeof v?.b === 'number' ? v.b : TIER_RATIOS.b,
  }
}

/** Prisma 的 Json 入参要求可索引对象，Tiebreak 是具名接口故在写入处转一次 */
function jsonTiebreak(t: Tiebreak): Record<string, number | boolean> {
  return { ...t }
}

function parseTiebreak(value: unknown): Tiebreak {
  const v = value as Partial<Tiebreak> | null
  return {
    recentPoints: typeof v?.recentPoints === 'number' ? v.recentPoints : 0,
    recentContest: typeof v?.recentContest === 'number' ? v.recentContest : 0,
    recentActivity: typeof v?.recentActivity === 'number' ? v.recentActivity : 0,
    needsManual: v?.needsManual === true,
  }
}
