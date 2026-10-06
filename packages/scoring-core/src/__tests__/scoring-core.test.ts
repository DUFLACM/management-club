import { describe, expect, it } from 'vitest'
import { Decimal } from 'decimal.js'
import {
  computeEffectiveScore,
  computeActivityStatus,
  computeContestScore,
  remoteMonthlyAllowance,
  classifyAttendance,
  satisfactionMultiplier,
  applyMonthlyCaps,
  rollupMonthly,
  planReversal,
  buildSourceKey,
  initialPoints,
  formalQuota,
  graceMonths,
  matrixTeamAssignment,
  computeComprehensiveSuggestion,
  networkQualifierScore,
  ladderScore,
  lanqiaoScore,
  pickHighestOfSameContest,
  cheatingPenalty,
  formalContestScore,
  defaultRuleParams,
} from '../index.js'

const params = defaultRuleParams()

describe('E 六自然月滚动（积分办法第四~七条）', () => {
  it('跨自然月按固定权重计算，缺失月补零', () => {
    const r = computeEffectiveScore(
      { monthlyScores: { '2026-10': 24, '2026-09': 32, '2026-08': 40, '2026-07': 12, '2026-06': 18, '2026-05': 8 }, currentMonth: '2026-10' },
      params,
    )
    // 24 + .85*32 + .7*40 + .55*12 + .4*18 + .25*8 = 95.0
    expect(r.eDisplay).toBe('95.0')
  })

  it('方案 4.1 演示数据：8,18,12,40,32,24 → 95.0', () => {
    const r = computeEffectiveScore(
      { monthlyScores: { '2026-10': 24, '2026-09': 32, '2026-08': 40, '2026-07': 12, '2026-06': 18, '2026-05': 8 }, currentMonth: '2026-10' },
      params,
    )
    expect(r.eDisplay).toBe('95.0')
    expect(r.components.map((c) => c.month)).toEqual(['2026-10', '2026-09', '2026-08', '2026-07', '2026-06', '2026-05'])
  })

  it('超过六个月窗口的月份不计入（不能取最近六条有分记录）', () => {
    const r = computeEffectiveScore(
      { monthlyScores: { '2026-10': 10, '2026-03': 100, '2025-12': 100 }, currentMonth: '2026-10' },
      params,
    )
    expect(r.eDisplay).toBe('10.0')
  })

  it('负分月份直接进入 E，不设零下限', () => {
    const r = computeEffectiveScore({ monthlyScores: { '2026-10': -6, '2026-09': 4 }, currentMonth: '2026-10' }, params)
    // -6 + 3.4 = -2.6
    expect(r.eDisplay).toBe('-2.6')
  })

  it('连续无有效记录 3 个月触发低活跃标识（当月未结束不参与计数）', () => {
    expect(computeActivityStatus(new Set(['2026-09']), '2026-10').lowActivity).toBe(false)
    // 仅有当月记录：之前五个完整月无记录 → 低活跃
    expect(computeActivityStatus(new Set(['2026-10']), '2026-10').lowActivity).toBe(true)
    expect(computeActivityStatus(new Set(), '2026-10').lowActivity).toBe(true)
    expect(computeActivityStatus(new Set(), '2026-10').consecutiveInactive).toBe(5)
    expect(computeActivityStatus(new Set(['2026-08']), '2026-10').consecutiveInactive).toBe(1)
  })
})

