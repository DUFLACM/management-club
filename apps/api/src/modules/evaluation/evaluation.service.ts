import { Inject, Injectable } from '@nestjs/common'
import { computeEffectiveScore } from '@acm/scoring-core'
import { DomainError } from '../../common/domain-error.js'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { newId, monthKey, monthKeyPlus, memberName } from '../../common/utils.js'
import { assertCurrentClubMember, resolveEffectiveWeights } from '../scoring/effective-ranking.js'
import type { SessionActor } from '../auth/session.service.js'

/**
 * 综合素质评价建议折算（附录三）与实时积分导出：
 * - 不受学期结束时间限制，任何时候均可实时生成、修改、刷新与导出，批次不锁定；
 * - 积分标准分：优先取已发布月度积分，未发布的月份实时按已生效积分账本聚合计算；
 * - 竞赛标准分：学期内 contest | remote_contest | award 账目合计百分位 0–100；
 * - 服务标准分：学期内 contribution | service 账目合计百分位 0–100；
 * - 纪律扣减：学期内 penalty 账目金额绝对值合计，1:1 扣减 H，上限 DISCIPLINE_CAP；
 * - 导出同时提供「综评表（含积分）」与「全员积分汇总表」，支持实时按学期直接导出或按快照导出。
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
/** 常规活动/基础分类别 */
const ACTIVITY_CATEGORIES = ['activity', 'initial'] as const
/** 纳入定档的在册状态；其余状态按附录三·六逐条给出排除理由 */
const TIERABLE_STATUSES = ['formal', 'provisional'] as const

const MEMBERSHIP_LABELS: Record<string, string> = {
  formal: '正式成员',
  provisional: '预备成员',
  observing: '考察成员',
  applicant: '申请中',
  honorary_retired: '荣誉退役',
  withdrawn: '已退出',
  dismissed: '已除名',
  vetoed: '一票否决',
}

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
  displayName: string
  membership: string
  currentE: number
  semesterTotal: number
  pointsAvg: number
  activityRaw: number
  contestRaw: number
  serviceRaw: number
  penaltyRaw: number
  excluded: boolean
  excludeReason: string | null
  cadre: boolean
  tiebreak: Tiebreak
}

interface ScoredCandidate extends Candidate {
  pointsStd: number
  contestStd: number
  serviceStd: number
  disciplinePenalty: number
  hScore: number
  rankNo: number | null
  tier: 'A' | 'B' | 'C' | null
  suggestedScore: number
}

interface LivePointsSummary {
  membership: string
  currentE: number
  semesterTotal: number
  activityRaw: number
  contestRaw: number
  serviceRaw: number
  penaltyRaw: number
}

