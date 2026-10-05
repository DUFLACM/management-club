import { Decimal } from 'decimal.js'
import type { RuleParams } from './rule-params.js'

/**
 * 综合素质评价建议（附录三）。仅协会内部建议，界面必须写“建议”，
 * 不承诺学院最终加分；资格限制与重复申报（同事项已获其他渠道加分）回避。
 *
 *   H = 0.70×学期有效积分累计标准分 + 0.20×正式竞赛成绩标准分 + 0.10×服务贡献标准分 - 纪律扣减
 *   A 人数 = max(1, round(0.1×N))；B 人数 = round(0.2×N)；C 人数 = N - A - B
 *   A 建议 1.0；B 名次 j：1 - 0.5×(j-1)/max(1, B人数-1)；C：0.5×(1 - (j-1)/max(1, C人数-1))
 *
 * 标准分按百分位折算 0–100；正式赛/服务标准化、并列与零样本口径属 R11。
 */

export interface ComprehensiveInput {
  /** 参与评价的成员（已通过资格与重复申报回避检查） */
  members: Array<{ id: string; semesterE: Decimal | number; contestScore: Decimal | number; serviceScore: Decimal | number }>
  /** 纪律扣减（已认定） */
  disciplineDeductions?: Record<string, Decimal | number>
  params: RuleParams['comprehensiveEval']
  /** R11：标准化/并列细则是否已由公布规则确认 */
  standardizationConfirmed: boolean
}

export interface ComprehensiveOutput {
  status: 'ok' | 'pending'
  pendingReason?: string
  /** 按 H 从高到低排序 */
  ranked: Array<{ id: string; h: Decimal; suggestedGrade: 'A' | 'B' | 'C'; suggestedScore: Decimal }>
  counts: { a: number; b: number; c: number }
}

function percentileRank(sorted: Decimal[], value: Decimal): Decimal {
  // 百分位折算 0–100：值不小于当前值的比例（同分并列取同值）
  const below = sorted.filter((v) => v.lt(value)).length
  return new Decimal(below).div(Math.max(1, sorted.length)).mul(100)
}

export function computeComprehensiveSuggestion(input: ComprehensiveInput): ComprehensiveOutput {
  const n = input.members.length
  if (n === 0) {
    // N=0 必须输出空名单，不产生虚构 A 档
    return { status: 'ok', ranked: [], counts: { a: 0, b: 0, c: 0 } }
  }
  if (!input.standardizationConfirmed) {
    return { status: 'pending', pendingReason: '正式赛/服务标准化、并列与零样本口径未确认（R11）', ranked: [], counts: { a: 0, b: 0, c: 0 } }
  }

  const eSorted = input.members.map((m) => new Decimal(m.semesterE)).sort((a, b) => a.comparedTo(b))
  const cSorted = input.members.map((m) => new Decimal(m.contestScore)).sort((a, b) => a.comparedTo(b))
  const sSorted = input.members.map((m) => new Decimal(m.serviceScore)).sort((a, b) => a.comparedTo(b))

  const scored = input.members.map((m) => {
    const eStd = percentileRank(eSorted, new Decimal(m.semesterE))
    const cStd = percentileRank(cSorted, new Decimal(m.contestScore))
    const sStd = percentileRank(sSorted, new Decimal(m.serviceScore))
    const deduction = new Decimal(input.disciplineDeductions?.[m.id] ?? 0)
    const h = eStd.mul(input.params.eWeight).plus(cStd.mul(input.params.contestWeight)).plus(sStd.mul(input.params.serviceWeight)).minus(deduction)
    return { id: m.id, h }
  })
  scored.sort((a, b) => b.h.comparedTo(a.h))

  const a = Math.max(1, Math.round(input.params.aRatio * n))
  const b = Math.round(input.params.bRatio * n)
  const c = n - a - b

  const ranked = scored.map((entry, idx) => {
    const position = idx + 1
    let grade: 'A' | 'B' | 'C'
    let score: Decimal
    if (position <= a) {
      grade = 'A'
      score = new Decimal(1.0)
    } else if (position <= a + b) {
      grade = 'B'
      const j = position - a
      score = new Decimal(1).minus(new Decimal(0.5).mul(j - 1).div(Math.max(1, b - 1)))
    } else {
      grade = 'C'
      const j = position - a - b
      score = new Decimal(0.5).mul(new Decimal(1).minus(new Decimal(j - 1).div(Math.max(1, c - 1))))
    }
    return { id: entry.id, h: entry.h, suggestedGrade: grade, suggestedScore: score }
  })
  return { status: 'ok', ranked, counts: { a, b: Math.max(0, b), c: Math.max(0, c) } }
}