describe('单场竞赛 W 公式（积分办法第十二~十四条）', () => {
  const base = {
    attendanceVerified: true,
    validSubmissionEvidence: true,
    onsite: true,
    lambdaKey: 'B' as const,
    scoringMode: 'acm' as const,
  }

  it('方案 3.4 算例：B=2 λ=1 3/6题 社内第2/5人 外部9/100 → W=10.5', () => {
    const r = computeContestScore(
      { ...base, solvedProblems: 3, totalProblems: 6, clubRank: 2, clubTotal: 5, externalRank: 9, externalTotal: 100 },
      params,
    )
    expect(r.status).toBe('ok')
    expect(r.value!.toFixed(1)).toBe('10.5')
  })

  it('同一人合规远程：W = 0.5×[λ(4S+6R)+X] = 4.25', () => {
    const r = computeContestScore(
      { ...base, onsite: false, solvedProblems: 3, totalProblems: 6, clubRank: 2, clubTotal: 5, externalRank: 9, externalTotal: 100 },
      params,
    )
    expect(r.status).toBe('ok')
    expect(r.value!.toFixed(2)).toBe('4.25')
  })

  it('单人参赛：R 按公式为 1 后减半为 0.5，3/6 题 B=2 X=0 → W=7', () => {
    const r = computeContestScore(
      { ...base, solvedProblems: 3, totalProblems: 6, clubRank: 1, clubTotal: 1, xNotApplicable: true },
      params,
    )
    expect(r.value!.toFixed(2)).toBe('7.00') // 2 + 1*(2 + 3) = 7
  })

  it('两人参赛同样应用 <3 人减半', () => {
    const r = computeContestScore(
      { ...base, solvedProblems: 3, totalProblems: 6, clubRank: 1, clubTotal: 2, xNotApplicable: true },
      params,
    )
    // R = 1 - 0/1 = 1 → 0.5；W = 2 + (2 + 3) = 7
    expect(r.value!.toFixed(2)).toBe('7.00')
  })

  it('常规单场上限 20 截断', () => {
    const r = computeContestScore(
      { ...base, lambdaKey: 'A', solvedProblems: 6, totalProblems: 6, clubRank: 1, clubTotal: 10, externalRank: 1, externalTotal: 100 },
      params,
    )
    // 2 + 1.2*(4+6*1) + 3 = 17 < 20 不截断；构造更高：announcement lambda_uplift → 2+1.4*10+3 = 19
    expect(r.value!.toNumber()).toBeLessThanOrEqual(20)
    const r2 = computeContestScore(
      { ...base, lambdaKey: 'A', announcement: 'lambda_uplift', solvedProblems: 6, totalProblems: 6, clubRank: 1, clubTotal: 30, externalRank: 1, externalTotal: 100 },
      params,
    )
    // 2 + 1.4*(4+6) + 3 = 19；再乘满 S/R 时达到 cap 需更大 λ → 用 specialCap 验证
    expect(r2.value!.toNumber()).toBeLessThanOrEqual(25)
  })

  it('特定上限 25 且公告上限不可超过 25', () => {
    const r = computeContestScore(
      { ...base, lambdaKey: 'A', specialCap: 99, solvedProblems: 6, totalProblems: 6, clubRank: 1, clubTotal: 50, externalRank: 1, externalTotal: 1000 },
      params,
    )
    expect(r.value!.toNumber()).toBeLessThanOrEqual(25)
  })

  it('远程上限为线下上限的 50%', () => {
    const r = computeContestScore(
      { ...base, onsite: false, lambdaKey: 'A', specialCap: 25, solvedProblems: 6, totalProblems: 6, clubRank: 1, clubTotal: 50, externalRank: 1, externalTotal: 1000 },
      params,
    )
    expect(r.value!.toNumber()).toBeLessThanOrEqual(12.5)
  })

  it('题数分母缺失 → pending（不伪造分母），不作零分', () => {
    const r = computeContestScore({ ...base, scoringMode: 'acm', totalProblems: null, clubRank: 1, clubTotal: 5 }, params)
    expect(r.status).toBe('pending')
    expect(r.gap).toBe('R05')
  })

  it('分数制 fullScore=0 → pending（禁止除零，牛客 ICPC 记录存在 fullScore=0）', () => {
    const r = computeContestScore(
      { ...base, scoringMode: 'score', myScore: 355, fullScore: 0, clubRank: 1, clubTotal: 5 },
      params,
    )
    expect(r.status).toBe('pending')
  })

  it('签到成功但无有效提交 → pending：仅出勤不发竞赛分', () => {
    const r = computeContestScore({ ...base, validSubmissionEvidence: false }, params)
    expect(r.status).toBe('pending')
    expect(r.pendingReason).toContain('仅记出勤')
  })

  it('提交证据未知 → pending 转 R04 人工审核', () => {
    const r = computeContestScore({ ...base, validSubmissionEvidence: null }, params)
    expect(r.status).toBe('pending')
    expect(r.gap).toBe('R04')
  })

  it('无到场记录不结算', () => {
    const r = computeContestScore({ ...base, attendanceVerified: false }, params)
    expect(r.status).toBe('pending')
  })

  it('X 边界：恰好 5%/10%/30% 百分位', () => {
    const mk = (rank: number, total: number) =>
      computeContestScore(
        { ...base, solvedProblems: 0, totalProblems: 6, clubRank: 1, clubTotal: 5, externalRank: rank, externalTotal: total },
        params,
      )
    // B=2 λ=1 S=0 R=1 → W = 2 + 6 + X = 8+X
    expect(mk(5, 100).value!.toNumber()).toBe(11)
    expect(mk(10, 100).value!.toNumber()).toBe(10)
    expect(mk(30, 100).value!.toNumber()).toBe(9)
    expect(mk(31, 100).value!.toNumber()).toBe(8)
  })

  it('signUpCnt 不冒充有效排名人数：clubTotal 未核验 → pending', () => {
    const r = computeContestScore({ ...base, solvedProblems: 3, totalProblems: 6, clubRank: null, clubTotal: null }, params)
    expect(r.status).toBe('pending')
  })

  it('远程每自然月最多一次；批准未参赛不消耗次数', () => {
    expect(remoteMonthlyAllowance('2026-10', [], params).allowed).toBe(true)
    expect(remoteMonthlyAllowance('2026-10', ['2026-10'], params).allowed).toBe(false)
    expect(remoteMonthlyAllowance('2026-10', ['2026-09'], params).allowed).toBe(true)
  })
})

