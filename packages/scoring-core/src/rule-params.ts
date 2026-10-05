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
  /** M 取整策略：R01 未决时必须为 'pending'，阻塞正式月结算发布 */
  monthlyRounding: roundingPolicySchema.default('pending'),
  /** 初始积分：R02（中位数 80% 上限等）未决时 medianCap 为 null */
  initialPoints: z.object({
    base: z.number().default(18),
    span: z.number().default(12),
    single: z.number().default(30),
    excellenceBase: z.number().default(12),
    excellenceFactor: z.number().default(0.3),
    medianCap: z.number().nullable().default(null),
  }).prefault({}),
  /** 迟到/早退与半场叠加口径（R03）：pending 时不自动核算，转人工复核 */
  lateEarlyPolicy: z.enum(['pending', 'configured']).default('pending'),
  attendancePenalties: attendancePenaltySchema.prefault({}),
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

/** 默认参数（对应 PDF 已确定值；monthlyRounding 保持 pending 直到 R01 确认） */
export function defaultRuleParams(): RuleParams {
  return ruleParamsSchema.parse({
    lambdas: [
      { key: 'A', lambda: 1.2, label: '甲类：CF Div.1/2/Edu、ARC、官方多校/寒暑假阶段赛' },
      { key: 'B', lambda: 1.0, label: '乙类：CF Div.3/4、ABC、牛客周赛/练习赛、社内常规周赛' },
      { key: 'C', lambda: 0.8, label: '丙类：牛客小白月赛、社内新生/基础赛' },
    ],
  })
}

/** R01–R13 待解释口径注册表：production 未落实时阻塞受影响的正式结算 */
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

export type RuleGapId = keyof typeof RULE_GAPS

/** 计算结论：得分或显式阻塞原因（绝不把缺数据当零分） */
export interface ScoreOutcome<T = Decimal> {
  status: 'ok' | 'pending'
  value?: T
  pendingReason?: string
  gap?: RuleGapId
  decisions: Array<{ step: string; note: string }>
}
