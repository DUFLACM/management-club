/**
 * 平台赛 W 公式（结算引擎与历史比赛导入共用）：
 * W = B + λ(4S + 6R) + X；远程 0.5×[λ(4S + 6R) + X]；上限常规 cap，远程减半。
 * - S：过题比例，分数制用得分/满分合计；
 * - R：社内名次分（有效参赛 < 3 人减半，仅 1 人记 0.5）；
 * - X：外部总排名百分位（前 5% / 10% / 30% 记 3 / 2 / 1）。
 */

export type LambdaKey = 'A' | 'B' | 'C'

export function lambdaValueOf(key: LambdaKey): number {
  return key === 'A' ? 1.2 : key === 'C' ? 0.8 : 1.0
}

export interface ContestRowFacts {
  solvedCount: number
  score: number
  platformRank: number | null
  cells: Array<{ solved: boolean; failedCount: number | null }>
}

/** 有效提交（R04）：有通过/得分/失败提交痕迹即有效 */
export function hasValidSubmission(row: ContestRowFacts): boolean {
  return row.solvedCount > 0 || row.score > 0 || row.cells.some((cell) => cell.solved || (cell.failedCount ?? 0) > 0)
}

export interface ContestFormulaInput {
  solvedCount: number
  score: number
  platformRank: number | null
  /** 社内名次（1 起） */
  clubRank: number
  /** 有效参赛人数 */
  validCount: number
  totalProblems: number
  fullTotal: number
  totalEntries: number
  lambdaKey: LambdaKey
  remote: boolean
  cap: number
}

export interface ContestFormulaResult {
  B: number
  lambda: number
  lambdaKey: LambdaKey
  S: number
  R: number
  X: number
  W: number
}

export function computeContestW(input: ContestFormulaInput): ContestFormulaResult {
  const totalProblems = input.totalProblems || 1
  const s = input.solvedCount > 0
    ? Math.min(1, input.solvedCount / totalProblems)
    : input.fullTotal > 0
      ? Math.min(1, input.score / input.fullTotal)
      : 0
  const n = input.validCount
  const r = n <= 1 ? 0.5 : (1 - (input.clubRank - 1) / (n - 1)) * (n < 3 ? 0.5 : 1)
  let x = 0
  if (input.platformRank != null && input.totalEntries > 0) {
    const pct = input.platformRank / input.totalEntries
    x = pct <= 0.05 ? 3 : pct <= 0.10 ? 2 : pct <= 0.30 ? 1 : 0
  }
  const lambda = lambdaValueOf(input.lambdaKey)
  const base = input.remote ? 0 : 2
  const raw = input.remote
    ? 0.5 * (lambda * (4 * s + 6 * r) + x)
    : base + lambda * (4 * s + 6 * r) + x
  const effectiveCap = input.remote ? input.cap * 0.5 : input.cap
  const w = Math.min(raw, effectiveCap)
  return {
    B: base,
    lambda,
    lambdaKey: input.lambdaKey,
    S: Number(s.toFixed(4)),
    R: Number(r.toFixed(4)),
    X: x,
    W: Number(w.toFixed(2)),
  }
}
