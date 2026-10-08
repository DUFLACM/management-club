import { DomainError } from '../../common/domain-error.js'
import { Inject, Injectable } from '@nestjs/common'
import {
  buildSourceKey,
  computeEffectiveScore,
  defaultRuleParams,
  rollupMonthly,
  ruleParamsSchema,
  RULE_GAPS,
  type RuleParams,
  type SourceKeyParts,
} from '@acm/scoring-core'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { ActivityService } from '../activities/activity.service.js'
import { ContestStandingsService } from '../activities/contest-standings.service.js'
import { rankEligibleMembers } from './effective-ranking.js'
import { mergeRuleParams } from './rule-params.js'
import { computeContestW, hasValidSubmission, type LambdaKey } from './contest-formula.js'
import { newId, monthKey, monthKeyPlus, memberName } from '../../common/utils.js'
import type { SessionActor } from '../auth/session.service.js'
import { z } from 'zod'

/**
 * 积分账本/月度/有效积分/公示/冻结（02 方案 5.4、6.3、6.4；04 方案）：
 * - source_key 稳定逻辑键（不含活动/地点/rule_version）；部分唯一索引保证同一来源只有一条 approved。
 * - 纠错：冲正 + 替代，不改总分、不删历史。
 * - 月度 rollup 使用 scoring-core；R01 未决时不发布正式 M。
 * - 公示 ≥48h；复核单人裁决即结案；冻结后回填不改变名单。
 */

export class ScoringError extends DomainError {
  constructor(message: string, readonly code: string) {
    super(message, code)
  }
}

export const ledgerEntrySchema = z.object({
  userId: z.string().uuid(),
  sourceKey: z.string().min(3).max(200),
  category: z.enum(['contest', 'remote_contest', 'activity', 'contribution', 'service', 'award', 'initial', 'penalty', 'reversal']),
  amount: z.string().regex(/^-?\d+(\.\d+)?$/, '金额为十进制字符串'),
  scoreMonth: z.string().regex(/^\d{4}-\d{2}$/),
  detail: z.record(z.string(), z.unknown()).optional(),
  evidenceRef: z.string().max(500).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
})

