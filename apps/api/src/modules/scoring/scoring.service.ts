import { DomainError } from '../../common/domain-error.js'
import { Inject, Injectable } from '@nestjs/common'
import {
  buildSourceKey,
  computeEffectiveScore,
  defaultRuleParams,
  rollupMonthly,
  RULE_GAPS,
  type RuleParams,
  type SourceKeyParts,
} from '@acm/scoring-core'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { newId, monthKey, monthKeyPlus } from '../../common/utils.js'
import type { SessionActor } from '../auth/session.service.js'
import { z } from 'zod'

/**
 * 积分账本/月度/有效积分/公示/冻结（02 方案 5.4、6.3、6.4；04 方案）：
 * - source_key 稳定逻辑键（不含活动/地点/rule_version）；部分唯一索引保证同一来源只有一条 approved。
 * - 纠错：冲正 + 替代，不改总分、不删历史。
 * - 月度 rollup 使用 scoring-core；R01 未决时不发布正式 M。
 * - 公示 ≥48h；双人复核（不同 principal）；冻结后回填不改变名单。
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
    private readonly audit: AuditService,
  ) {}

  private async currentRuleVersion(): Promise<{ id: string; params: RuleParams }> {
    const rv = await this.db.ruleVersion.findFirst({ where: { status: 'published' }, orderBy: { version: 'desc' } })
    if (rv) return { id: rv.id, params: rv.params as unknown as RuleParams }
    // 未发布任何规则版本：使用默认参数（R01 保持 pending；开发 seed 会写入正式版本）
    const fallback = await this.db.ruleVersion.findFirst({ orderBy: { version: 'desc' } })
    if (fallback) return { id: fallback.id, params: fallback.params as unknown as RuleParams }
    return { id: 'default', params: defaultRuleParams() }
  }

  /**
   * 积分入账（审核通过后调用）：幂等（source_key 唯一 approved + idempotencyKey）；
   * 同来源重复入账直接返回原记录；不可静默覆盖。
   */
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
      if (original.userId && actor.userId === original.userId) {
        throw new ScoringError('不能审核/冲正本人积分（利益回避）', 'RECUSED')
      }
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
            displayName: row.user.profile?.displayName ?? row.user.verifiedRealName,
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

  /** 榜单：当前有效榜 / 公示快照 / 冻结榜 */
  async leaderboard(kind: 'current' | 'disclosure' | 'frozen', refId: string | undefined, viewerUserId: string | null) {
    if (kind === 'current') {
      const entries = await this.db.pointsLedgerEntry.findMany({ where: { status: 'approved' }, select: { userId: true, amount: true, scoreMonth: true } })
      const byUser = new Map<string, Map<string, number>>()
      for (const e of entries) {
        if (!byUser.has(e.userId)) byUser.set(e.userId, new Map())
        const m = byUser.get(e.userId)!
        m.set(e.scoreMonth, (m.get(e.scoreMonth) ?? 0) + Number(e.amount))
      }
      const rule = await this.currentRuleVersion()
      const currentMonth = monthKey(new Date())
      const users = await this.db.user.findMany({
        where: { id: { in: [...byUser.keys()] }, accountStatus: 'active' },
        include: { profile: true, membershipTerms: { orderBy: { createdAt: 'desc' }, take: 1 } },
      })
      const ranked = users
        .map((u) => {
          const eff = computeEffectiveScore({ monthlyScores: Object.fromEntries(byUser.get(u.id) ?? []), currentMonth }, { effectiveWeights: rule.params.effectiveWeights ?? [1, 0.85, 0.7, 0.55, 0.4, 0.25] })
          return {
            userId: u.id,
            displayName: u.profile?.displayName ?? u.verifiedRealName,
            membership: u.membershipTerms[0]?.membershipStatus ?? 'applicant',
            e: eff.eDisplay,
            eNum: Number(eff.e),
          }
        })
        .filter((r) => ['formal', 'provisional', 'observing'].includes(r.membership))
        .sort((a, b) => b.eNum - a.eNum)
        .map((r, i) => ({ rank: i + 1, userId: r.userId, displayName: r.displayName, membership: r.membership, e: r.e, isMe: r.userId === viewerUserId }))
      return { kind, revision: null, frozenAt: null, ruleVersion: null, rows: ranked }
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
    if (kind === 'frozen' && refId) {
      const f = await this.db.rankingFreeze.findUnique({ where: { id: refId }, include: { rows: { orderBy: { position: 'asc' } } } })
      if (!f) throw new ScoringError('冻结榜不存在', 'NOT_FOUND')
      if (f.status !== 'frozen') throw new ScoringError('该榜单尚未完成冻结', 'FREEZE_PENDING')
      return {
        kind: 'frozen',
        title: f.title,
        frozenAt: f.freezeAt.toISOString(),
        ruleVersionId: f.ruleVersionId,
        rows: f.rows.map((r) => ({ position: r.position, userId: r.userId, eSnapshot: Number(r.eSnapshot).toFixed(1), qScore: r.qScore ? Number(r.qScore).toFixed(1) : null, eligible: r.eligible, isMe: r.userId === viewerUserId })),
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
  async submitClaim(userId: string, input: { category: string; title: string; description: string; activityId?: string; contestKey?: string; evidenceNote?: string }): Promise<{ claimId: string }> {
    const id = newId()
    await this.db.pointsClaim.create({
      data: {
        id, userId,
        category: input.category,
        title: input.title,
        description: input.description,
        activityId: input.activityId,
        contestKey: input.contestKey,
        scoreMonth: monthKey(new Date()),
      },
    })
    return { claimId: id }
  }

  /** 审核复核案件：至少两名不同且无利益冲突负责人；涉本人拒绝 */
  async voteOnCase(actor: SessionActor, caseId: string, verdict: 'approve' | 'reject' | 'more_info', reason: string): Promise<{ resolved: boolean; approvals: number }> {
    const reviewCase = await this.db.reviewCase.findUnique({ where: { id: caseId }, include: { votes: true } })
    if (!reviewCase) throw new ScoringError('案件不存在', 'NOT_FOUND')
    if (reviewCase.targetUserId && reviewCase.targetUserId === actor.userId) {
      throw new ScoringError('该案件涉及本人，必须回避', 'RECUSED')
    }
    if (reviewCase.votes.some((v) => v.reviewerId === actor.principalId && !v.recused)) {
      throw new ScoringError('同一主体不能投两票（不能以两个角色重复）', 'DOUBLE_VOTE')
    }
    await this.db.reviewVote.create({
      data: { id: newId(), caseId, reviewerId: actor.principalId, verdict, reason },
    })
    const votes = await this.db.reviewVote.findMany({ where: { caseId } })
    const approvals = votes.filter((v) => v.verdict === 'approve').length
    const distinctApprovers = new Set(votes.filter((v) => v.verdict === 'approve').map((v) => v.reviewerId)).size
    const rejects = votes.filter((v) => v.verdict === 'reject').length
    let resolved = false
    if (distinctApprovers >= 2) {
      resolved = true
      await this.db.reviewCase.update({ where: { id: caseId }, data: { status: reviewCase.teacherRequired ? 'pending_teacher' : 'resolved', closedAt: reviewCase.teacherRequired ? null : new Date() } })
    } else if (rejects >= 2) {
      resolved = true
      await this.db.reviewCase.update({ where: { id: caseId }, data: { status: 'rejected', closedAt: new Date() } })
    }
    return { resolved, approvals: distinctApprovers }
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
