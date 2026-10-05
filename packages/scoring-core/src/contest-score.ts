import { Decimal } from 'decimal.js'
import type { RuleGapId, RuleParams, ScoreOutcome } from './rule-params.js'

/**
 * 指定周赛/月赛/训练赛单场积分（附录二第一节 + 积分办法第十二~十五条）。
 *
 *   W = B + λ × (4·S + 6·R) + X
 *   S = clamp(通过题数/全部题数, 0, 1)（分数制用 本人成绩/理论满分）
 *   R = 1 - (社内名次 - 1)/max(1, 本会有效参赛人数 - 1)；有效参赛人数 < 3 时 R 再乘 0.5
 *   X：外部总排名前 5% → 3，前 10% → 2，前 30% → 1，其余 0；无公开总排名或公告不适用 → 0
 *
 * 边界（04 方案 3.2/3.4）：
 * - S 的分母缺失（题数/满分未核验）→ pending（R05/R04），不伪造分母、不记零分。
 * - 少于三人：R 按公式算出后减半（含单人 R=1→0.5），不是跳过公式。
 * - 有效提交证据缺失 → 线下竞赛分 pending（仅出勤事实另记）。
 * - 单场上限：常规 20；事前公告的特定场次 ≤25；远程为对应上限 50%。
 * - λ 由活动公告的类别决定（不能按标题模糊匹配），公告上浮 λ+0.2 或 B→3 二选一。
 */

export interface ContestScoreInput {
  /** 线下到场（或批准远程）且具备有效提交证据 */
  attendanceVerified: boolean
  /** R04：有效提交证据（赛时提交终判集合等）；null = 证据缺失待人工 */
  validSubmissionEvidence: boolean | null
  onsite: boolean
  /** 公告确定的 λ 类别 */
  lambdaKey: 'A' | 'B' | 'C'
  /** 赛前公告上浮：lambda_uplift 或 base_major 二选一（不可叠加） */
  announcement?: 'lambda_uplift' | 'base_major'
  scoringMode: 'acm' | 'score'
  solvedProblems?: number | null
  totalProblems?: number | null
  myScore?: number | Decimal | null
  fullScore?: number | Decimal | null
  /** 社内名次与有效参赛人数（已核验、具备计分资格的完整集合） */
  clubRank?: number | null
  clubTotal?: number | null
  /** 外部总排名（名次与总人数必须同一官方统计范围） */
  externalRank?: number | null
  externalTotal?: number | null
  /** 公告声明 X 不适用（无公开总排名） */
  xNotApplicable?: boolean
  /** 特定上限（事前公告，≤ contestCapSpecial） */
  specialCap?: number | null
}