@Injectable()
export class ScoringService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ActivityService) private readonly activityService: ActivityService,
    @Inject(ContestStandingsService) private readonly standingsService: ContestStandingsService,
  ) {}

  private async currentRuleVersion(): Promise<{ id: string; params: RuleParams }> {
    const rv = await this.db.ruleVersion.findFirst({ where: { status: 'published' }, orderBy: { version: 'desc' } })
    // 旧版本参数经默认值合并补齐（R01–R13 拍板后的新字段对历史版本同样生效）
    if (rv) return { id: rv.id, params: mergeRuleParams(rv.params) }
    const fallback = await this.db.ruleVersion.findFirst({ orderBy: { version: 'desc' } })
    if (fallback) return { id: fallback.id, params: mergeRuleParams(fallback.params) }
    return { id: 'default', params: defaultRuleParams() }
  }

  /** λ 档来源：公告指定 → 指定比赛目录按标题匹配 → 默认乙类 */
  async resolveLambda(platform: string, title: string, announced?: string | null): Promise<{ lambdaKey: LambdaKey; lambdaSource: string }> {
    if (announced === 'A' || announced === 'B' || announced === 'C') return { lambdaKey: announced, lambdaSource: '活动公告' }
    const catalog = await this.db.designatedContest.findMany({
      where: { status: 'active', platform, lambdaKey: { not: null } },
    })
    const lowered = title.toLowerCase()
    const matched = catalog.find((entry) =>
      entry.name
        .split(/[/（）()、,，]+/)
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token.length >= 3)
        .some((token) => lowered.includes(token)),
    )
    if (matched?.lambdaKey === 'A' || matched?.lambdaKey === 'B' || matched?.lambdaKey === 'C') {
      return { lambdaKey: matched.lambdaKey, lambdaSource: `指定目录（${matched.name}）` }
    }
    return { lambdaKey: 'B', lambdaSource: '默认乙类（未匹配公告与目录，可复核后重跑）' }
  }

  /**
   * 平台赛积分结算引擎：活动结束 5 分钟后触发（管理端按钮或调度器）。
   * - λ 来源：活动公告 scoringConfig.lambdaKey → 指定目录匹配（附录一系数）→ 默认乙类；
   * - 有效提交（R04）由引擎从平台榜单自动判定：有通过/得分/失败提交痕迹即有效；
   * - W = B + λ(4S + 6R) + X；远程 0.5×[...]，上限常规 20 / specialCap，远程减半；
   * - 到场 = IN 检查点（含人工复核补签）；缺到场/无提交 → skipped 转人工窗口；
   * - 入账幂等（sourceKey 含 userId），成员端活动详情与积分同步展示。
   */
  async settleContestScores(actor: SessionActor | null, activityId: string): Promise<{
    posted: number
    deduplicated: number
    skipped: Array<{ name: string; reason: string }>
    lambda: { key: string; source: string }
    cap: number
    validCount: number
  }> {
    const activity = await this.db.activity.findUnique({
      where: { id: activityId },
      select: { id: true, title: true, platform: true, platformContestId: true, endAt: true, scoringConfig: true },
    })
    if (!activity) throw new ScoringError('活动不存在', 'NOT_FOUND')
    if (!activity.platform || !activity.platformContestId) throw new ScoringError('本活动未关联平台赛事', 'NOT_CONTEST')
    if (activity.endAt.getTime() + 5 * 60_000 > Date.now()) {
      throw new ScoringError('比赛结束后有 5 分钟数据同步处理窗口，请稍后再试', 'PROCESSING_WINDOW')
    }
    const { activity: _a, contestUrl, result, clubRows, problems, totalEntries } =
      await this.activityService.platformClubRows(activityId, this.standingsService)
    void _a
    if (!result.available) {
      throw new ScoringError(`平台榜单暂不可用：${result.reason}${contestUrl ? `（可稍后重试或前往 ${contestUrl} 核对）` : ''}`, 'STANDINGS_UNAVAILABLE')
    }

    // λ：公告 → 指定目录 → 默认乙类
    const config = (activity.scoringConfig ?? {}) as { lambdaKey?: string; specialCap?: number }
    const { lambdaKey, lambdaSource } = await this.resolveLambda(activity.platform, activity.title, config.lambdaKey)
    const cap = Math.min(config.specialCap ?? 20, 25)

    // 有效提交（R04 引擎自动判定）与社团内排名
    const valid = clubRows.filter(hasValidSubmission)
    const rankOf = new Map(valid.map((row, index) => [row.userId, index + 1]))
    const totalProblems = problems.length
    const fullTotal = problems.reduce((sum, problem) => sum + (problem.fullScore ?? 0), 0)

    // 到场 / 远程事实
    const [checkpoints, remotes, presence] = await Promise.all([
      this.db.attendanceCheckpoint.findMany({ where: { activityId, checkpoint: 'IN' }, select: { userId: true } }),
      this.db.remotePermission.findMany({ where: { activityId, status: 'approved' }, select: { userId: true } }),
      this.db.attendanceAttendanceResult.findMany({
        where: { activityId, status: { in: ['ontime', 'late', 'early_leave', 'late_and_early'] } },
        select: { userId: true },
      }),
    ])
    const onsiteSet = new Set([...checkpoints, ...presence].map((row) => row.userId))
    const remoteSet = new Set(remotes.map((row) => row.userId))

    const skipped: Array<{ name: string; reason: string }> = []
    let posted = 0
    let deduplicated = 0
    for (const row of valid) {
      const isRemote = remoteSet.has(row.userId) && !onsiteSet.has(row.userId)
      if (!onsiteSet.has(row.userId) && !isRemote) {
        skipped.push({ name: row.name, reason: '榜上有提交但无到场记录（未扫码且未人工复核），转人工窗口' })
        continue
      }
      const formula = computeContestW({
        solvedCount: row.solvedCount,
        score: row.score,
        platformRank: row.platformRank,
        clubRank: rankOf.get(row.userId)!,
        validCount: valid.length,
        totalProblems,
        fullTotal,
        totalEntries,
        lambdaKey,
        remote: isRemote,
        cap,
      })
      const outcome = await this.postLedgerEntry(actor, {
        userId: row.userId,
        sourceKey: `contest:${activity.platform}:${activity.platformContestId}:W:${row.userId}`,
        category: isRemote ? 'remote_contest' : 'contest',
        amount: formula.W.toFixed(2),
        scoreMonth: monthKey(activity.endAt),
        detail: {
          activityId,
          activityTitle: activity.title,
          formula: { B: formula.B, lambda: formula.lambda, lambdaKey, S: formula.S, R: formula.R, X: formula.X, W: formula.W },
          lambdaSource,
          note: '平台赛结算引擎自动入账（有效提交由榜单自动核验）',
        },
      })
      if (outcome.deduplicated) deduplicated++
      else posted++
    }
    // 榜上无提交的绑定成员：仅出勤，不发竞赛分（不报错，列入说明）
    for (const row of clubRows) {
      if (!valid.includes(row)) skipped.push({ name: row.name, reason: '榜上无有效提交（仅记出勤，不发竞赛分）' })
    }
    return { posted, deduplicated, skipped, lambda: { key: lambdaKey, source: lambdaSource }, cap, validCount: valid.length }
  }

  /**
   * 积分入账（审核通过后调用）：幂等（source_key 唯一 approved + idempotencyKey）；
   * 同来源重复入账直接返回原记录；不可静默覆盖。
   */
  /** 批量手动入账：粘贴/导入行（学号+分数+备注），逐行解析成员并按批次幂等入账 */
  async batchPostEntries(
    actor: SessionActor,
    input: {
      rows: Array<{ studentNo: string; amount: string; note?: string }>;
      category: string;
      activityId?: string;
      scoreMonth?: string;
    },
  ): Promise<{
    batchId: string;
    scoreMonth: string;
    posted: number;
    deduplicated: number;
    failed: Array<{ studentNo: string; error: string }>;
  }> {
    const scoreMonth = input.scoreMonth ?? monthKey(new Date())
    let activityTitle: string | null = null
    if (input.activityId) {
      const activity = await this.db.activity.findUnique({ where: { id: input.activityId }, select: { title: true } })
      if (!activity) throw new ScoringError('关联活动不存在', 'NOT_FOUND')
      activityTitle = activity.title
    }
    const batchId = newId()
    const failed: Array<{ studentNo: string; error: string }> = []
    let posted = 0
    let deduplicated = 0
    for (const row of input.rows) {
      const user = await this.db.user.findUnique({ where: { studentNo: row.studentNo }, select: { id: true } })
      if (!user) {
        failed.push({ studentNo: row.studentNo, error: '成员不存在（学号未注册）' })
        continue
      }
      try {
        const result = await this.postLedgerEntry(actor, {
          userId: user.id,
          sourceKey: `manual:${batchId}:${user.id}`,
          category: input.category as never,
          amount: row.amount,
          scoreMonth,
          detail: { note: row.note ?? null, activityId: input.activityId ?? null, activityTitle, batchId },
        })
        if (result.deduplicated) deduplicated++
        else posted++
      } catch (error) {
        failed.push({ studentNo: row.studentNo, error: error instanceof Error ? error.message : '入账失败' })
      }
    }
    return { batchId, scoreMonth, posted, deduplicated, failed }
  }

  async postLedgerEntry(actor: SessionActor | null, input: z.infer<typeof ledgerEntrySchema>): Promise<{ entryId: string; deduplicated: boolean }> {
    const rule = await this.currentRuleVersion()
    const existing = await this.db.pointsLedgerEntry.findFirst({ where: { sourceKey: input.sourceKey, status: 'approved' } })
    if (existing) {
      return { entryId: existing.id, deduplicated: true }
    }
    const id = newId()
    await this.db.pointsLedgerEntry.create({
      data: {
        id,
        userId: input.userId,
        sourceKey: input.sourceKey,
        category: input.category,
        amount: input.amount,
        scoreMonth: input.scoreMonth,
        recordedAt: new Date(),
        status: 'approved',
        ruleVersionId: rule.id === 'default' ? undefined : rule.id,
        detail: (input.detail ?? undefined) as never,
        evidenceRef: input.evidenceRef,
        approvedBy: actor?.principalId ?? null,
        idempotencyKey: input.idempotencyKey ?? `src:${input.sourceKey}`,
      },
    })
    await this.audit.log({
      actorPrincipalId: actor?.principalId,
      action: 'points.post',
      resourceType: 'points_ledger',
      resourceId: id,
      summary: `${input.category} ${input.amount}（${input.scoreMonth}，来源 ${input.sourceKey}）`,
    })
    return { entryId: id, deduplicated: false }
  }

  /** 冲正 + 替代（一个事务；保留原记录与依据） */
  async reverseEntry(
    actor: SessionActor,
    entryId: string,
    reason: string,
    replacementAmount: string | null,
  ): Promise<{ reversalId: string; replacementId: string | null }> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM points_ledger WHERE id = ${entryId}::uuid FOR UPDATE`
      const original = await tx.pointsLedgerEntry.findUnique({ where: { id: entryId } })
      if (!original) throw new ScoringError('原始记录不存在', 'NOT_FOUND')
      if (original.status !== 'approved') throw new ScoringError('仅生效记录可冲正', 'STATE_INVALID')
      const reversalId = newId()
      await tx.pointsLedgerEntry.create({
        data: {
          id: reversalId,
          userId: original.userId,
          sourceKey: `${original.sourceKey}:reversal:${Date.now()}`,
          category: 'reversal',
          amount: original.amount.neg().toFixed(10),
          scoreMonth: original.scoreMonth,
          recordedAt: new Date(),
          status: 'approved',
          ruleVersionId: original.ruleVersionId,
          detail: { reason, originalEntryId: entryId } as never,
          reversesEntryId: entryId,
          reversalReason: reason,
          approvedBy: actor.principalId,
          idempotencyKey: `reversal:${entryId}`,
        },
      })
      await tx.pointsLedgerEntry.update({
        where: { id: entryId },
        data: { status: 'reversed', reversalReason: reason },
      })
      let replacementId: string | null = null
      if (replacementAmount != null) {
        replacementId = newId()
        await tx.pointsLedgerEntry.create({
          data: {
            id: replacementId,
            userId: original.userId,
            sourceKey: `${original.sourceKey}:replacement:${Date.now()}`,
            category: original.category,
            amount: replacementAmount,
            scoreMonth: original.scoreMonth,
            recordedAt: new Date(),
            status: 'approved',
            ruleVersionId: original.ruleVersionId,
            detail: { reason, replacesEntryId: entryId } as never,
            approvedBy: actor.principalId,
            idempotencyKey: `replacement:${entryId}:${replacementAmount}`,
          },
        })
        await tx.pointsLedgerEntry.update({
          where: { id: entryId },
          data: { replacedByEntryId: replacementId },
        })
      }
      await tx.auditLog.create({
        data: {
          id: newId(),
          actorPrincipalId: actor.principalId,
          action: 'points.reverse',
          resourceType: 'points_ledger',
          resourceId: entryId,
          summary: `冲正 ${original.amount}（${reason}）${replacementAmount != null ? `，替代 ${replacementAmount}` : ''}`,
        },
      })
      return { reversalId, replacementId }
    })
  }

  /** 本人流水（含冲正历史） */
  async myLedger(userId: string, filters: { month?: string; cursor?: string }) {
    const rows = await this.db.pointsLedgerEntry.findMany({
      where: {
        userId,
        ...(filters.month ? { scoreMonth: filters.month } : {}),
      },
      orderBy: { recordedAt: 'desc' },
      take: 26,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    })
    const nextCursor = rows.length > 25 ? rows.pop()!.id : undefined
    return { items: rows, nextCursor }
  }

  /** 月度汇总 + E（预览；按当前规则版本） */
  async myScoreOverview(userId: string, currentMonth: string) {
    const entries = await this.db.pointsLedgerEntry.findMany({
      where: { userId, status: 'approved' },
      select: { amount: true, scoreMonth: true, category: true },
    })
    const monthlyRaw = new Map<string, number>()
    for (const e of entries) {
      monthlyRaw.set(e.scoreMonth, (monthlyRaw.get(e.scoreMonth) ?? 0) + Number(e.amount))
    }
    const monthlyScores: Record<string, number> = {}
    for (const [k, v] of monthlyRaw) monthlyScores[k] = Math.round(v * 1e6) / 1e6
    const rule = await this.currentRuleVersion()
    const effective = computeEffectiveScore({ monthlyScores, currentMonth }, { effectiveWeights: rule.params.effectiveWeights ?? [1, 0.85, 0.7, 0.55, 0.4, 0.25] })
    const sixMonths: Array<{ month: string; raw: number; m: number | null }> = effective.windowMonths.map((month) => ({
      month,
      raw: monthlyScores[month] ?? 0,
      m: null, // 正式 M 依 R01 取整策略确认
    }))
    return {
      e: effective.eDisplay,
      eComponents: effective.components.map((c) => ({ month: c.month, m: Number(c.m), weight: Number(c.weight), contribution: Number(c.contribution) }),
      ),
      months: sixMonths,
      roundingPending: rule.params.monthlyRounding === 'pending',
      roundingNote: rule.params.monthlyRounding === 'pending' ? RULE_GAPS.R01 : null,
    }
  }

  /**
   * 生成月度结算批次（预览）：分类上限→负分→rawTotal；R01 未决不发布正式 M。
   * 按成员+月锁结算范围（02 方案 6.3：防两个审核同时绕过月上限）。
   */
  async buildMonthlyBatch(actor: SessionActor, month: string): Promise<{ batchId: string; blocked: boolean; blockedReason?: string; users: number }> {
    const rule = await this.currentRuleVersion()
    const batchId = newId()
    const entries = await this.db.pointsLedgerEntry.findMany({
      where: { scoreMonth: month, status: 'approved' },
      select: { userId: true, category: true, amount: true },
    })
    const byUser = new Map<string, Array<{ category: string; amount: number }>>()
    for (const e of entries) {
      if (!byUser.has(e.userId)) byUser.set(e.userId, [])
      byUser.get(e.userId)!.push({ category: e.category, amount: Number(e.amount) })
    }
    const capMap: Record<string, 'participation_service' | 'teaching_contribution' | 'contest'> = {
      activity: 'participation_service', service: 'participation_service', contribution: 'teaching_contribution',
      contest: 'contest', remote_contest: 'contest', award: 'contest', initial: 'contest', penalty: 'participation_service', reversal: 'participation_service',
    }
    let blocked = false
    let blockedReason: string | undefined
    await this.db.$transaction(async (tx) => {
      await tx.calculationBatch.create({
        data: { id: batchId, monthKey: month, ruleVersionId: rule.id === 'default' ? undefined : rule.id, status: 'preview', createdBy: actor.principalId },
      })
      for (const [userId, userEntries] of byUser) {
        const positive = userEntries.filter((e) => e.amount > 0).map((e) => ({ category: capMap[e.category] ?? 'contest', amount: e.amount }))
        const negative = userEntries.filter((e) => e.amount < 0).map((e) => ({ category: e.category, amount: e.amount }))
        const result = rollupMonthly({ positiveEntries: positive, negativeEntries: negative, params: rule.params }, rule.params)
        if (result.blockedReason) {
          blocked = true
          blockedReason = result.blockedReason
        }
        await tx.monthlyScore.upsert({
          where: { userId_scoreMonth_revision: { userId, scoreMonth: month, revision: 1 } },
          create: {
            id: newId(), userId, scoreMonth: month, rawTotal: result.rawTotal.toFixed(10),
            m: result.m, roundingPolicy: result.roundingPolicy,
            categoryCaps: { adjusted: result.adjusted.map((a) => ({ category: a.category, original: Number(a.original), allowed: Number(a.allowed), capped: a.capped })) } as never,
            batchId, status: 'draft',
          },
          update: {},
        })
      }
    })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'scoring.batch_preview',
      resourceType: 'calculation_batch',
      resourceId: batchId,
      summary: `月度结算预览 ${month}（${byUser.size} 人）${blocked ? '；正式发布被 R01 阻塞' : ''}`,
    })
    return { batchId, blocked, blockedReason, users: byUser.size }
  }

  /** 发布月度公示（≥48h；发布后写 disclosure_rows 快照；冻结当前 revision） */
  /** 公示批次管理：提前结束 / 删除（删除连同快照行，保留审计） */
  async closeDisclosure(actor: SessionActor, disclosureId: string): Promise<void> {
    const disclosure = await this.db.disclosure.findUnique({ where: { id: disclosureId } })
    if (!disclosure) throw new ScoringError('公示批次不存在', 'NOT_FOUND')
    if (disclosure.status !== 'published') throw new ScoringError('该批次不在公示中', 'STATE_INVALID')
    await this.db.disclosure.update({ where: { id: disclosureId }, data: { status: 'closed', endsAt: new Date() } })
    await this.audit.log({ actorPrincipalId: actor.principalId, action: 'disclosure.close', resourceType: 'disclosure', resourceId: disclosureId, summary: `提前结束 ${disclosure.monthKey} 月度公示` })
  }

  async deleteDisclosure(actor: SessionActor, disclosureId: string): Promise<void> {
    const disclosure = await this.db.disclosure.findUnique({ where: { id: disclosureId } })
    if (!disclosure) throw new ScoringError('公示批次不存在', 'NOT_FOUND')
    await this.db.$transaction(async (tx) => {
      await tx.disclosureRow.deleteMany({ where: { disclosureId } })
      await tx.disclosure.delete({ where: { id: disclosureId } })
    })
    await this.audit.log({ actorPrincipalId: actor.principalId, action: 'disclosure.delete', resourceType: 'disclosure', resourceId: disclosureId, summary: `删除 ${disclosure.monthKey} 月度公示批次（含快照行）` })
  }

  async publishMonthlyDisclosure(actor: SessionActor, month: string, startsAt: Date, endsAt: Date): Promise<{ disclosureId: string }> {
    if (endsAt.getTime() - startsAt.getTime() < 48 * 3600_000) {
      throw new ScoringError('公示期原则上至少 48 小时', 'DISCLOSURE_TOO_SHORT')
    }
    const rule = await this.currentRuleVersion()
    const rows = await this.db.pointsLedgerEntry.findMany({
      where: { scoreMonth: month, status: 'approved' },
      select: { userId: true, amount: true },
    })
    const byUser = new Map<string, number>()
    for (const r of rows) byUser.set(r.userId, (byUser.get(r.userId) ?? 0) + Number(r.amount))
    const users = await this.db.user.findMany({
      where: { id: { in: [...byUser.keys()] } },
      include: { profile: { select: { displayName: true } }, membershipTerms: { orderBy: { createdAt: 'desc' }, take: 1 }, principal: true },
    })
    const currentMonth = monthKey(new Date())
    const sorted = users
      .map((u) => {
        const effective = computeEffectiveScore({ monthlyScores: Object.fromEntries([...byUser].map(([k, v]) => [k, v])), currentMonth }, { effectiveWeights: rule.params.effectiveWeights ?? [1, 0.85, 0.7, 0.55, 0.4, 0.25] })
        return { user: u, monthAdded: byUser.get(u.id) ?? 0, e: Number(effective.e) }
      })
      .sort((a, b) => b.e - a.e)
    const disclosureId = newId()
    await this.db.$transaction(async (tx) => {
      await tx.disclosure.create({
        data: {
          id: disclosureId, type: 'monthly', monthKey: month, scope: 'all_members',
          status: 'published', startsAt, endsAt,
          ruleVersionId: rule.id === 'default' ? undefined : rule.id,
          publishedBy: actor.principalId, publishedAt: new Date(),
        },
      })
      let rank = 0
      for (const row of sorted) {
        rank++
        await tx.disclosureRow.create({
          data: {
            id: newId(), disclosureId, userId: row.user.id, rank,
            displayName: memberName(row.user),
            studentNo: row.user.studentNo, grade: row.user.grade,
            membership: row.user.membershipTerms[0]?.membershipStatus ?? 'unknown',
            lastMonthE: (row.e - row.monthAdded).toFixed(4),
            monthAdded: row.monthAdded.toFixed(4),
            deductions: Math.min(0, 0).toFixed(4),
            currentE: row.e.toFixed(4),
          },
        })
      }
      await tx.auditLog.create({
        data: {
          id: newId(), actorPrincipalId: actor.principalId,
          action: 'disclosure.publish', resourceType: 'disclosure', resourceId: disclosureId,
          summary: `发布月度公示 ${month}（${sorted.length} 行，${startsAt.toISOString()} ~ ${endsAt.toISOString()}）`,
        },
      })
    })
    return { disclosureId }
  }

  /** 榜单：当前有效榜 / 公示快照 */
  async leaderboard(kind: 'current' | 'disclosure', refId: string | undefined, viewerUserId: string | null) {
    if (kind === 'current') {
      // 口径与首页「当前有效榜排名」同源：全集是在册正式/预备/考察成员，E=0 的成员同样在榜
      const rule = await this.currentRuleVersion()
      const ranked = await rankEligibleMembers(this.db, monthKey(new Date()), rule.params.effectiveWeights)
      return {
        kind,
        revision: null,
        frozenAt: null,
        ruleVersion: null,
        rows: ranked.map((r, i) => ({
          rank: i + 1,
          userId: r.userId,
          displayName: r.displayName,
          membership: r.membership,
          e: r.eDisplay,
          isMe: r.userId === viewerUserId,
        })),
      }
    }
    if (kind === 'disclosure' && refId) {
      const d = await this.db.disclosure.findUnique({ where: { id: refId }, include: { rows: { orderBy: { rank: 'asc' } } } })
      if (!d) throw new ScoringError('公示不存在', 'NOT_FOUND')
      return {
        kind,
        monthKey: d.monthKey,
        startsAt: d.startsAt?.toISOString() ?? null,
        endsAt: d.endsAt?.toISOString() ?? null,
        ruleVersionId: d.ruleVersionId,
        rows: d.rows.map((r) => ({ rank: r.rank, userId: r.userId, displayName: r.displayName, studentNo: r.studentNo, membership: r.membership, currentE: Number(r.currentE).toFixed(1), monthAdded: Number(r.monthAdded).toFixed(1), isMe: r.userId === viewerUserId })),
      }
    }
    throw new ScoringError('缺少榜单引用', 'REF_MISSING')
  }

  /** 申诉（公示版本引用固定 revision） */
  async submitAppeal(userId: string, input: { disclosureId?: string; ledgerEntryId?: string; subject: string; materials?: string }): Promise<{ appealId: string }> {
    const id = newId()
    await this.db.appeal.create({
      data: {
        id, userId,
        disclosureId: input.disclosureId,
        ledgerEntryId: input.ledgerEntryId,
        subject: input.subject,
        materials: input.materials,
      },
    })
    return { appealId: id }
  }

  /** 贡献/成果申报 */
  async submitClaim(userId: string, input: { category: string; title: string; description: string; activityId?: string; contestKey?: string; evidenceNote?: string; evidenceAssetIds?: string[] }): Promise<{ claimId: string }> {
    const assetIds = input.evidenceAssetIds ?? []
    if (new Set(assetIds).size !== assetIds.length) {
      throw new ScoringError('佐证图重复', 'INVALID_INPUT')
    }
    if (assetIds.length > 0) {
      // 仅接受本人上传、处理完成且尚未被其它申报占用的佐证图
      const usable = await this.db.mediaAsset.count({
        where: {
          id: { in: assetIds },
          ownerUserId: userId,
          purpose: 'evidence',
          status: 'ready',
          claimLink: { is: null },
        },
      })
      if (usable !== assetIds.length) {
        throw new ScoringError('佐证图无效或已被其它申报引用，请重新上传', 'INVALID_INPUT')
      }
    }
    const id = newId()
    await this.db.pointsClaim.create({
      data: {
        id, userId,
        category: input.category,
        title: input.title,
        description: input.description,
        activityId: input.activityId,
        contestKey: input.contestKey,
        evidenceNote: input.evidenceNote,
        scoreMonth: monthKey(new Date()),
        assets: {
          create: assetIds.map((assetId, index) => ({ id: newId(), assetId, sortOrder: index })),
        },
      },
    })
    return { claimId: id }
  }

  /** 审核复核案件：单人裁决即结案（通过 / 驳回），more_info 只记录意见不结案 */
  async voteOnCase(actor: SessionActor, caseId: string, verdict: 'approve' | 'reject' | 'more_info', reason: string): Promise<{ resolved: boolean; approvals: number }> {
    const reviewCase = await this.db.reviewCase.findUnique({ where: { id: caseId } })
    if (!reviewCase) throw new ScoringError('案件不存在', 'NOT_FOUND')
    await this.db.reviewVote.create({
      data: { id: newId(), caseId, reviewerId: actor.principalId, verdict, reason },
    })
    if (verdict === 'more_info') return { resolved: false, approvals: 0 }
    await this.db.reviewCase.update({
      where: { id: caseId },
      data: { status: verdict === 'approve' ? 'resolved' : 'rejected', closedAt: new Date() },
    })
    return { resolved: true, approvals: verdict === 'approve' ? 1 : 0 }
  }

  /** sourceKey 组装便捷方法（供 worker/审核使用） */
  sourceKey(parts: SourceKeyParts): string {
    return buildSourceKey(parts)
  }

  monthNow(): string {
    return monthKey(new Date())
  }

  monthPlus(delta: number): string {
    return monthKeyPlus(monthKey(new Date()), delta)
  }
}

/** 存库规则参数与当前默认值浅合并后经 zod 校验（补齐 R01–R13 拍板新增字段） */

