import { z } from 'zod'
import type Decimal from 'decimal.js'

/**
 * 规则参数快照（rule_versions.params 的类型化结构）。
 * PDF 原文确定的值作为默认值；未决口径（R01–R13）显式可选，缺失即阻塞对应正式结算。
 */
export const sixMonthWeights = [1.0, 0.85, 0.7, 0.55, 0.4, 0.25] as const

export const lambdaCategorySchema = z.object({
  /** 甲类 1.2 / 乙类 1.0 / 丙类 0.8 —— 归档于附录二第二节 */
  key: z.enum(['A', 'B', 'C']),
  lambda: z.number(),
  label: z.string(),
})

export const attendancePenaltySchema = z.object({
  unexcusedAbsence: z.number().default(-4), // 无故缺席必到活动
  lateOrEarlyOver15: z.number().default(-2), // 迟到或早退超过 15 分钟
  proxyCheckIn: z.number().default(-10), // 代签、伪造签到、冒名顶替
  dishonestLeave: z.tuple([z.number(), z.number()]).default([-20, -5]), // 虚假请假 [-20,-5]
  taskNotCompleted: z.number().default(-4), // 接受任务未完成
  unapprovedRemoteClaim: z.number().default(-2), // 未批准远程却申报得分（该场 0 另计）
  refuseCooperation: z.tuple([z.number(), z.number()]).default([-15, -5]),
  quotaAbandon: z.tuple([z.number(), z.number()]).default([-30, -10]),
})

export const roundingPolicySchema = z.enum(['round_half_up', 'floor', 'ceil', 'pending'])

