import { Decimal } from 'decimal.js'
import type { RuleParams } from './rule-params.js'

/**
 * 有效积分 E：E_t = M_t + 0.85·M_(t-1) + 0.70·M_(t-2) + 0.55·M_(t-3) + 0.40·M_(t-4) + 0.25·M_(t-5)
 * （《积分评定与竞赛认定办法》第四条；附录已核对）
 * - 自然月按 Asia/Shanghai；月键格式 YYYY-MM。
 * - 缺失月份补零；超过六个月窗口的月份忽略（不能取“最近六条有分记录”）。
 * - E 四舍五入保留 1 位小数（第六条），负分不设零下限。
 * - 权重数组长度即窗口长度（规则版本固定）。
 */
export interface EffectiveScoreInput {
  /** 月键 → 该月月度原始积分 M（整数；未取整月以 Decimal 传入时仅用于预览） */
  monthlyScores: Record<string, number | Decimal | null | undefined>
  /** 当前月，如 '2026-10' */
  currentMonth: string
}

export interface EffectiveScoreResult {
  e: Decimal
  eDisplay: string
  components: Array<{ month: string; m: Decimal; weight: Decimal; contribution: Decimal }>
  windowMonths: string[]
}

/** 生成从 currentMonth 起往前的 n 个自然月键（YYYY-MM） */
export function monthWindow(currentMonth: string, n: number): string[] {
  const match = /^(\d{4})-(\d{2})$/.exec(currentMonth)
  if (!match) throw new Error(`invalid month key: ${currentMonth}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    let y = year
    let m = month - i
    while (m <= 0) {
      m += 12
      y -= 1
    }
    out.push(`${y}-${String(m).padStart(2, '0')}`)
  }
  return out
}

export function computeEffectiveScore(
  input: EffectiveScoreInput,
  params: Pick<RuleParams, 'effectiveWeights'>,
): EffectiveScoreResult {
  const weights = params.effectiveWeights
  const months = monthWindow(input.currentMonth, weights.length)
  const components: EffectiveScoreResult['components'] = []
  let e = new Decimal(0)
  for (let i = 0; i < months.length; i++) {
    const raw = input.monthlyScores[months[i]]
    const m = raw == null ? new Decimal(0) : new Decimal(raw as Decimal.Value)
    const weight = new Decimal(weights[i])
    const contribution = m.mul(weight)
    e = e.plus(contribution)
    components.push({ month: months[i], m, weight, contribution })
  }
  // 四舍五入保留一位小数（PDF 第六条）
  const eDisplay = e.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1)
  return { e, eDisplay, components, windowMonths: months }
}

/**
 * 活跃判定（第七条）：连续 3 个自然月无任何有效训练、比赛、活动或服务记录 → 低活跃标识；
 * 连续 6 个自然月无有效记录 → 按制度清零（E 归 0 处理由审核执行，此处给出事实判定）。
 * 活跃判断只来自已认定行为事实（validActivityMonths），初始积分/扣分/同步成功不算有效活动。
 */
export function computeActivityStatus(validActivityMonths: Set<string>, currentMonth: string): {
  lowActivity: boolean
  consecutiveInactive: number
} {
  let consecutive = 0
  const months = monthWindow(currentMonth, 6)
  for (const month of months) {
    if (month === currentMonth) continue // 当月尚未结束，不参与连续无记录计数
    if (validActivityMonths.has(month)) break
    consecutive += 1
  }
  return { lowActivity: consecutive >= 3, consecutiveInactive: consecutive }
}
