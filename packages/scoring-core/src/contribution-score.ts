import { Decimal } from 'decimal.js'
import type { RuleParams, ScoreOutcome } from './rule-params.js'

/**
 * 讲题/题解/分享/出题贡献（附录二第五节）。
 * 满意度 V：优 ≥90% → 1.2；80–<90% → 1.0；70–<80% → 0.8；60–<70% → 0.5；<60% → 0。
 * V 的分子分母与有效投票门槛属 R06：投票人数不足时 pending，不猜 V。
 * 月分类上限：讲题+题解+分享+出题合计 20/月；参会+工作人员+一般服务合计 12/月。
 */

export function satisfactionMultiplier(votesFor: number, votesTotal: number): ScoreOutcome<Decimal> {
  if (votesTotal <= 0) {
    return { status: 'pending', pendingReason: '无有效投票（R06：投票门槛未确认）', gap: 'R06', decisions: [] }
  }
  const pct = new Decimal(votesFor).div(votesTotal).mul(100)
  let v: Decimal
  if (pct.gte(90)) v = new Decimal(1.2)
  else if (pct.gte(80)) v = new Decimal(1.0)
  else if (pct.gte(70)) v = new Decimal(0.8)
  else if (pct.gte(60)) v = new Decimal(0.5)
  else v = new Decimal(0)
  return {
    status: 'ok',
    value: v,
    decisions: [{ step: 'V', note: `满意度 ${pct.toFixed(2)}%（${votesFor}/${votesTotal}）→ V=${v}` }],
  }
}

export type TeachingTier = 'basic' | 'intermediate' | 'advanced' // 基础/中档/高档
export type SharingLevel = 'school' | 'college' | 'club' // 校/院/社级

export const TEACHING_BASE: Record<TeachingTier, number> = { basic: 4, intermediate: 6, advanced: 8 }
export const SHARING_BASE: Record<SharingLevel, number> = { school: 8, college: 5, club: 3 }

/** 讲题：同成员同场最多一道题 */
export function lectureScore(tier: TeachingTier, v: Decimal): Decimal {
  return new Decimal(TEACHING_BASE[tier]).mul(v)
}

/** 分享：按等级 × V */
export function sharingScore(level: SharingLevel, v: Decimal): Decimal {
  return new Decimal(SHARING_BASE[level]).mul(v)
}

/** 题解：2/题，同场上限 4；原创且含证明/复杂度/代码由审核把关 */
export function solutionScore(problems: number): { total: Decimal; note: string } {
  const capped = Math.min(problems, 2) // 2 分/题 × 上限 4 分 = 2 题
  return { total: new Decimal(capped).mul(2), note: `题解 ${problems} 题，同场上限 2 题共 4 分` }
}

/** 命题：8/题，同场同成员最多两题 */
export function problemSettingScore(problems: number): { total: Decimal; note: string } {
  const capped = Math.min(problems, 2)
  return { total: new Decimal(capped).mul(8), note: `命题 ${problems} 题，同场同成员上限 2 题` }
}

/**
 * 月分类上限：对“已核验事实”的原始得分重新计算（不能把 ledger 正数相加后截断）。
 * 返回截断明细供审核。负分（扣分）不受正向上限影响。
 */
export interface MonthlyCapInput {
  /** 本月事实化的正分条目（category: participation_service | teaching_contribution | contest） */
  positiveEntries: Array<{ category: 'participation_service' | 'teaching_contribution' | 'contest'; amount: number | Decimal }>
  params: Pick<RuleParams, 'monthlyCapParticipationService' | 'monthlyCapTeachingContribution'>
}

export interface MonthlyCapResult {
  adjusted: Array<{ category: string; original: Decimal; allowed: Decimal; cap: Decimal | null; capped: boolean }>
  totals: { participation_service: Decimal; teaching_contribution: Decimal; contest: Decimal }
}

export function applyMonthlyCaps(input: MonthlyCapInput): MonthlyCapResult {
  const sum = (cat: MonthlyCapInput['positiveEntries'][number]['category']) =>
    input.positiveEntries.filter((e) => e.category === cat).reduce((acc, e) => acc.plus(new Decimal(e.amount)), new Decimal(0))
  const build = (cat: MonthlyCapInput['positiveEntries'][number]['category'], cap: number | null) => {
    const original = sum(cat)
    const allowed = cap == null ? original : Decimal.min(original, new Decimal(cap))
    return { category: cat, original, allowed, cap: cap == null ? null : new Decimal(cap), capped: allowed.lt(original) }
  }
  const ps = build('participation_service', input.params.monthlyCapParticipationService)
  const tc = build('teaching_contribution', input.params.monthlyCapTeachingContribution)
  const ct = build('contest', null) // 正式竞赛与指定周月赛不设月总上限，单场限制在场次计算时执行
  return {
    adjusted: [ps, tc, ct],
    totals: {
      participation_service: ps.allowed,
      teaching_contribution: tc.allowed,
      contest: ct.allowed,
    },
  }
}
