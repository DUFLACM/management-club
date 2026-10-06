import { Decimal } from 'decimal.js'
import type { RuleParams } from './rule-params.js'

/**
 * 入社、初始积分与名额（成员管理与入退社办法 + 04 方案 7）。
 */

/**
 * 新生初始积分：I = 18 + 12 × (1 - (r-1)/max(1, m-1))；仅一人时 I = 30。
 * 计入入社当月 M 并按 E 公式自然衰减；不从“注册成功”触发。
 */
export function initialPoints(rank: number, total: number): Decimal {
  if (total <= 1) return new Decimal(30)
  const r = new Decimal(rank)
  const m = new Decimal(total)
  return new Decimal(18).plus(new Decimal(12).mul(new Decimal(1).minus(r.minus(1).div(m.minus(1)))))
}

/**
 * 资质优异通道：I = 12 + 0.3 × max(0, 综合评分 - 60)（至少 60 分才可录取）。
 * R02 已拍板：上限 = floor(正式成员月度 M 中位数 × 0.8)；中位数不足 minimumMedian（默认 15）
 * 或无正式成员样本时不设上限。显式 medianCap 覆盖计算值。
 */
export function excellenceInitialPoints(
  score: number,
  initial: RuleParams['initialPoints'],
  currentMedianM: Decimal | null,
): { value: Decimal; capped: boolean } {
  const base = new Decimal(initial.excellenceBase).plus(new Decimal(initial.excellenceFactor).mul(Decimal.max(0, new Decimal(score).minus(60))))
  let cap: Decimal | null = null
  if (initial.medianCap != null) {
    cap = new Decimal(initial.medianCap)
  } else if (currentMedianM != null && currentMedianM.gte(initial.medianCapMinimumMedian)) {
    const raw = currentMedianM.mul(initial.medianCapRatio)
    cap = initial.medianCapRounding === 'floor' ? raw.floor() : raw.toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
  }
  if (cap == null) return { value: base, capped: false }
  return { value: Decimal.min(base, cap), capped: base.gt(cap) }
}

/** 基础正式名额 F = min(15, max(8, ceil(0.4 × N)))；N 为上月最后一日在册正式成员数 */
export function formalQuota(n: number): number {
  return Math.min(15, Math.max(8, Math.ceil(0.4 * n)))
}

/** 保留观察期：失去基础名额且连续在位 K 月 → G = floor(K/3) 个观察月；K<3 → 次月降预备 */
export function graceMonths(k: number): { g: number; demoteNextMonth: boolean } {
  if (k < 3) return { g: 0, demoteNextMonth: true }
  return { g: Math.floor(k / 3), demoteNextMonth: false }
}

/**
 * 黄牌候选：连续两月 M<6 / 连续两月无指定比赛且无正当事由 / 学期两次必到无故缺席。
 * 只生成候选事实与提醒；不得跳过告知、申辩、集体讨论、教师审核和公示自动除名。
 */
export interface YellowCardSignals {
  monthlyScores: Record<string, number>
  months: string[] // 连续月键
  hadRecognizedContest: Record<string, boolean>
  unexcusedAbsenceCountThisTerm: number
}

export function yellowCardCandidates(signals: YellowCardSignals): string[] {
  const reasons: string[] = []
  const m = signals.months
  if (m.length >= 2) {
    const [prev, curr] = [m[m.length - 2], m[m.length - 1]]
    if ((signals.monthlyScores[prev] ?? 0) < 6 && (signals.monthlyScores[curr] ?? 0) < 6) {
      reasons.push(`连续两月 M<6（${prev}、${curr}）`)
    }
    if (!signals.hadRecognizedContest[prev] && !signals.hadRecognizedContest[curr]) {
      reasons.push(`连续两月无指定/认可比赛记录（${prev}、${curr}），需核对正当事由`)
    }
  }
  if (signals.unexcusedAbsenceCountThisTerm >= 2) {
    reasons.push(`本学期必到活动无故缺席 ${signals.unexcusedAbsenceCountThisTerm} 次`)
  }
  return reasons
}

/** 综合素质评价资格与重复申报回避在 comprehensive-eval 中处理 */
export type MembershipStatus =
  | 'applicant' | 'observing' | 'provisional' | 'formal'
  | 'honorary_retired' | 'withdrawn' | 'dismissed' | 'vetoed'

/** 排名资格：不同身份的参榜资格（月度评定与冻结以已公布规则版本为准） */
export function rankingEligibility(status: MembershipStatus): { ranked: boolean; reason?: string } {
  switch (status) {
    case 'formal':
    case 'provisional':
    case 'observing':
      return { ranked: true }
    case 'applicant':
      return { ranked: false, reason: '申请中：尚未获得入社资格' }
    case 'honorary_retired':
      return { ranked: false, reason: '荣誉退役：退出日常排名' }
    case 'withdrawn':
      return { ranked: false, reason: '已退社' }
    case 'dismissed':
      return { ranked: false, reason: '已除名' }
    case 'vetoed':
      return { ranked: false, reason: '一票否决生效：E 已清零并取消资格' }
  }
}

/** 特殊排序 Q = P·wP + T·wT（T 权重赛前公告 30%–50%） */
export function specialRankingScore(pNormalized: Decimal, tNormalized: Decimal, params: RuleParams['specialRanking']): Decimal {
  return pNormalized.mul(params.pWeight).plus(tNormalized.mul(params.tWeight))
}
