import { Decimal } from 'decimal.js'
import type { RuleParams } from './rule-params.js'
import { applyMonthlyCaps, type MonthlyCapInput, type MonthlyCapResult } from './contribution-score.js'

/**
 * 月度汇总与取整（R01）。
 * 账本保留精确原分；月度 M 必须为整数，但取整策略（逐项/月末、四舍五入）未确认前：
 * 只能生成预览（rawTotal），正式发布被阻塞。负分不设零下限，进入对应月份。
 */

export interface MonthlyRollupInput extends MonthlyCapInput {
  /** 本月负分（扣分/冲正负项），不受正向上限影响 */
  negativeEntries: Array<{ category: string; amount: number | Decimal }>
}

export interface MonthlyRollupResult extends MonthlyCapResult {
  rawTotal: Decimal
  m: number | null
  roundingPolicy: string
  blockedReason?: string
}

export function rollupMonthly(input: MonthlyRollupInput, params: RuleParams): MonthlyRollupResult {
  const caps = applyMonthlyCaps(input)
  const positive = caps.adjusted.reduce((acc, a) => acc.plus(a.allowed), new Decimal(0))
  const negative = input.negativeEntries.reduce((acc, e) => acc.plus(new Decimal(e.amount)), new Decimal(0))
  const rawTotal = positive.plus(negative)

  if (params.monthlyRounding === 'pending') {
    return {
      ...caps,
      rawTotal,
      m: null,
      roundingPolicy: 'pending',
      blockedReason: 'R01：M 取整策略未确认（逐项/月末、四舍五入口径），仅生成预览，不发布正式 M',
    }
  }
  let m: number
  if (params.monthlyRounding === 'round_half_up') m = rawTotal.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
  else if (params.monthlyRounding === 'floor') m = rawTotal.floor().toNumber()
  else m = rawTotal.ceil().toNumber()
  return { ...caps, rawTotal, m, roundingPolicy: params.monthlyRounding }
}

/**
 * 冲正模型：已入账记录不直接覆盖或删除；纠错在一个事务中写冲正记录（负冲）+ 替代记录，
 * 保留原始时期与计算依据。冲正不是新的纪律扣分。
 */
export interface ReversalRequest {
  originalEntryId: string
  originalAmount: Decimal | number
  reason: string
  replacementAmount?: Decimal | number | null
  scoreMonth: string
}

export interface ReversalPlan {
  reversalEntry: { amount: Decimal; reason: string; reversesEntryId: string }
  replacementEntry: { amount: Decimal | null; reason: string }
}

export function planReversal(req: ReversalRequest): ReversalPlan {
  return {
    reversalEntry: {
      amount: new Decimal(req.originalAmount).neg(),
      reason: `冲正：${req.reason}`,
      reversesEntryId: req.originalEntryId,
    },
    replacementEntry: {
      amount: req.replacementAmount == null ? null : new Decimal(req.replacementAmount),
      reason: `替代记录（原 ${req.originalEntryId}）：${req.reason}`,
    },
  }
}

/**
 * 稳定逻辑来源键（02 方案 5.4 / 03 方案 10）：
 * - 平台赛：contest:{platform}:{externalContestId}:{ruleComponent}
 * - 自定义赛：contest:custom:{localCompetitionId}:{ruleComponent}
 * - 活动服务：activity:{activityId}:{ruleComponent}
 * - 贡献：contribution:{userId}:{claimKey}
 * 键中不含 activity_id（多地点组织平台赛时）、地点或 rule_version。
 */
export type SourceKeyParts =
  | { kind: 'platform_contest'; platform: string; externalContestId: string; component: string }
  | { kind: 'custom_contest'; competitionId: string; component: string }
  | { kind: 'activity'; activityId: string; component: string }
  | { kind: 'contribution'; userId: string; claimKey: string }
  | { kind: 'initial'; userId: string }
  | { kind: 'penalty'; userId: string; incidentKey: string }

export function buildSourceKey(parts: SourceKeyParts): string {
  switch (parts.kind) {
    case 'platform_contest':
      return `contest:${parts.platform}:${parts.externalContestId}:${parts.component}`
    case 'custom_contest':
      return `contest:custom:${parts.competitionId}:${parts.component}`
    case 'activity':
      return `activity:${parts.activityId}:${parts.component}`
    case 'contribution':
      return `contribution:${parts.userId}:${parts.claimKey}`
    case 'initial':
      return `initial:${parts.userId}`
    case 'penalty':
      return `penalty:${parts.userId}:${parts.incidentKey}`
  }
}
