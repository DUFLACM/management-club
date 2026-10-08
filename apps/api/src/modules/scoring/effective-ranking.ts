import { computeEffectiveScore, defaultRuleParams } from '@acm/scoring-core'
import { mergeRuleParams } from './rule-params.js'
import type { PrismaService } from '../../infrastructure/database/database.module.js'
import { memberName } from '../../common/utils.js'

/**
 * 当前有效榜的唯一口径（首页「当前有效榜排名」与榜单页「当前有效榜」共用，保证两处名次一致）。
 *
 * 全集是「在册的正式/预备/考察成员」，不是「有账本记录的人」：
 * 新入社、当月尚未产生任何已生效记录的成员按 E=0 参与排名，不会从榜上消失。
 * 月度聚合在 SQL 侧按 (user_id, score_month) 完成，且只取参与排名成员的行。
 */

/** 参与当前有效榜的成员身份（制度口径：正式/预备/考察） */
export const RANKED_MEMBERSHIPS: readonly string[] = ['formal', 'provisional', 'observing']

export interface RankedMember {
  userId: string
  displayName: string
  membership: string
  /** 排序用数值 E */
  e: number
  /** 展示用 E（保留一位小数） */
  eDisplay: string
}

/** 当前生效规则版本的 E 滚动权重（published → 最新 → 内置默认），与账本结算同源 */
export async function resolveEffectiveWeights(db: PrismaService): Promise<number[]> {
  const published = await db.ruleVersion.findFirst({ where: { status: 'published' }, orderBy: { version: 'desc' } })
  const rv = published ?? (await db.ruleVersion.findFirst({ orderBy: { version: 'desc' } }))
  return rv ? mergeRuleParams(rv.params).effectiveWeights : defaultRuleParams().effectiveWeights
}

export async function rankEligibleMembers(
  db: PrismaService,
  currentMonth: string,
  effectiveWeights: number[],
): Promise<RankedMember[]> {
  const users = await db.user.findMany({
    where: { accountStatus: 'active' },
    select: {
      id: true,
      verifiedRealName: true,
      profile: { select: { displayName: true } },
      membershipTerms: { orderBy: { createdAt: 'desc' }, take: 1, select: { membershipStatus: true } },
    },
  })
  const eligible = users
    .map((u) => ({
      id: u.id,
      displayName: memberName(u),
      membership: u.membershipTerms[0]?.membershipStatus ?? 'applicant',
    }))
    .filter((u) => RANKED_MEMBERSHIPS.includes(u.membership))
  if (eligible.length === 0) return []

  const grouped = await db.pointsLedgerEntry.groupBy({
    by: ['userId', 'scoreMonth'],
    where: { status: 'approved', userId: { in: eligible.map((u) => u.id) } },
    _sum: { amount: true },
  })
  const byUser = new Map<string, Record<string, number>>()
  for (const row of grouped) {
    if (!row.userId) continue
    const months = byUser.get(row.userId) ?? {}
    months[row.scoreMonth] = Number(row._sum.amount ?? 0)
    byUser.set(row.userId, months)
  }

  return eligible
    .map((u) => {
      const eff = computeEffectiveScore({ monthlyScores: byUser.get(u.id) ?? {}, currentMonth }, { effectiveWeights })
      return { userId: u.id, displayName: u.displayName, membership: u.membership, e: Number(eff.e), eDisplay: eff.eDisplay }
    })
    // 同分按 userId 升序：同一时刻首页与榜单页给出相同名次
    .sort((a, b) => b.e - a.e || a.userId.localeCompare(b.userId))
}

/** 不参与当前有效榜的原因（制度口径）；身份本应参与时由调用方按账号状态给说明 */
const EXCLUSION_REASONS: Record<string, string> = {
  applicant: '申请中：尚未获得入社资格，入社后自动进入当前有效榜',
  honorary_retired: '荣誉退役：按制度退出日常排名',
  withdrawn: '已退社：不参与当前有效榜',
  dismissed: '已除名：不参与当前有效榜',
  vetoed: '入社资格被否决：不参与当前有效榜',
}

export function rankExclusionReason(membership: string): string {
  return EXCLUSION_REASONS[membership] ?? `当前成员状态（${membership}）不参与当前有效榜`
}