export const ruleParamsSchema = z.object({
  /** 单场竞赛：B 线下到场基础分（常规 2 / 指定月赛 3），远程 B=0 */
  baseOnsite: z.number().default(2),
  baseMajor: z.number().default(3),
  lambdas: z.array(lambdaCategorySchema),
  /** 赛前公告上浮：λ +0.2 或 B→3，二者不自动叠加 */
  announcementUplift: z.object({
    lambdaDelta: z.number().default(0.2),
    baseAlternative: z.number().default(3),
  }).prefault({}),
  /** 常规单场上限 20；特定事前公告上限 ≤25（积分办法第十三条） */
  contestCapRegular: z.number().default(20),
  contestCapSpecial: z.number().default(25),
  /** 远程上限为对应线下场次上限的 50% */
  remoteCapRatio: z.number().default(0.5),
  /** 远程每自然月最多认定一次 */
  remoteMonthlyLimit: z.number().default(1),
  /** 月分类上限：参会/工作人员/服务合计 12；讲题/题解/分享/出题合计 20 */
  monthlyCapParticipationService: z.number().default(12),
  monthlyCapTeachingContribution: z.number().default(20),
  /** E 六自然月滚动权重（固定） */
  effectiveWeights: z.array(z.number()).default([...sixMonthWeights]),
  /** M 取整策略（R01 已决）：流水保留精确小数，月末汇总后四舍五入 */
  monthlyRounding: roundingPolicySchema.default('round_half_up'),
  /** 初始积分（R02 已决）：资质优异通道受正式成员 M 中位数 80% 上限约束 */
  initialPoints: z.object({
    base: z.number().default(18),
    span: z.number().default(12),
    single: z.number().default(30),
    excellenceBase: z.number().default(12),
    excellenceFactor: z.number().default(0.3),
    /** 显式覆盖上限（旧字段兼容）；未设置时按 ratio × 中位数计算 */
    medianCap: z.number().nullable().default(null),
    /** R02：上限 = floor(正式成员 M 中位数 × ratio)；中位数不足 minimumMedian 时该上限不生效 */
    medianCapRatio: z.number().default(0.8),
    medianCapRounding: z.enum(['floor', 'round_half_up']).default('floor'),
    medianCapMinimumMedian: z.number().default(15),
  }).prefault({}),
  /** 迟到/早退与半场叠加口径（R03 已决）：按次独立叠加，参与分 +1/场一次，半场按活动中点 */
  lateEarlyPolicy: z.enum(['pending', 'configured']).default('configured'),
  lateEarlyConfig: z.object({
    /** 每项违规扣分（与 attendancePenalties.lateOrEarlyOver15 一致） */
    penaltyPerViolation: z.number().default(-2),
    /** 同场上限（两项叠加最多 -4） */
    maxPenaltyPerSession: z.number().default(-4),
    /** 参与分：迟到/早退但未超半场仍得 1 分，且每场只发一次 */
    participationPoints: z.number().default(1),
    stackViolations: z.boolean().default(true),
  }).prefault({}),
  attendancePenalties: attendancePenaltySchema.prefault({}),
  /** 有效提交判题状态集合（R04 已决）：集合内即有效；CE 等转人工；无证据 → 只记出勤 */
  validSubmission: z.object({
    acceptedStatuses: z.array(z.string()).default(['AC', 'WA', 'TLE', 'MLE', 'RE', 'PE']),
    manualReviewStatuses: z.array(z.string()).default(['CE']),
    missingEvidence: z.enum(['attendance_only', 'manual_review']).default('attendance_only'),
  }).prefault({}),
  /** 并列与排名范围（R05 已决）：标准竞赛排名；X 为到场且有有效提交的社内成员数 */
  rankingTies: z.object({
    policy: z.enum(['standard_competition', 'dense']).default('standard_competition'),
    xDefinition: z.enum(['onsite_with_valid_submission', 'onsite_all', 'registered']).default('onsite_with_valid_submission'),
  }).prefault({}),
  /** 满意度 V（R06 已决）：满意及以上占比；门槛不足转人工，讲题人自评不计 */
  satisfactionV: z.object({
    eligibleRatio: z.number().default(0.3),
    minVotes: z.number().default(3),
    selfVoteExcluded: z.boolean().default(true),
    insufficient: z.enum(['manual_review', 'neutral']).default('manual_review'),
  }).prefault({}),
  /** 月度评定（R07 已决）：取上月末 E 快照；并列先比上月 M，再并列共列 */
  monthlyEvaluation: z.object({
    snapshot: z.enum(['previous_month_end', 'evaluation_day']).default('previous_month_end'),
    tieBreak: z.array(z.enum(['previous_month_m', 'attendance', 'shared_rank'])).default(['previous_month_m', 'shared_rank']),
  }).prefault({}),
  /** 材料时限（R08 已决）：一般 7 日；正式赛赛后 3 日、大型 7 日（公告可标注） */
  materialDeadlines: z.object({
    generalDays: z.number().default(7),
    contestDays: z.number().default(3),
    majorContestDays: z.number().default(7),
  }).prefault({}),
  /** 网络赛奖项替代（R09 已决）：替代值不含参与分，与出线互斥择高 */
  awardSubstitution: z.object({
    includesParticipation: z.boolean().default(false),
    exclusiveWithQualification: z.boolean().default(true),
  }).prefault({}),
  /** 跨类别上限入账顺序（R10 已决）：recordedAt 先到先得；冲正不倒写已冻结名单 */
  capApplication: z.object({
    order: z.enum(['recorded_at_fifo', 'amount_desc']).default('recorded_at_fifo'),
    respectFrozenLists: z.boolean().default(true),
  }).prefault({}),
  /** Q 归一化与综测标准化（R11 已决）：百分位归一化；零样本输出空名单；并列同分同位 */
  qNormalization: z.object({
    method: z.enum(['percentile', 'min_max']).default('percentile'),
    zeroSampleOutputsEmpty: z.boolean().default(true),
    sharedRankOnTie: z.boolean().default(true),
  }).prefault({}),
  /** 统计月口径（R12 已决）：月末最后状态、次月生效；冻结按冻结时点 */
  statisticsMonth: z.object({
    statusPolicy: z.enum(['end_of_month', 'immediate', 'month_start']).default('end_of_month'),
    effectiveFrom: z.enum(['next_month', 'immediate']).default('next_month'),
    freezeBasis: z.enum(['snapshot_time', 'month_end']).default('snapshot_time'),
  }).prefault({}),
  /** 目录认定与备案（R13 已决）：须挂依据引用，生效前公示至少 3 日 */
  catalogGovernance: z.object({
    requiresEvidenceRef: z.boolean().default(true),
    publicNoticeDays: z.number().default(3),
  }).prefault({}),
  /** 专项排序 Q = P 权重 + T 权重（T 权重 30%–50% 区间，赛前公告） */
  specialRanking: z.object({
    pWeight: z.number().default(0.7),
    tWeight: z.number().default(0.3),
  }).prefault({}),
  /** 综测建议（附录三） */
  comprehensiveEval: z.object({
    eWeight: z.number().default(0.7),
    contestWeight: z.number().default(0.2),
    serviceWeight: z.number().default(0.1),
    aRatio: z.number().default(0.1),
    bRatio: z.number().default(0.2),
  }).prefault({}),
})