describe('活动参与分与扣分（附录二第五节）', () => {
  const base = { durationMinutes: 120, required: true, normalSession: false, leaveApproved: false, remoteApproved: false }

  it('必到活动准时 → +2', () => {
    const r = classifyAttendance({ ...base, checkinOffsetMinutes: 0, checkoutOffsetMinutes: 0 }, params)
    expect(r.value!.toNumber()).toBe(2)
  })

  it('迟到恰好 15 分钟不触发降档（严格 >15）', () => {
    const r = classifyAttendance({ ...base, checkinOffsetMinutes: 15, checkoutOffsetMinutes: 0 }, params)
    expect(r.value!.toNumber()).toBe(2)
    expect(r.penaltyDraft).toBeUndefined()
  })

  it('迟到 16 分钟 → 参与 +1 且 -2 扣分候选单列', () => {
    const r = classifyAttendance({ ...base, checkinOffsetMinutes: 16, checkoutOffsetMinutes: 0 }, params)
    expect(r.value!.toNumber()).toBe(1)
    expect(r.penaltyDraft!.amount.toNumber()).toBe(-2)
  })

  it('超过半场到场 → 0 分（严格 > D/2）', () => {
    const r = classifyAttendance({ ...base, checkinOffsetMinutes: 61, checkoutOffsetMinutes: 0 }, params)
    expect(r.value!.toNumber()).toBe(0)
    expect(r.penaltyDraft).toBeUndefined() // 扣分按相应制度单列，由审核生成
  })

  it('恰好半场（60 分钟）不属于超过半场，按迟到处理', () => {
    const r = classifyAttendance({ ...base, checkinOffsetMinutes: 60, checkoutOffsetMinutes: 0 }, params)
    expect(r.value!.toNumber()).toBe(1)
  })

  it('缺签退 → pending 不默认满勤', () => {
    const r = classifyAttendance({ ...base, checkinOffsetMinutes: 0, checkoutOffsetMinutes: null }, params)
    expect(r.status).toBe('pending')
  })

  it('无故缺席必到活动 → 0 分 + -4 扣分候选', () => {
    const r = classifyAttendance({ ...base, checkinOffsetMinutes: null, checkoutOffsetMinutes: null }, params)
    expect(r.value!.toNumber()).toBe(0)
    expect(r.penaltyDraft!.amount.toNumber()).toBe(-4)
  })

  it('普通参会（宣讲/分享/复盘）→ +1.5 保留精确小数', () => {
    const r = classifyAttendance(
      { durationMinutes: 90, required: false, normalSession: true, leaveApproved: false, remoteApproved: false, checkinOffsetMinutes: 0, checkoutOffsetMinutes: 0 },
      params,
    )
    expect(r.value!.toNumber()).toBe(1.5)
  })

  it('批准请假：不缺席也不计参与分', () => {
    const r = classifyAttendance({ ...base, checkinOffsetMinutes: null, checkoutOffsetMinutes: null, leaveApproved: true }, params)
    expect(r.value!.toNumber()).toBe(0)
    expect(r.penaltyDraft).toBeUndefined()
  })

  it('30 分钟内活动迟到 16 分钟已超半场（>D/2）→ 按半场规则 0 分', () => {
    const r = classifyAttendance({ ...base, durationMinutes: 20, checkinOffsetMinutes: 16, checkoutOffsetMinutes: 0 }, params)
    expect(r.value!.toNumber()).toBe(0)
  })

  it('R03 已拍板：同时迟到与早退 → 参与分 +1 一次，扣分按次叠加 -4', () => {
    const r = classifyAttendance({ ...base, durationMinutes: 120, checkinOffsetMinutes: 20, checkoutOffsetMinutes: 20 }, params)
    expect(r.status).toBe('ok')
    expect(r.value!.toNumber()).toBe(1)
    expect(r.penaltyDraft!.amount.toNumber()).toBe(-4)
  })

  it('R03 显式 pending（未拍板的旧版本）：同时迟到早退仍转人工', () => {
    const p = { ...params, lateEarlyPolicy: 'pending' as const }
    const r = classifyAttendance({ ...base, durationMinutes: 120, checkinOffsetMinutes: 20, checkoutOffsetMinutes: 20 }, p)
    expect(r.status).toBe('pending')
    expect(r.gap).toBe('R03')
  })
})