/** 学期覆盖的月份键（Asia/Shanghai），含首尾月 */
function semesterMonths(startsOn: Date, endsOn: Date): string[] {
  const first = monthKey(startsOn)
  const last = monthKey(endsOn)
  const months: string[] = [first]
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

function shanghaiStamp(now = new Date()): string {
  const d = new Date(now.getTime() + 8 * 3600_000)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function membershipText(status: string | null | undefined): string {
  if (!status) return '—'
  return MEMBERSHIP_LABELS[status] ?? status
}

@Injectable()
export class EvaluationService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** 学期列表：取消时间限制，所有学期均支持随时实时生成与导出 */
  async semesters() {
    const rows = await this.db.semester.findMany({ orderBy: { startsOn: 'desc' }, take: 24 })
    const now = Date.now()
    return {
      testMode: false,
      semesters: rows.map((s) => {
        const ended = s.endsOn.getTime() <= now
        return {
          id: s.id,
          code: s.code,
          name: s.name,
          startsOn: s.startsOn,
          endsOn: s.endsOn,
          ended,
          canGenerate: true,
        }
      }),
    }
  }

  async memberSemesters(userId: string) {
    await assertCurrentClubMember(this.db, userId)
    const now = new Date()
    const terms = await this.db.semester.findMany({
      where: { startsOn: { lte: now } },
      orderBy: [{ startsOn: 'desc' }, { code: 'asc' }],
      select: { id: true, code: true, name: true, endsOn: true },
    })
    const selected = terms.find((term) => term.endsOn >= now) ?? terms[0]
    return {
      semesters: terms.map(({ id, code, name }) => ({ id, code, name })),
      defaultSemesterId: selected?.id ?? null,
    }
  }

  async memberLeaderboard(userId: string, semesterId: string) {
    await assertCurrentClubMember(this.db, userId)
    const semester = await this.db.semester.findFirst({ where: { id: semesterId, startsOn: { lte: new Date() } } })
    if (!semester) throw new EvaluationError('学期不存在或尚未开始', 'NOT_FOUND')
    const ranked = await this.realtimeTierRows(semester)
    return {
      rows: ranked.map((r) => ({
        rank: r.rankNo,
        displayName: r.displayName,
        hScore: r.hScore,
        tier: r.tier,
        suggestedScore: r.suggestedScore,
        needsManual: r.tiebreak.needsManual,
        isMe: r.userId === userId,
      })),
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
      isTest: false,
      memberCount: b.memberCount,
      rowCount: b._count.rows,
      note: b.note,
      generatedAt: b.generatedAt,
      publishedAt: b.publishedAt,
    }))
  }

  /** 实时生成学期批次（不限时间、不锁定、随时可编辑与刷新） */
  async generate(actor: SessionActor, semesterId: string) {
    const semester = await this.db.semester.findUnique({ where: { id: semesterId } })
    if (!semester) throw new EvaluationError('学期不存在', 'NOT_FOUND')

    const { candidates, diagnostics } = await this.collect(semester)
    const batchId = newId()
    const rows = this.assign(candidates)

    await this.db.$transaction(async (tx) => {
      await tx.evaluationBatch.create({
        data: {
          id: batchId,
          semesterId,
          status: 'draft',
          isTest: false,
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
      summary: `${semester.code} 实时综评名单：${rows.length} 人，定档 ${rows.filter((r) => r.tier !== null).length} 人`,
    })
    return { batchId, isTest: false, rowCount: rows.length }
  }

  /** 用最新账本数据同步更新现有批次的计算值（保留手工覆盖项，不锁定） */
  async refreshBatch(actor: SessionActor, batchId: string) {
    const batch = await this.db.evaluationBatch.findUnique({
      where: { id: batchId },
      include: { semester: true, rows: true },
    })
    if (!batch) throw new EvaluationError('批次不存在', 'NOT_FOUND')

    const { candidates, diagnostics } = await this.collect(batch.semester)
    const scored = this.assign(candidates)
    const existingByUser = new Map(batch.rows.map((r) => [r.userId, r]))

    await this.db.$transaction(async (tx) => {
      for (const r of scored) {
        const existing = existingByUser.get(r.userId)
        if (existing) {
          await tx.evaluationRow.update({
            where: { id: existing.id },
            data: {
              studentNo: r.studentNo,
              realName: r.realName,
              pointsAvg: r.pointsAvg.toFixed(10),
              pointsStd: r.pointsStd.toFixed(4),
              contestStd: r.contestStd.toFixed(4),
              serviceStd: r.serviceStd.toFixed(4),
              disciplinePenalty: r.disciplinePenalty.toFixed(4),
              tiebreak: jsonTiebreak(r.tiebreak),
            },
          })
        } else {
          await tx.evaluationRow.create({
            data: {
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
            },
          })
        }
      }
      await tx.evaluationBatch.update({
        where: { id: batchId },
        data: { note: diagnostics, generatedAt: new Date() },
      })
    })

    const result = await this.recompute(actor, batchId)
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'evaluation.batch.refresh',
      resourceType: 'evaluation_batch',
      resourceId: batchId,
      summary: `同步最新积分并重算：共 ${scored.length} 人，定档 ${result.memberCount} 人`,
    })
    return { refreshed: true, rowCount: scored.length, memberCount: result.memberCount }
  }

  /** 读取学期内的候选人与实时积分原始值 */
  private async collect(semester: { id: string; startsOn: Date; endsOn: Date }) {
    const months = semesterMonths(semester.startsOn, semester.endsOn)
    const currentM = monthKey(new Date())
    const elapsed = months.filter((m) => m <= currentM)
    const activeMonths = elapsed.length > 0 ? elapsed : months
    const recentMonths = activeMonths.slice(-3)

    const [semesterTerms, activeUsers] = await Promise.all([
      this.db.membershipTerm.findMany({
        where: { semesterId: semester.id },
        include: {
          user: { select: { id: true, studentNo: true, verifiedRealName: true, profile: { select: { displayName: true } }, principalId: true, accountStatus: true, createdAt: true } },
        },
      }),
      this.db.user.findMany({
        where: { accountStatus: 'active' },
        select: {
          id: true,
          studentNo: true,
          verifiedRealName: true,
          profile: { select: { displayName: true } },
          principalId: true,
          accountStatus: true,
          createdAt: true,
          membershipTerms: { orderBy: { createdAt: 'desc' }, take: 1, select: { membershipStatus: true } },
        },
      }),
    ])

    // 优先使用当学期在册记录；若活跃成员尚未在当学期建新学期记录且在学期结束前入社，也纳入实时统计
    const memberMap = new Map<string, {
      userId: string
      studentNo: string
      realName: string
      displayName: string
      principalId: string
      accountStatus: string
      membershipStatus: string
    }>()
    for (const t of semesterTerms) {
      memberMap.set(t.userId, {
        userId: t.userId,
        studentNo: t.user.studentNo,
        realName: t.user.verifiedRealName,
        displayName: memberName(t.user),
        principalId: t.user.principalId,
        accountStatus: t.user.accountStatus,
        membershipStatus: t.membershipStatus,
      })
    }
    for (const u of activeUsers) {
      if (memberMap.has(u.id)) continue
      if (u.createdAt > semester.endsOn) continue
      const latestStatus = u.membershipTerms[0]?.membershipStatus ?? 'applicant'
      memberMap.set(u.id, {
        userId: u.id,
        studentNo: u.studentNo,
        realName: u.verifiedRealName,
        displayName: memberName(u),
        principalId: u.principalId,
        accountStatus: u.accountStatus,
        membershipStatus: latestStatus,
      })
    }

    const members = [...memberMap.values()]
    if (members.length === 0) return { candidates: [] as Candidate[], diagnostics: '当前没有可统计的成员记录' }

    const userIds = members.map((m) => m.userId)
    const principalIds = members.map((m) => m.principalId)

    const [monthly, ledgerByMonth, allLedgerByMonth, ledger, recentLedger, restrictions, grants, publishedMonths, effectiveWeights] = await Promise.all([
      this.db.monthlyScore.findMany({
        where: { userId: { in: userIds }, scoreMonth: { in: months }, status: 'published' },
        orderBy: { revision: 'asc' },
        select: { userId: true, scoreMonth: true, m: true, rawTotal: true, revision: true },
      }),
      this.db.pointsLedgerEntry.groupBy({
        by: ['userId', 'scoreMonth'],
        where: { userId: { in: userIds }, scoreMonth: { in: months }, status: 'approved' },
        _sum: { amount: true },
      }),
      this.db.pointsLedgerEntry.groupBy({
        by: ['userId', 'scoreMonth'],
        where: { userId: { in: userIds }, status: 'approved' },
        _sum: { amount: true },
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
        where: { scoreMonth: { in: activeMonths }, status: 'published' },
        distinct: ['scoreMonth'],
        select: { scoreMonth: true },
      }),
      resolveEffectiveWeights(this.db),
    ])

    // 同一 (user, month) 优先取已发布的月度积分；未发布的月份实时按已生效积分账本汇总
    const monthlyByUser = new Map<string, Map<string, number>>()
    for (const row of ledgerByMonth) {
      const byMonth = monthlyByUser.get(row.userId) ?? new Map<string, number>()
      byMonth.set(row.scoreMonth, Number(row._sum.amount ?? 0))
      monthlyByUser.set(row.userId, byMonth)
    }
    for (const row of monthly) {
      const byMonth = monthlyByUser.get(row.userId) ?? new Map<string, number>()
      byMonth.set(row.scoreMonth, row.m ?? Number(row.rawTotal))
      monthlyByUser.set(row.userId, byMonth)
    }

    // 全部历史月份（用于算当前有效积分 E，与排行榜同源）
    const allMonthlyByUser = new Map<string, Record<string, number>>()
    for (const row of allLedgerByMonth) {
      const map = allMonthlyByUser.get(row.userId) ?? {}
      map[row.scoreMonth] = Number(row._sum.amount ?? 0)
      allMonthlyByUser.set(row.userId, map)
    }

    const sumBy = (rows: typeof ledger, userId: string, categories: readonly string[]) =>
      rows
        .filter((r) => r.userId === userId && categories.includes(r.category))
        .reduce((acc, r) => acc + Number(r._sum.amount ?? 0), 0)

    const disciplineHold = new Map(restrictions.map((r) => [r.userId, r.reason]))
    const cadrePrincipals = new Set(grants.map((g) => g.principalId))

    const candidates: Candidate[] = members.map((member) => {
      const perMonth = monthlyByUser.get(member.userId)
      const semesterTotal = round(
        activeMonths.reduce((acc, m) => acc + (perMonth?.get(m) ?? 0), 0),
        4,
      )
      const pointsAvg = semesterTotal / Math.max(1, activeMonths.length)
      const eff = computeEffectiveScore(
        { monthlyScores: allMonthlyByUser.get(member.userId) ?? {}, currentMonth: currentM },
        { effectiveWeights },
      )

      let excluded = false
      let excludeReason: string | null = null
      const hold = disciplineHold.get(member.userId)
      if (member.membershipStatus === 'observing' || member.membershipStatus === 'applicant') {
        excluded = true
        excludeReason = '处于考察/申请期且未转正（附录三·六(二)）'
      } else if (member.membershipStatus === 'vetoed') {
        excluded = true
        excludeReason = '受到一票否决处理（附录三·六(三)）'
      } else if (hold) {
        excluded = true
        excludeReason = `纪律处分影响评价：${hold}（附录三·六(三)）`
      } else if (!TIERABLE_STATUSES.includes(member.membershipStatus as (typeof TIERABLE_STATUSES)[number])) {
        excluded = true
        excludeReason = `在册状态 ${membershipText(member.membershipStatus)} 不计入定档`
      } else if (member.accountStatus !== 'active') {
        excluded = true
        excludeReason = '账号已停用'
      }

      return {
        userId: member.userId,
        studentNo: member.studentNo,
        realName: member.realName,
        displayName: member.displayName,
        membership: member.membershipStatus,
        currentE: round(Number(eff.e), 2),
        semesterTotal,
        pointsAvg,
        activityRaw: round(sumBy(ledger, member.userId, ACTIVITY_CATEGORIES), 4),
        contestRaw: round(sumBy(ledger, member.userId, CONTEST_CATEGORIES), 4),
        serviceRaw: round(sumBy(ledger, member.userId, SERVICE_CATEGORIES), 4),
        penaltyRaw: round(Math.abs(sumBy(ledger, member.userId, ['penalty'])), 4),
        excluded,
        excludeReason,
        cadre: cadrePrincipals.has(member.principalId),
        tiebreak: {
          recentPoints: round(
            recentMonths.reduce((acc, m) => acc + (perMonth?.get(m) ?? 0), 0),
            4,
          ),
          recentContest: round(sumBy(recentLedger, member.userId, CONTEST_CATEGORIES), 4),
          recentActivity: round(sumBy(recentLedger, member.userId, ['activity']), 4),
          needsManual: false,
        },
      }
    })

    const publishedSet = new Set(publishedMonths.map((r) => r.scoreMonth))
    const liveMonths = activeMonths.filter((m) => !publishedSet.has(m))
    const diagnostics = [
      `统计月份 ${activeMonths.join('、')}`,
      liveMonths.length > 0
        ? `其中 ${liveMonths.join('、')} 按实时积分流水聚合`
        : '各月均采用已发布月度积分',
      `共 ${candidates.length} 人，定档池 ${candidates.filter((c) => !c.excluded && !c.cadre).length} 人，干部口径 ${candidates.filter((c) => c.cadre && !c.excluded).length} 人，不纳入 ${candidates.filter((c) => c.excluded).length} 人`,
    ].join('；')

    return { candidates, diagnostics }
  }

  /** 为批次内成员补充实时积分摘要（供详情展示与积分导出） */
  private async loadLivePointsForUsers(
    semester: { id: string; startsOn: Date; endsOn: Date },
    userIds: string[],
  ): Promise<Map<string, LivePointsSummary>> {
    const result = new Map<string, LivePointsSummary>()
    if (userIds.length === 0) return result

    const months = semesterMonths(semester.startsOn, semester.endsOn)
    const currentM = monthKey(new Date())
    const elapsed = months.filter((m) => m <= currentM)
    const activeMonths = elapsed.length > 0 ? elapsed : months

    const [users, monthly, ledgerByMonth, allLedgerByMonth, ledgerByCategory, effectiveWeights] = await Promise.all([
      this.db.user.findMany({
        where: { id: { in: userIds } },
        select: {
          id: true,
          membershipTerms: { orderBy: { createdAt: 'desc' }, take: 1, select: { membershipStatus: true } },
        },
      }),
      this.db.monthlyScore.findMany({
        where: { userId: { in: userIds }, scoreMonth: { in: months }, status: 'published' },
        orderBy: { revision: 'asc' },
        select: { userId: true, scoreMonth: true, m: true, rawTotal: true },
      }),
      this.db.pointsLedgerEntry.groupBy({
        by: ['userId', 'scoreMonth'],
        where: { userId: { in: userIds }, scoreMonth: { in: months }, status: 'approved' },
        _sum: { amount: true },
      }),
      this.db.pointsLedgerEntry.groupBy({
        by: ['userId', 'scoreMonth'],
        where: { userId: { in: userIds }, status: 'approved' },
        _sum: { amount: true },
      }),
      this.db.pointsLedgerEntry.groupBy({
        by: ['userId', 'category'],
        where: { userId: { in: userIds }, scoreMonth: { in: months }, status: 'approved' },
        _sum: { amount: true },
      }),
      resolveEffectiveWeights(this.db),
    ])

    const membershipMap = new Map(users.map((u) => [u.id, u.membershipTerms[0]?.membershipStatus ?? 'applicant']))
    const semMonthMap = new Map<string, Map<string, number>>()
    for (const row of ledgerByMonth) {
      const m = semMonthMap.get(row.userId) ?? new Map<string, number>()
      m.set(row.scoreMonth, Number(row._sum.amount ?? 0))
      semMonthMap.set(row.userId, m)
    }
    for (const row of monthly) {
      const m = semMonthMap.get(row.userId) ?? new Map<string, number>()
      m.set(row.scoreMonth, row.m ?? Number(row.rawTotal))
      semMonthMap.set(row.userId, m)
    }

    const allMonthMap = new Map<string, Record<string, number>>()
    for (const row of allLedgerByMonth) {
      const m = allMonthMap.get(row.userId) ?? {}
      m[row.scoreMonth] = Number(row._sum.amount ?? 0)
      allMonthMap.set(row.userId, m)
    }

    const sumCat = (uid: string, cats: readonly string[]) =>
      ledgerByCategory
        .filter((r) => r.userId === uid && cats.includes(r.category))
        .reduce((acc, r) => acc + Number(r._sum.amount ?? 0), 0)

    for (const uid of userIds) {
      const perMonth = semMonthMap.get(uid)
      const semesterTotal = round(
        activeMonths.reduce((acc, m) => acc + (perMonth?.get(m) ?? 0), 0),
        2,
      )
      const eff = computeEffectiveScore(
        { monthlyScores: allMonthMap.get(uid) ?? {}, currentMonth: currentM },
        { effectiveWeights },
      )
      result.set(uid, {
        membership: membershipMap.get(uid) ?? 'applicant',
        currentE: round(Number(eff.e), 2),
        semesterTotal,
        activityRaw: round(sumCat(uid, ACTIVITY_CATEGORIES), 2),
        contestRaw: round(sumCat(uid, CONTEST_CATEGORIES), 2),
        serviceRaw: round(sumCat(uid, SERVICE_CATEGORIES), 2),
        penaltyRaw: round(Math.abs(sumCat(uid, ['penalty'])), 2),
      })
    }
    return result
  }

  /** 标准分换算 + 排序 + 定档（附录三·三至五、七） */
  private assign(candidates: Candidate[]): ScoredCandidate[] {
    const pool = candidates.filter((c) => !c.excluded && !c.cadre)
    const sortedPoints = pool.map((c) => c.pointsAvg).sort((a, b) => a - b)
    const sortedContest = pool.map((c) => c.contestRaw).sort((a, b) => a - b)
    const sortedService = pool.map((c) => c.serviceRaw).sort((a, b) => a - b)

    const scored: ScoredCandidate[] = candidates.map((c) => {
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
        rankNo: null,
        tier: null,
        suggestedScore: 0,
      }
    })

    const tierable = scored.filter((r) => !r.excluded && !r.cadre)
    // 完全同分仍标记「需人工认定」，在裁定前让各次实时读取显示一致的名次。
    tierable.sort((a, b) => compareForTier(a, b) || a.studentNo.localeCompare(b.studentNo))
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
      include: { semester: { select: { id: true, code: true, name: true, startsOn: true, endsOn: true } } },
    })
    if (!batch) throw new EvaluationError('批次不存在', 'NOT_FOUND')
    const rows = await this.db.evaluationRow.findMany({
      where: { batchId },
      orderBy: [{ rankNo: 'asc' }, { studentNo: 'asc' }],
    })
    const liveMap = await this.loadLivePointsForUsers(
      batch.semester,
      rows.map((r) => r.userId),
    )

    return {
      batch: {
        id: batch.id,
        semesterId: batch.semesterId,
        semesterCode: batch.semester.code,
        semesterName: batch.semester.name,
        status: batch.status,
        isTest: false,
        memberCount: batch.memberCount,
        weights: batch.weights,
        tierRatios: batch.tierRatios,
        note: batch.note,
        generatedAt: batch.generatedAt,
        publishedAt: batch.publishedAt,
      },
      rows: rows.map((r) => {
        const live = liveMap.get(r.userId)
        return {
          id: r.id,
          userId: r.userId,
          studentNo: r.studentNo,
          realName: r.realName,
          membership: live?.membership ?? 'formal',
          currentE: live?.currentE ?? 0,
          semesterTotal: live?.semesterTotal ?? 0,
          activityRaw: live?.activityRaw ?? 0,
          contestRaw: live?.contestRaw ?? 0,
          serviceRaw: live?.serviceRaw ?? 0,
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
        }
      }),
    }
  }

  /** 逐人修改：分量覆盖、最终分覆盖、排除与干部口径开关（不锁定，随时可改） */
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
    await this.recompute(actor, batchId)
    return { updated: true }
  }

  /** 按「覆盖值优先」重算 H、名次与建议值；overrideScore 不被覆盖，且永不锁定 */
  async recompute(actor: SessionActor, batchId: string) {
    const batch = await this.db.evaluationBatch.findUnique({ where: { id: batchId } })
    if (!batch) throw new EvaluationError('批次不存在', 'NOT_FOUND')
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
    tierable.sort((a, b) => compareForTier(a, b) || a.studentNo.localeCompare(b.studentNo))
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

  /** 兼容保留接口：仅记录发布时间，不再锁定批次编辑 */
  async publish(actor: SessionActor, batchId: string) {
    const batch = await this.db.evaluationBatch.findUnique({ where: { id: batchId } })
    if (!batch) throw new EvaluationError('批次不存在', 'NOT_FOUND')
    await this.db.evaluationBatch.update({ where: { id: batchId }, data: { publishedAt: new Date() } })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'evaluation.batch.publish',
      resourceType: 'evaluation_batch',
      resourceId: batchId,
      summary: '标记综评快照时间（不锁定，仍可随时修改与导出）',
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
      summary: '删除综评快照',
    })
    return { deleted: true }
  }

  /**
   * 导出综评表（含积分）：学号 / 姓名 / 排名 / 定档 / 当前有效积分 / 学期总积分 / 月均积分 / 各项标准分 / 综合分H / 综评加分。
   * 包含全部定档成员与已手工给分者。
   */
  async exportCsv(batchId: string): Promise<{ csv: string; filename: string }> {
    const detail = await this.batchDetail(batchId)
    const lines = [
      '学号,姓名,口径,排名,定档,当前有效积分,学期总积分,月均积分,积分标准分,竞赛标准分,服务标准分,纪律扣减,综合分H,加分',
    ]
    for (const r of detail.rows) {
      const manual = r.overrides.score != null
      if (!manual && (r.excluded || r.cadre || r.tier == null)) continue
      const scopeLabel = r.cadre ? '干部口径' : r.excluded ? '手工给分' : '定档成员'
      lines.push([
        csvCell(r.studentNo),
        csvCell(r.realName),
        csvCell(scopeLabel),
        csvCell(r.rankNo ?? ''),
        csvCell(r.tier ?? ''),
        r.currentE.toFixed(2),
        r.semesterTotal.toFixed(2),
        r.pointsAvg.toFixed(2),
        r.pointsStd.toFixed(2),
        r.contestStd.toFixed(2),
        r.serviceStd.toFixed(2),
        r.disciplinePenalty.toFixed(2),
        r.hScore.toFixed(2),
        r.finalScore.toFixed(3),
      ].join(','))
    }
    const filename = `综评与积分-${detail.batch.semesterCode}-${shanghaiStamp()}.csv`
    return { csv: `${lines.join('\n')}\n`, filename }
  }

  /** 导出批次内全员积分明细表（含普通定档、干部口径与不纳入成员的完整积分构成） */
  async exportPointsCsv(batchId: string): Promise<{ csv: string; filename: string }> {
    const detail = await this.batchDetail(batchId)
    const lines = [
      '学号,姓名,在册身份,综评状态,当前有效积分,学期总积分,月均积分,活动积分,竞赛积分,服务贡献积分,纪律扣减,综合分H,排名,定档,综评加分',
    ]
    const sorted = [...detail.rows].sort(
      (a, b) =>
        (a.rankNo ?? Number.MAX_SAFE_INTEGER) - (b.rankNo ?? Number.MAX_SAFE_INTEGER) ||
        b.currentE - a.currentE ||
        a.studentNo.localeCompare(b.studentNo),
    )
    for (const r of sorted) {
      const evalStatus = r.excluded
        ? `不纳入${r.excludeReason ? `（${r.excludeReason}）` : ''}`
        : r.cadre
          ? '干部口径'
          : r.tier
            ? `已定档（${r.tier} 档）`
            : '未定档'
      lines.push([
        csvCell(r.studentNo),
        csvCell(r.realName),
        csvCell(membershipText(r.membership)),
        csvCell(evalStatus),
        r.currentE.toFixed(2),
        r.semesterTotal.toFixed(2),
        r.pointsAvg.toFixed(2),
        r.activityRaw.toFixed(2),
        r.contestRaw.toFixed(2),
        r.serviceRaw.toFixed(2),
        r.disciplinePenalty.toFixed(2),
        r.hScore.toFixed(2),
        csvCell(r.rankNo ?? ''),
        csvCell(r.tier ?? ''),
        r.finalScore.toFixed(3),
      ].join(','))
    }
    const filename = `成员积分汇总-${detail.batch.semesterCode}-${shanghaiStamp()}.csv`
    return { csv: `${lines.join('\n')}\n`, filename }
  }

  private async realtimeTierRows(semester: { id: string; startsOn: Date; endsOn: Date }) {
    const { candidates } = await this.collect(semester)
    return this.assign(candidates)
      .filter((r): r is ScoredCandidate & { rankNo: number; tier: 'A' | 'B' | 'C' } => r.rankNo !== null && r.tier !== null)
      .sort((a, b) => a.rankNo - b.rankNo)
  }

  /** 实时按学期直接导出综评表（含积分），不落库、不锁定、不受时间限制 */
  async exportRealtimeCsv(semesterId: string): Promise<{ csv: string; filename: string }> {
    const semester = await this.db.semester.findUnique({ where: { id: semesterId } })
    if (!semester) throw new EvaluationError('学期不存在', 'NOT_FOUND')
    const tierable = await this.realtimeTierRows(semester)
    const lines = [
      '学号,姓名,口径,排名,定档,当前有效积分,学期总积分,月均积分,积分标准分,竞赛标准分,服务标准分,纪律扣减,综合分H,加分',
    ]
    for (const r of tierable) {
      lines.push([
        csvCell(r.studentNo),
        csvCell(r.realName),
        csvCell('定档成员'),
        csvCell(r.rankNo ?? ''),
        csvCell(r.tier ?? ''),
        r.currentE.toFixed(2),
        r.semesterTotal.toFixed(2),
        r.pointsAvg.toFixed(2),
        r.pointsStd.toFixed(2),
        r.contestStd.toFixed(2),
        r.serviceStd.toFixed(2),
        r.disciplinePenalty.toFixed(2),
        r.hScore.toFixed(2),
        r.suggestedScore.toFixed(3),
      ].join(','))
    }
    const filename = `实时综评与积分-${semester.code}-${shanghaiStamp()}.csv`
    return { csv: `${lines.join('\n')}\n`, filename }
  }

  /** 实时按学期直接导出全员积分汇总表（含所有成员的当前有效积分、学期总积分与分类明细） */
  async exportRealtimePointsCsv(semesterId: string): Promise<{ csv: string; filename: string }> {
    const semester = await this.db.semester.findUnique({ where: { id: semesterId } })
    if (!semester) throw new EvaluationError('学期不存在', 'NOT_FOUND')
    const { candidates } = await this.collect(semester)
    const scored = this.assign(candidates).sort(
      (a, b) =>
        (a.rankNo ?? Number.MAX_SAFE_INTEGER) - (b.rankNo ?? Number.MAX_SAFE_INTEGER) ||
        b.currentE - a.currentE ||
        a.studentNo.localeCompare(b.studentNo),
    )
    const lines = [
      '学号,姓名,在册身份,综评状态,当前有效积分,学期总积分,月均积分,活动积分,竞赛积分,服务贡献积分,纪律扣减,综合分H,排名,定档,综评加分',
    ]
    for (const r of scored) {
      const evalStatus = r.excluded
        ? `不纳入${r.excludeReason ? `（${r.excludeReason}）` : ''}`
        : r.cadre
          ? '干部口径'
          : r.tier
            ? `已定档（${r.tier} 档）`
            : '未定档'
      lines.push([
        csvCell(r.studentNo),
        csvCell(r.realName),
        csvCell(membershipText(r.membership)),
        csvCell(evalStatus),
        r.currentE.toFixed(2),
        r.semesterTotal.toFixed(2),
        r.pointsAvg.toFixed(2),
        r.activityRaw.toFixed(2),
        r.contestRaw.toFixed(2),
        r.serviceRaw.toFixed(2),
        r.disciplinePenalty.toFixed(2),
        r.hScore.toFixed(2),
        csvCell(r.rankNo ?? ''),
        csvCell(r.tier ?? ''),
        r.suggestedScore.toFixed(3),
      ].join(','))
    }
    const filename = `实时成员积分汇总-${semester.code}-${shanghaiStamp()}.csv`
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
