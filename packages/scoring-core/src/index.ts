/**
 * scoring-core：不依赖 IO 的积分规则纯计算包。
 * 依据 docs/scheme/04-rules-and-scoring.md 与 docs/ 九份 PDF（核对日期 2026-10-05）。
 *
 * 原则：
 * - 事实、证据、规则、计算、审核、流水分别建模；本包只做“规则 × 已核验事实 → 得分与决策过程”。
 * - 明细保留精确小数（Decimal），最终取整策略必须由已发布的规则版本给出（R01），缺失时返回 pending。
 * - 未决口径（R01–R13）以显式配置缺失呈现，绝不写死任意解释。
 */
import Decimal from 'decimal.js'

// 中间计算 Decimal 精度至少 30 位（02 方案 5.4）
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_UP })

export { Decimal }
export * from './rule-params.js'
export * from './effective-score.js'
export * from './contest-score.js'
export * from './activity-score.js'
export * from './contribution-score.js'
export * from './award-score.js'
export * from './membership-score.js'
export * from './team-assignment.js'
export * from './comprehensive-eval.js'
export * from './monthly-rollup.js'
