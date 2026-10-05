import { Decimal } from 'decimal.js'
import type { ScoreOutcome } from './rule-params.js'

/**
 * 正式竞赛与特殊赛事分（附录二第三~四节，附录一目录）。
 * 档位由协会认定并保存依据，不按标题关键词自判（R09/R13）。
 */

export type ContestTier =
  | 'school_select' // 校/院/社内正式选拔
  | 'provincial' // 省级 ACM 风格/校际邀请
  | 'icpc_invite' // ICPC/CCPC 邀请赛
  | 'icpc_regional' // ICPC/CCPC 区域/分站
  | 'top_final' // 附录第六档高水平决赛

export type MedalLevel = 'gold' | 'silver' | 'bronze' | 'honorable' | null

const TIER_TABLE: Record<ContestTier, { participation: number; medal: Record<Exclude<MedalLevel, null>, number> }> = {
  school_select: { participation: 10, medal: { gold: 30, silver: 22, bronze: 15, honorable: 6 } },
  provincial: { participation: 20, medal: { gold: 75, silver: 50, bronze: 35, honorable: 12 } },
  icpc_invite: { participation: 30, medal: { gold: 110, silver: 80, bronze: 55, honorable: 6 } },
  icpc_regional: { participation: 40, medal: { gold: 160, silver: 115, bronze: 80, honorable: 12 } },
  top_final: { participation: 50, medal: { gold: 220, silver: 160, bronze: 115, honorable: 15 } },
}

export interface FormalContestInput {
  tier: ContestTier
  medal: MedalLevel
  /** 正式注册队员按队伍结果计；打星/超额/随队人员不取得参与与奖项分 */
  registeredOfficial: boolean
}

/** 参与分 + 奖项附加（同档取最高一项，不累加） */
export function formalContestScore(input: FormalContestInput): ScoreOutcome {
  if (!input.registeredOfficial) {
    return {
      status: 'ok',
      value: new Decimal(0),
      decisions: [{ step: 'eligibility', note: '打星/超额非正式队员/随队人员：不取得正式比赛参与与奖项分' }],
    }
  }
  const table = TIER_TABLE[input.tier]
  const participation = new Decimal(table.participation)
  if (input.medal == null) {
    return { status: 'ok', value: participation, decisions: [{ step: 'participation', note: `档位参与分 ${participation}` }] }
  }
  const bonus = new Decimal(table.medal[input.medal])
  return {
    status: 'ok',
    value: participation.plus(bonus),
    decisions: [{ step: 'medal', note: `参与 ${participation} + ${input.medal} 奖项 ${bonus}` }],
  }
}

/** 网络预选赛：默认模式 参与且有有效提交 8；出线 +40；出线队伍中前 30% +15 / 前 10% +30（择高） */
export interface NetworkQualifierInput {
  participatedWithSubmission: boolean
  advanced: boolean
  /** 已出线队伍内排名百分位（0-1）；未出线不参与排名附加 */
  rankAmongAdvanced?: { rank: number; total: number } | null
  /** R09：奖项替代模式（金 75/银 55/铜 38/优胜 10）是否叠加参与 8 未确认 */
  awardAlternativeMode?: MedalLevel | null
}

export function networkQualifierScore(input: NetworkQualifierInput): ScoreOutcome {
  const decisions: ScoreOutcome['decisions'] = []
  if (!input.participatedWithSubmission) {
    return { status: 'ok', value: new Decimal(0), decisions: [{ step: 'base', note: '无实际参赛或无有效提交：0 分' }] }
  }
  if (input.awardAlternativeMode != null) {
    const alt: Record<string, number> = { gold: 75, silver: 55, bronze: 38, honorable: 10 }
    return {
      status: 'pending',
      gap: 'R09',
      pendingReason: '奖项替代模式是否叠加参与 8 分未确认（R09），转人工审核',
      decisions: [{ step: 'alt', note: `替代奖项值 ${alt[input.awardAlternativeMode]}，叠加口径待确认` }],
    }
  }
  let score = new Decimal(8)
  decisions.push({ step: 'base', note: '实际参赛且有有效提交：8 分' })
  if (input.advanced) {
    score = score.plus(40)
    decisions.push({ step: 'advance', note: '正式出线/晋级：+40' })
    if (input.rankAmongAdvanced && input.rankAmongAdvanced.total > 0) {
      const pct = input.rankAmongAdvanced.rank / input.rankAmongAdvanced.total
      const extra = pct <= 0.1 ? 30 : pct <= 0.3 ? 15 : 0
      if (extra > 0) {
        score = score.plus(extra)
        decisions.push({ step: 'rank', note: `出线队伍中 ${input.rankAmongAdvanced.rank}/${input.rankAmongAdvanced.total} → 附加 ${extra}（择高）` })
      }
    }
  } else {
    decisions.push({ step: 'rank', note: '未晋级队伍不取得排名附加分' })
  }
  return { status: 'ok', value: score, decisions }
}