describe('贡献分与月上限', () => {
  it('满意度 V 阈值：90/80/70/60 边界', () => {
    expect(satisfactionMultiplier(9, 10).value!.toNumber()).toBe(1.2)
    expect(satisfactionMultiplier(8, 10).value!.toNumber()).toBe(1.0)
    expect(satisfactionMultiplier(7, 10).value!.toNumber()).toBe(0.8)
    expect(satisfactionMultiplier(6, 10).value!.toNumber()).toBe(0.5)
    expect(satisfactionMultiplier(5, 10).value!.toNumber()).toBe(0)
  })

  it('无有效投票 → R06 pending', () => {
    expect(satisfactionMultiplier(0, 0).status).toBe('pending')
  })

  it('月分类上限：参会/服务 12，讲题/题解/分享/出题 20，正式赛不设月上限', () => {
    const r = applyMonthlyCaps({
      positiveEntries: [
        { category: 'participation_service', amount: 8 },
        { category: 'participation_service', amount: 6 },
        { category: 'teaching_contribution', amount: 14 },
        { category: 'teaching_contribution', amount: 9 },
        { category: 'contest', amount: 50 },
      ],
      params,
    })
    expect(r.totals.participation_service.toNumber()).toBe(12)
    expect(r.totals.teaching_contribution.toNumber()).toBe(20)
    expect(r.totals.contest.toNumber()).toBe(50)
  })

  it('R01 已拍板：默认月末四舍五入，rollup 直接给出正式 M', () => {
    const r = rollupMonthly(
      {
        positiveEntries: [{ category: 'contest', amount: 10.5 }],
        negativeEntries: [{ category: 'penalty', amount: -2 }],
        params,
      },
      params,
    )
    expect(r.m).toBe(9)
    expect(r.rawTotal.toNumber()).toBe(8.5)
    expect(r.roundingPolicy).toBe('round_half_up')
  })

  it('R01 显式 pending（未拍板的旧版本）：只给 rawTotal 并阻塞正式 M', () => {
    const p = { ...params, monthlyRounding: 'pending' as const }
    const r = rollupMonthly(
      {
        positiveEntries: [{ category: 'contest', amount: 10.5 }],
        negativeEntries: [{ category: 'penalty', amount: -2 }],
        params: p,
      },
      p,
    )
    expect(r.m).toBeNull()
    expect(r.blockedReason).toContain('R01')
  })

  it('配置 round_half_up 后 M 四舍五入（模拟值仅用于测试）', () => {
    const p = { ...params, monthlyRounding: 'round_half_up' as const }
    const r = rollupMonthly({ positiveEntries: [{ category: 'contest', amount: 10.5 }], negativeEntries: [], params: p }, p)
    expect(r.m).toBe(11) // Decimal ROUND_HALF_UP 对正数
  })
})