export type RuleParams = z.infer<typeof ruleParamsSchema>

/** 默认参数（PDF 已确定值 + R01–R13 已拍板口径；仍可通过发布新规则版本覆盖） */
export function defaultRuleParams(): RuleParams {
  return ruleParamsSchema.parse({
    lambdas: [
      { key: 'A', lambda: 1.2, label: '甲类：CF Div.1/2/Edu、ARC、官方多校/寒暑假阶段赛' },
      { key: 'B', lambda: 1.0, label: '乙类：CF Div.3/4、ABC、牛客周赛/练习赛、社内常规周赛' },
      { key: 'C', lambda: 0.8, label: '丙类：牛客小白月赛、社内新生/基础赛' },
    ],
  })
}

/** R01–R13 历史未决口径登记（保留作为审计索引；当前版本均已拍板） */
export const RULE_GAPS = {
  R01: 'M 取整策略：逐项/月末、四舍五入口径未确认',
  R02: '初始积分中位数 80% 上限与取整方式未确认',
  R03: '迟到/早退 1 分与 -2 扣分叠加、半场比较口径未确认',
  R04: '“有效提交”判题状态集合未定义',
  R05: '社内并列、团队 S/R、X 排名范围口径未确认',
  R06: '满意度 V 分子分母、有效投票门槛未确认',
  R07: '月度评定取用时点与并列裁决未确认',
  R08: '一般材料 7 日与赛后材料 3/7 日的任务拆分未确认',
  R09: '网络赛奖项替代模式是否含参与分未确认',
  R10: '理论最高分引用与跨类别上限入账顺序未确认',
  R11: 'Q 归一化、综测标准化与零样本口径未确认',
  R12: '月内身份变化与冻结资格的统计月口径未确认',
  R13: '目录认定与备案条款的专项映射未确认',
} as const

/** R01–R13 拍板结论（2026-10-06 协会确认；R01/R03/R04/R12 由负责人当面拍板，其余按推荐默认生效） */
export const RESOLVED_RULE_DECISIONS: Record<keyof typeof RULE_GAPS, string> = {
  R01: '月末汇总后四舍五入（round_half_up）：账本保留精确小数，按类别月上限汇总后月末一次性取整',
  R02: '上限 = floor(正式成员月度 M 中位数 × 0.8)；中位数不足 15 或无正式成员时不设上限',
  R03: '迟到/早退扣分按次独立叠加（同场最多 -2-2=-4）；参与分 +1/场仅发一次；「半场」按活动开始至结束的中点时刻比较',
  R04: '有效提交 = AC/WA/TLE/MLE/RE/PE 任一；仅 CE 转人工确认；无任何提交证据 → 只记出勤不发竞赛分',
  R05: '并列采用标准竞赛排名（1-2-2-4，不用学号打破成绩并列）；X = 到场且有有效提交的社内成员数；团队赛 S/R 按团队成绩',
  R06: 'V = 有效票中满意及以上占比；有效票门槛 = max(3, ⌈到场人数×30%⌉)；讲题人自评不计入；不足门槛转人工（不自动按 1.0）',
  R07: '月度评定取上月末（最后一秒）E 快照；并列先比上月 M，仍并列则并列共列',
  R08: '一般积分材料：活动结束/成绩公布后 7 日；正式赛赛后材料 3 日、大型赛事 7 日（以公告标注为准）',
  R09: '网络赛奖项替代值不含参与分；替代模式与出线分互斥择高，不叠加',
  R10: '跨类别月上限按入账时间（recordedAt）先到先得扣减额度；冲正不倒写已冻结名单；理论最高分引用平台核验 fullScore',
  R11: 'Q = 0.7P + 0.3T（赛前公告可在 30%–50% 调整）；P/T 按百分位归一化；综测各项按百分位折算 0–100；零样本输出空名单；并列同分同位',
  R12: '身份统计月按月末最后状态，新身份自次月生效；冻结资格按冻结时点状态；已定历史不重构',
  R13: '目录认定/备案条目须挂接决议或备案依据引用，生效前至少公示 3 日',
}

export type RuleGapId = keyof typeof RULE_GAPS

/** 计算结论：得分或显式阻塞原因（绝不把缺数据当零分） */
export interface ScoreOutcome<T = Decimal> {
  status: 'ok' | 'pending'
  value?: T
  pendingReason?: string
  gap?: RuleGapId
  decisions: Array<{ step: string; note: string }>
}