/** 天梯赛：无参与分；同届团体奖取最高一次，个人国家奖可与团体奖叠加 */
export type LadderTeamAward = 'prov3' | 'prov2' | 'prov1' | 'nat3' | 'nat2' | 'nat1' | 'special'
export type LadderIndividualAward = 'third' | 'second' | 'first' | 'special'

export const LADDER_TEAM: Record<LadderTeamAward, number> = {
  prov3: 8, prov2: 14, prov1: 22, nat3: 28, nat2: 45, nat1: 75, special: 135,
}
export const LADDER_INDIVIDUAL: Record<LadderIndividualAward, number> = {
  third: 14, second: 25, first: 45, special: 90,
}

export function ladderScore(teamAwards: LadderTeamAward[], individual: LadderIndividualAward | null): Decimal {
  const bestTeam = teamAwards.length
    ? Math.max(...teamAwards.map((a) => LADDER_TEAM[a]))
    : 0
  const indiv = individual ? LADDER_INDIVIDUAL[individual] : 0
  return new Decimal(bestTeam + indiv)
}

/** 蓝桥杯：无参与分；同届同成员只按最高奖项计一次（省赛国赛不累计）。B 组/A 组分表。 */
export type LanqiaoAward =
  | 'prov3' | 'prov2' | 'prov1' | 'nat_excellent'
  | 'nat3' | 'nat2' | 'nat1'

export const LANQIAO_B: Record<LanqiaoAward, number> = {
  prov3: 12, prov2: 22, prov1: 35, nat_excellent: 35, nat3: 50, nat2: 70, nat1: 90,
}
export const LANQIAO_A: Record<LanqiaoAward, number> = {
  prov3: 15, prov2: 25, prov1: 40, nat_excellent: 40, nat3: 65, nat2: 95, nat1: 150,
}

export function lanqiaoScore(group: 'A' | 'B', awards: LanqiaoAward[]): Decimal {
  const table = group === 'A' ? LANQIAO_A : LANQIAO_B
  const best = awards.length ? Math.max(...awards.map((a) => table[a])) : 0
  return new Decimal(best)
}

/** 百度之星：无参与分；初赛 40/60/90，决赛 110/145/200（铜/银/金）。跨阶段独立计分依公告。 */
export function baiduStarScore(preliminary: MedalLevel, final: MedalLevel): Decimal {
  const pre: Record<string, number> = { bronze: 40, silver: 60, gold: 90 }
  const fin: Record<string, number> = { bronze: 110, silver: 145, gold: 200 }
  const p = preliminary ? new Decimal(pre[preliminary] ?? 0) : new Decimal(0)
  const f = final ? new Decimal(fin[final] ?? 0) : new Decimal(0)
  return p.plus(f)
}

/**
 * 同场多重身份择高：同场多重身份赛事择已认定最高档一次计分；
 * 独立阶段（网络赛/邀请赛/分站/总决赛）可分别计分；
 * 同场热身/试机不独立得分（仅热身未参加正赛按未参赛）。
 */
export function pickHighestOfSameContest<T extends { value: Decimal | number; label: string }>(entries: T[]): T | null {
  if (!entries.length) return null
  return entries.reduce((best, cur) => (new Decimal(cur.value).gt(new Decimal(best.value)) ? cur : best))
}

/**
 * 作弊处理：清零该场得分 + 扣该场理论最高分比例。
 * 理论最高分引用赛前规则上限；正式赛事无清晰上限时 R10 → pending。
 */
export function cheatingPenalty(
  severity: 'normal' | 'severe' | 'critical',
  contestTheoreticalMax: number | Decimal | null,
): ScoreOutcome {
  if (contestTheoreticalMax == null || new Decimal(contestTheoreticalMax).lte(0)) {
    return { status: 'pending', gap: 'R10', pendingReason: '该场理论最高分未公布（R10），扣分数额转人工认定', decisions: [] }
  }
  const ratio = severity === 'normal' ? 0.5 : severity === 'severe' ? 1.0 : 2.0
  const penalty = new Decimal(contestTheoreticalMax).mul(ratio).neg()
  return {
    status: 'ok',
    value: penalty,
    decisions: [
      { step: 'cheating', note: `清零该场得分并另扣理论最高分 ${ratio * 100}%（${penalty}）；一票否决程序另按制度启动` },
    ],
  }
}