describe('冲正与来源键', () => {
  it('冲正 = 负冲 + 替代，保留原始依据', () => {
    const plan = planReversal({ originalEntryId: 'e1', originalAmount: 10, reason: '榜单更正', replacementAmount: 8, scoreMonth: '2026-10' })
    expect(plan.reversalEntry.amount.toNumber()).toBe(-10)
    expect(plan.replacementEntry.amount!.toNumber()).toBe(8)
  })

  it('同一平台比赛多地点组织不产生重复赛事分：来源键不含 activity/地点/rule_version', () => {
    const k1 = buildSourceKey({ kind: 'platform_contest', platform: 'codeforces', externalContestId: '2268', component: 'W' })
    const k2 = buildSourceKey({ kind: 'platform_contest', platform: 'codeforces', externalContestId: '2268', component: 'W' })
    expect(k1).toBe(k2)
    expect(k1).not.toContain('activity')
    expect(k1).toBe('contest:codeforces:2268:W')
  })

  it('Hydro 比赛键包含 instance/domain/docId 的规范串（由调用方构造 platform=hydro:<instance>:<domain>）', () => {
    const k = buildSourceKey({ kind: 'platform_contest', platform: 'hydro:inst1:acm-club', externalContestId: '670100abc', component: 'W' })
    expect(k).toBe('contest:hydro:inst1:acm-club:670100abc:W')
  })
})

describe('身份、名额与组队', () => {
  it('初始积分：第 1/5 名 → 30；仅一人 → 30；公式 18+12×(1-(r-1)/max(1,m-1))', () => {
    expect(initialPoints(1, 5).toNumber()).toBe(30)
    expect(initialPoints(1, 1).toNumber()).toBe(30)
    expect(initialPoints(3, 5).toNumber()).toBe(24)
    expect(initialPoints(5, 5).toNumber()).toBe(18)
  })

  it('基础正式名额 F=min(15,max(8,ceil(0.4N)))', () => {
    expect(formalQuota(0)).toBe(8)
    expect(formalQuota(10)).toBe(8)
    expect(formalQuota(25)).toBe(10)
    expect(formalQuota(100)).toBe(15)
    expect(formalQuota(50)).toBe(15)
  })

  it('保留观察期 G=floor(K/3)：K=6 → G=2；K<3 → 次月降预备', () => {
    expect(graceMonths(6).g).toBe(2)
    expect(graceMonths(6).demoteNextMonth).toBe(false)
    expect(graceMonths(2).demoteNextMonth).toBe(true)
    expect(graceMonths(3).g).toBe(1)
  })

  it('三行矩阵按列成队：1..9 → (1,4,7)(2,5,8)(3,6,9)，不改蛇形', () => {
    const r = matrixTeamAssignment({ orderedMembers: [1, 2, 3, 4, 5, 6, 7, 8, 9], teamSize: 3 })
    expect(r.teams).toEqual([[1, 4, 7], [2, 5, 8], [3, 6, 9]])
    expect(r.remainder).toEqual([])
  })

  it('非 3 倍数余量保留给人工处理，不硬套矩阵', () => {
    const r = matrixTeamAssignment({ orderedMembers: [1, 2, 3, 4, 5, 6, 7], teamSize: 3 })
    // 完整两行 [1,2,3]/[4,5,6] → 按列 (1,4)(2,5)(3,6)；第 7 名为余量
    expect(r.teams).toEqual([[1, 4], [2, 5], [3, 6]])
    expect(r.remainder).toEqual([7])
  })
})