export function computeContestScore(input: ContestScoreInput, params: RuleParams): ScoreOutcome {
  const decisions: ScoreOutcome['decisions'] = []
  const push = (step: string, note: string) => decisions.push({ step, note })

  if (!input.attendanceVerified) {
    return { status: 'pending', pendingReason: '无有效到场记录（或远程批准记录），竞赛分不结算，仅保留出勤事实', decisions }
  }
  if (input.validSubmissionEvidence !== true) {
    return {
      status: 'pending',
      pendingReason: input.validSubmissionEvidence === false ? '到场但无有效提交，仅记出勤，不发竞赛分' : '有效提交证据缺失（R04），转人工审核',
      gap: input.validSubmissionEvidence === null ? 'R04' : undefined,
      decisions,
    }
  }

  const lambdaDef = params.lambdas.find((l) => l.key === input.lambdaKey)
  if (!lambdaDef) return { status: 'pending', pendingReason: `未配置 λ 类别 ${input.lambdaKey}`, decisions }
  let lambda = new Decimal(lambdaDef.lambda)
  push('lambda', `公告类别 ${input.lambdaKey}（λ=${lambda}）`)

  let b = new Decimal(input.onsite ? params.baseOnsite : 0)
  if (input.announcement === 'lambda_uplift') {
    lambda = lambda.plus(params.announcementUplift.lambdaDelta)
    push('announcement', `赛前公告 λ 上浮 +${params.announcementUplift.lambdaDelta}`)
  } else if (input.announcement === 'base_major') {
    b = new Decimal(params.announcementUplift.baseAlternative)
    push('announcement', `赛前公告 B 提高为 ${params.announcementUplift.baseAlternative}`)
  } else if (input.onsite) {
    push('base', `常规线下 B=${params.baseOnsite}`)
  }

  // S
  let s: Decimal
  if (input.scoringMode === 'acm') {
    if (input.totalProblems == null || input.totalProblems <= 0) {
      return { status: 'pending', pendingReason: '题目总数未核验（不能伪造分母）', gap: 'R05', decisions }
    }
    const solved = input.solvedProblems ?? 0
    s = Decimal.max(new Decimal(0), Decimal.min(1, new Decimal(solved).div(input.totalProblems)))
    push('S', `ACM 模式：${solved}/${input.totalProblems} = ${s}`)
  } else {
    if (input.fullScore == null || new Decimal(input.fullScore).lte(0)) {
      return { status: 'pending', pendingReason: '理论满分未核验（fullScore 缺失或为 0，不能作分母）', gap: 'R05', decisions }
    }
    const score = new Decimal(input.myScore ?? 0)
    s = Decimal.max(new Decimal(0), Decimal.min(1, score.div(new Decimal(input.fullScore))))
    push('S', `分数制：${score}/${input.fullScore} = ${s}`)
  }

  // R：社内有效参赛完整集合（不能只对已加载记录排名）
  if (input.clubRank == null || input.clubTotal == null || input.clubTotal < 1) {
    return { status: 'pending', pendingReason: '社内名次/有效参赛人数未核验（R05）', gap: 'R05', decisions }
  }
  let r = new Decimal(1).minus(new Decimal(input.clubRank - 1).div(Decimal.max(1, input.clubTotal - 1)))
  if (input.clubTotal < 3) {
    r = r.mul(0.5)
    push('R', `有效参赛 ${input.clubTotal} 人 <3，R 按公式计算后减半 = ${r}`)
  } else {
    push('R', `名次 ${input.clubRank}/${input.clubTotal}，R = ${r}`)
  }

  // X
  let x = new Decimal(0)
  if (input.xNotApplicable) {
    push('X', '公告声明不适用，X = 0')
  } else if (input.externalRank != null && input.externalTotal != null && input.externalTotal > 0) {
    const pct = new Decimal(input.externalRank).div(input.externalTotal)
    if (pct.lte(0.05)) x = new Decimal(3)
    else if (pct.lte(0.10)) x = new Decimal(2)
    else if (pct.lte(0.30)) x = new Decimal(1)
    push('X', `外部排名 ${input.externalRank}/${input.externalTotal}（${pct.mul(100).toFixed(2)}%）→ X=${x}`)
  } else {
    push('X', '无公开总排名数据，X = 0（证据缺失转人工，不自动记 0 排名）')
  }

  const core = lambda.mul(s.mul(4).plus(r.mul(6))).plus(x)
  // 单场上限：公告特定上限（≤25）或常规上限；远程为对应上限的 50%
  const baseCap = new Decimal(
    input.specialCap != null ? Math.min(input.specialCap, params.contestCapSpecial) : params.contestCapRegular,
  )
  const effectiveCap = input.onsite ? baseCap : baseCap.mul(params.remoteCapRatio)

  let w: Decimal
  if (input.onsite) {
    w = b.plus(core)
  } else {
    // 远程：W_remote = 0.5 × [λ(4S+6R)+X]，B 不计
    w = core.mul(0.5)
    push('remote', '远程参赛按 50% 折算，B 不计')
  }
  if (w.gt(effectiveCap)) {
    push('cap', `单场上限 ${effectiveCap}，超出截断（原 ${w}）`)
    w = effectiveCap
  }
  return { status: 'ok', value: w, decisions }
}

/** 远程月次数校验：每自然月最多认定一次；批准但未实际参赛不消耗次数 */
export function remoteMonthlyAllowance(
  monthKey: string,
  alreadyCountedRemoteMonths: string[],
  params: Pick<RuleParams, 'remoteMonthlyLimit'>,
): { allowed: boolean; reason?: string } {
  const used = alreadyCountedRemoteMonths.filter((m) => m === monthKey).length
  if (used >= params.remoteMonthlyLimit) {
    return { allowed: false, reason: `${monthKey} 已认定远程 ${used} 次，超过每月 ${params.remoteMonthlyLimit} 次限制` }
  }
  return { allowed: true }
}