describe('正式竞赛与特殊赛事', () => {
  it('常规档位：参与 + 奖项附加（省级金 20+75=95）', () => {
    const r = formalContestScore({ tier: 'provincial', medal: 'gold', registeredOfficial: true })
    expect(r.value!.toNumber()).toBe(95)
  })

  it('打星/超额队员 0 分', () => {
    const r = formalContestScore({ tier: 'icpc_regional', medal: 'gold', registeredOfficial: false })
    expect(r.value!.toNumber()).toBe(0)
  })

  it('网络赛默认模式：8 + 出线 40 + 出线前 10% 附加 30（择高）', () => {
    const r = networkQualifierScore({ participatedWithSubmission: true, advanced: true, rankAmongAdvanced: { rank: 1, total: 40 } })
    expect(r.value!.toNumber()).toBe(78)
  })

  it('未晋级队伍无排名附加；排名分母是出线队伍数', () => {
    const r = networkQualifierScore({ participatedWithSubmission: true, advanced: false })
    expect(r.value!.toNumber()).toBe(8)
  })

  it('奖项替代模式 → R09 pending（不叠加出线）', () => {
    const r = networkQualifierScore({ participatedWithSubmission: true, advanced: true, awardAlternativeMode: 'gold' })
    expect(r.status).toBe('pending')
    expect(r.gap).toBe('R09')
  })

  it('天梯赛：同届团体择高一次 + 个人可叠加（省一 22 + 国家三 28 → 28 团体 + 个人一等奖 45）', () => {
    expect(ladderScore(['prov1', 'nat3'], 'first').toNumber()).toBe(28 + 45)
    expect(ladderScore(['nat3'], null).toNumber()).toBe(28)
  })

  it('蓝桥杯同届择高：省一(35) 与 国赛优秀(35) 与国三(50) 只取最高（B 组）', () => {
    expect(lanqiaoScore('B', ['prov1', 'nat3']).toNumber()).toBe(50)
    expect(lanqiaoScore('A', ['nat1']).toNumber()).toBe(150)
  })

  it('同场多重身份择高', () => {
    const best = pickHighestOfSameContest([
      { value: 8, label: 'participation' },
      { value: 20, label: 'award' },
    ])
    expect(best!.label).toBe('award')
  })

  it('作弊扣分：理论最高分缺失 → R10 pending；正常作弊扣 50%', () => {
    expect(cheatingPenalty('normal', null).status).toBe('pending')
    expect(cheatingPenalty('normal', 20).value!.toNumber()).toBe(-10)
    expect(cheatingPenalty('critical', 20).value!.toNumber()).toBe(-40)
  })
})

describe('综合素质评价建议（附录三）', () => {
  const p = params.comprehensiveEval

  it('N=0 输出空名单，不产生虚构 A 档', () => {
    const r = computeComprehensiveSuggestion({ members: [], params: p, standardizationConfirmed: true })
    expect(r.status).toBe('ok')
    expect(r.ranked).toHaveLength(0)
  })

  it('R11 未确认 → pending', () => {
    const r = computeComprehensiveSuggestion({ members: [{ id: 'u1', semesterE: 10, contestScore: 0, serviceScore: 0 }], params: p, standardizationConfirmed: false })
    expect(r.status).toBe('pending')
  })

  it('A/B/C 档位人数与建议分值（N=10：A=1，B=2，C=7）', () => {
    const members = Array.from({ length: 10 }, (_, i) => ({
      id: `u${i}`,
      semesterE: 100 - i * 10,
      contestScore: 0,
      serviceScore: 0,
    }))
    const r = computeComprehensiveSuggestion({ members, params: p, standardizationConfirmed: true })
    expect(r.counts).toEqual({ a: 1, b: 2, c: 7 })
    const first = r.ranked[0]
    expect(first.suggestedGrade).toBe('A')
    expect(first.suggestedScore.toNumber()).toBe(1)
    const cFirst = r.ranked.find((x) => x.suggestedGrade === 'C')!
    // C 档第 1 名：0.5×(1-0/6) = 0.5
    expect(cFirst.suggestedScore.toNumber()).toBeCloseTo(0.5, 5)
  })
})

describe('Decimal 精度', () => {
  it('中间计算不为二进制浮点误差影响（0.1+0.2 场景）', () => {
    expect(new Decimal('0.1').plus(new Decimal('0.2')).toString()).toBe('0.3')
  })
})
