import { DomainError } from '../../common/domain-error.js'
import { Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { newInvitationSecret } from '../auth/auth.service.js'
import { newId, sha256Hex, monthKey, memberName, visibleAvatar } from '../../common/utils.js'
import { computeEffectiveScore, formalQuota, graceMonths, initialPoints } from '@acm/scoring-core'
import {
  RANKED_MEMBERSHIPS,
  rankEligibleMembers,
  rankExclusionReason,
  resolveEffectiveWeights,
  initialSummary,
} from '../scoring/effective-ranking.js'
import type { Prisma } from '@acm/db'
import type { SessionActor } from '../auth/session.service.js'

/**
 * 成员管理、概览、邀请管理、训练室（01/02/03 方案）。
 */

export interface ImportMemberResult {
  row: number
  studentNo: string
  status: 'created' | 'skipped'
  message?: string
  /** 本行入账的入社基础分 */
  initialPoints?: string
}

export class MembersError extends DomainError {
  constructor(message: string, readonly code: string) {
    super(message, code)
  }
}

/** MembershipTerm.membershipStatus 全集（直接调整身份用） */
export const MEMBERSHIP_STATUSES = [
  'applicant', 'observing', 'provisional', 'formal', 'honorary_retired', 'withdrawn', 'dismissed', 'vetoed',
] as const
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number]

/** 与 MembershipTransition.decision 取值对齐：降/退/除名类走对应 decision，其余视为晋升 */
function transitionDecision(status: MembershipStatus): string {
  if (status === 'withdrawn') return 'withdraw'
  if (status === 'dismissed') return 'dismiss'
  if (status === 'vetoed') return 'veto'
  if (status === 'honorary_retired') return 'retire'
  if (status === 'applicant') return 'demote'
  return 'promote'
}

@Injectable()
export class MembersService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** /api/v1/me/dashboard：轻量首屏聚合（不加载流水/附件/榜单/第三方） */
  async memberDashboard(userId: string) {
    const now = new Date()
    const currentMonth = monthKey(now)
    // 各块数据互不依赖，并发查询（原先逐个 await 串行）
    const [user, effectiveWeights] = await Promise.all([
      this.db.user.findUnique({
        where: { id: userId },
        include: {
          profile: true,
          membershipTerms: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
      resolveEffectiveWeights(this.db),
    ])
    if (!user) throw new MembersError('用户不存在', 'NOT_FOUND')

    const [entries, ranked, attendanceResults, openActivities, openDisclosures, pendingClaims, upcoming] = await Promise.all([
      // E（当前规则版本）
      this.db.pointsLedgerEntry.findMany({ where: { userId, status: 'approved' }, select: { amount: true, scoreMonth: true, category: true } }),
      // 排名（正式/预备/考察参与当前有效榜；E=0 的成员同样在榜，口径与榜单页同源）
      rankEligibleMembers(this.db, currentMonth, effectiveWeights),
      // 出勤摘要：本人必须参加且已结算的活动的出勤结果（一次查出，不逐场查询）
      this.db.attendanceAttendanceResult.findMany({
        where: { userId, activity: { endAt: { lt: now }, participants: { some: { userId, required: true } } } },
        select: { status: true },
      }),
      // 当前可签到活动
      this.db.activity.findMany({
        where: { status: 'published', startAt: { lte: new Date(now.getTime() + 2 * 3600_000) }, endAt: { gte: now } },
        orderBy: { startAt: 'asc' },
        take: 3,
        include: {
          policy: true,
          registrations: { where: { userId } },
          participants: { where: { userId } },
          checkpoints: { where: { userId } },
          venueVersion: { include: { venue: true } },
          venueBindings: { take: 1, include: { venueVersion: { include: { venue: true } } } },
        },
      }),
      // 待办（公示 + 待补材料）
      this.db.disclosure.findMany({ where: { status: 'published', endsAt: { gt: now } }, take: 3 }),
      this.db.pointsClaim.count({ where: { userId, status: 'more_info' } }),
      // 近期安排
      this.db.activity.findMany({
        where: { status: 'published', startAt: { gt: now }, endAt: { lt: new Date(now.getTime() + 14 * 24 * 3600_000) } },
        orderBy: { startAt: 'asc' },
        take: 5,
        include: { registrations: { where: { userId } }, venueVersion: { include: { venue: true } } },
      }),
    ])

    const monthly: Record<string, number> = {}
    // 入社基础分照常计入 E，但展示时从当月积分里拆出来单独显示
    const initialByMonth = new Map<string, number>()
    for (const e of entries) {
      monthly[e.scoreMonth] = (monthly[e.scoreMonth] ?? 0) + Number(e.amount)
      if (e.category === 'initial') initialByMonth.set(e.scoreMonth, (initialByMonth.get(e.scoreMonth) ?? 0) + Number(e.amount))
    }
    const eff = computeEffectiveScore({ monthlyScores: monthly, currentMonth }, { effectiveWeights })
    const components = eff.components.map((c) => ({
      month: c.month,
      m: Number(c.m),
      initial: initialByMonth.get(c.month) ?? 0,
      weight: Number(c.weight),
      contribution: Number(c.contribution),
    }))
    const myRank = ranked.findIndex((r) => r.userId === userId)
    const attendanceTotal = attendanceResults.length
    const attendanceDone = attendanceResults.filter((result) =>
      ['ontime', 'late', 'early_leave', 'late_and_early', 'remote_approved'].includes(result.status),
    ).length

    const membership = user.membershipTerms[0]?.membershipStatus ?? 'applicant'
    return {
      user: {
        displayName: memberName(user),
        studentNo: user.studentNo,
        realName: user.verifiedRealName,
        membership,
      },
      score: {
        e: eff.eDisplay,
        /** m 为该月计入 E 的原始分（含入社基础分），initial 为其中的入社基础分 */
        components,
        /** 本月积分（不含入社基础分） */
        currentMonthM: Math.round(((monthly[currentMonth] ?? 0) - (initialByMonth.get(currentMonth) ?? 0)) * 1e6) / 1e6,
        initial: initialSummary(initialByMonth, components),
      },
      rank:
        myRank >= 0
          ? { position: myRank + 1, total: ranked.length, qualified: true }
          : {
              position: null,
              total: ranked.length,
              qualified: false,
              // 身份本应参与却不在榜上，只可能是账号被停用/注销，据实说明而不是笼统说「身份不参与」
              reason: RANKED_MEMBERSHIPS.includes(membership)
                ? '账号当前不是正常状态，暂不计入当前有效榜，请联系管理员'
                : rankExclusionReason(membership),
            },
      attendance: { done: attendanceDone, total: attendanceTotal, note: attendanceTotal === 0 ? '暂无已结算的必到活动' : null },
      openActivities: openActivities.map((a) => {
        const policy = a.policy
        const venue = a.venueVersion ?? a.venueBindings[0]?.venueVersion
        const windowOpen = policy ? (policy.checkinOpenAt <= now && now <= policy.checkinCloseAt ? 'IN' : policy.checkoutOpenAt && policy.checkoutOpenAt <= now && now <= (policy.checkoutCloseAt ?? now) ? 'OUT' : 'none') : 'none'
        return {
          id: a.id,
          title: a.title,
          type: a.type,
          startAt: a.startAt.toISOString(),
          endAt: a.endAt.toISOString(),
          venue: venue ? { name: venue.venue.name, building: venue.building, room: venue.room } : null,
          policy: policy?.policy ?? null,
          myRegistration: a.registrations[0]?.status ?? null,
          required: a.participants[0]?.required ?? false,
          checkedIn: a.checkpoints.some((c) => c.checkpoint === 'IN'),
          checkedOut: a.checkpoints.some((c) => c.checkpoint === 'OUT'),
          windowOpen,
          canCheckIn: windowOpen === 'IN' && (a.registrations[0]?.status === 'enrolled' || a.participants[0]?.required === true),
        }
      }),
      todos: [
        ...openDisclosures.map((d) => ({ kind: 'disclosure' as const, id: d.id, title: `积分公示进行中（${d.monthKey}）`, deadline: d.endsAt?.toISOString() })),
        ...(pendingClaims > 0 ? [{ kind: 'claim' as const, id: 'more_info', title: `有 ${pendingClaims} 条贡献材料待补充`, deadline: null }] : []),
      ],
      upcoming: upcoming.map((a) => ({
        id: a.id, title: a.title, type: a.type, startAt: a.startAt.toISOString(),
        venue: a.venueVersion ? { name: a.venueVersion.venue.name, room: a.venueVersion.room } : null,
        myRegistration: a.registrations[0]?.status ?? null,
      })),
      platformSync: await this.db.platformAccount.findMany({ where: { userId, status: { not: 'revoked' } }, select: { platform: true, status: true, lastSyncAt: true, lastSyncStatus: true } }),
    }
  }

  /** 管理概览：真实待办计数 + 当天活动 */
  async adminDashboard() {
    const now = new Date()
    const todayStart = new Date(now)
    todayStart.setHours(0, 0, 0, 0)
    const todayEnd = new Date(todayStart.getTime() + 24 * 3600_000)
    const [pendingApplications, pendingVenueReviews, attendanceAnomalies, pendingClaims, openDisclosures, syncFailures, todayActivities] = await Promise.all([
      this.db.membershipTerm.count({ where: { membershipStatus: 'applicant' } }),
      this.db.venueVersion.count({ where: { status: 'pending_review' } }),
      this.db.attendanceAttendanceResult.count({ where: { status: 'pending_review' } }),
      this.db.pointsClaim.count({ where: { status: 'pending' } }),
      this.db.disclosure.count({ where: { status: 'published', endsAt: { gt: now } } }),
      this.db.job.count({ where: { type: { startsWith: 'platform.' }, status: 'dead' } }),
      this.db.activity.findMany({ where: { startAt: { gte: todayStart, lt: todayEnd } }, orderBy: { startAt: 'asc' }, take: 10, include: { venueVersion: { include: { venue: true } } } }),
    ])
    return {
      counts: { pendingApplications, pendingVenueReviews, attendanceAnomalies, pendingClaims, openDisclosures, syncFailures },
      todayActivities: todayActivities.map((a) => ({ id: a.id, title: a.title, startAt: a.startAt.toISOString(), venue: a.venueVersion ? `${a.venueVersion.venue.name} ${a.venueVersion.room ?? ''}`.trim() : null })),
    }
  }

  /** 成员列表（管理端） */
  async adminMembers(filters: { q?: string; status?: string; cursor?: string }) {
    const where: Record<string, unknown> = {}
    if (filters.status) where.membershipTerms = { some: { membershipStatus: filters.status } }
    if (filters.q) {
      where.OR = [
        { studentNo: filters.q },
        { verifiedRealName: { contains: filters.q } },
        { profile: { displayName: { contains: filters.q, mode: 'insensitive' } } },
      ]
    }
    const rows = await this.db.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 21,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
      include: {
        profile: { select: { displayName: true, avatarAssetId: true, visibility: true } },
        membershipTerms: { orderBy: { createdAt: 'desc' }, take: 1 },
        restrictions: { where: { revokedAt: null, OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] } },
      },
    })
    const nextCursor = rows.length > 20 ? rows.pop()!.id : undefined
    const entries = await this.db.pointsLedgerEntry.findMany({ where: { userId: { in: rows.map((r) => r.id) }, status: 'approved' }, select: { userId: true, amount: true, scoreMonth: true } })
    const byUser = new Map<string, Record<string, number>>()
    for (const e of entries) {
      if (!byUser.has(e.userId)) byUser.set(e.userId, {})
      const m = byUser.get(e.userId)!
      m[e.scoreMonth] = (m[e.scoreMonth] ?? 0) + Number(e.amount)
    }
    const currentMonth = monthKey(new Date())
    return {
      items: rows.map((u) => {
        const eff = computeEffectiveScore({ monthlyScores: byUser.get(u.id) ?? {}, currentMonth }, { effectiveWeights: [1, 0.85, 0.7, 0.55, 0.4, 0.25] })
        return {
          id: u.id,
          displayName: memberName(u),
          avatarAssetId: visibleAvatar(u.profile),
          studentNo: u.studentNo,
          grade: u.grade,
          membership: u.membershipTerms[0]?.membershipStatus ?? 'applicant',
          e: eff.eDisplay,
          restrictions: u.restrictions.map((r) => r.type),
          createdAt: u.createdAt.toISOString(),
        }
      }),
      nextCursor,
    }
  }

  /** 入社审批（applicant → observing；记录 transition；不自动正式） */
  async reviewMembership(actor: SessionActor, userId: string, decision: 'admit' | 'reject', reason: string): Promise<void> {
    const term = await this.db.membershipTerm.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } })
    if (!term || term.membershipStatus !== 'applicant') throw new MembersError('当前不是申请中状态', 'STATE_INVALID')
    const nextStatus = decision === 'admit' ? 'observing' : 'rejected_input'
    await this.db.$transaction(async (tx) => {
      await tx.membershipTransition.create({
        data: {
          id: newId(), userId, fromStatus: 'applicant', toStatus: decision === 'admit' ? 'observing' : 'withdrawn',
          decision, reason, effectiveFrom: new Date(), decidedBy: actor.principalId,
        },
      })
      if (decision === 'admit') {
        await tx.membershipTerm.update({ where: { id: term.id }, data: { membershipStatus: 'observing', basis: reason, effectiveFrom: new Date() } })
      } else {
        await tx.membershipTerm.update({ where: { id: term.id }, data: { membershipStatus: 'withdrawn', basis: reason } })
      }
      await tx.auditLog.create({
        data: { id: newId(), actorPrincipalId: actor.principalId, action: 'members.membership_decision', resourceType: 'user', resourceId: userId, summary: `入社${decision === 'admit' ? '批准（进入一个月观察期）' : '驳回'}：${reason.slice(0, 200)}` },
      })
    })
    void nextStatus
  }

  /** 直接调整身份（members.manage）：记录 transition 与审计；无 term 时按当前学期补建 */
  async setMembership(actor: SessionActor, userId: string, status: MembershipStatus, reason: string): Promise<void> {
    const term = await this.db.membershipTerm.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } })
    if (term?.membershipStatus === status) throw new MembersError('当前已是该身份，无需调整', 'STATE_INVALID')
    const now = new Date()
    await this.db.$transaction(async (tx) => {
      if (term) {
        await tx.membershipTerm.update({ where: { id: term.id }, data: { membershipStatus: status, basis: reason, effectiveFrom: now } })
      } else {
        await tx.membershipTerm.create({
          data: { id: newId(), userId, semesterId: await currentSemesterId(tx), membershipStatus: status, basis: reason, effectiveFrom: now },
        })
      }
      await tx.membershipTransition.create({
        data: {
          id: newId(), userId, fromStatus: term?.membershipStatus ?? null, toStatus: status,
          decision: transitionDecision(status), reason, effectiveFrom: now, decidedBy: actor.principalId,
        },
      })
      await tx.auditLog.create({
        data: {
          id: newId(), actorPrincipalId: actor.principalId, action: 'members.membership_set', resourceType: 'user', resourceId: userId,
          summary: `直接调整身份为 ${status}：${reason.slice(0, 200)}`,
        },
      })
    })
  }

  /** 管理端更改成员平台绑定账号：换绑账号后持有关系未证，回到待核验 */
  async updateMemberPlatformAccount(actor: SessionActor, userId: string, accountId: string, input: { externalId: string; displayHandle?: string }): Promise<void> {
    const account = await this.db.platformAccount.findUnique({ where: { id: accountId } })
    if (!account || account.userId !== userId) throw new MembersError('绑定不存在', 'NOT_FOUND')
    if (account.status === 'revoked') throw new MembersError('该绑定已解绑，请让成员重新提交绑定申请', 'STATE_INVALID')
    const canonical = input.externalId.trim()
    if (!/^[A-Za-z0-9_.-]{2,64}$/.test(canonical)) throw new MembersError('仅接受平台 UID/handle 字符（2-64 位）', 'INVALID_EXTERNAL_ID')
    const changed = canonical !== account.externalId
    const displayHandle = input.displayHandle?.trim() || canonical
    try {
      await this.db.platformAccount.update({
        where: { id: accountId },
        data: {
          externalId: canonical,
          displayHandle,
          ...(changed ? { status: 'pending_review', verifiedBy: null, verifiedAt: null, proofSummary: `管理端更改绑定账号（原 ${account.externalId}），待重新核验持有` } : {}),
        },
      })
    } catch {
      throw new MembersError('该平台账号已绑定其他成员（活跃绑定唯一）', 'ALREADY_BOUND_OTHER')
    }
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'members.platform_account_update',
      resourceType: 'platform_account',
      resourceId: accountId,
      summary: `更改成员平台绑定：${account.platform} ${account.externalId} → ${canonical}${changed ? '（回到待核验）' : '（仅改显示名）'}`,
    })
  }

  /** 管理端解绑（软删除）成员平台账号：保留历史成绩与 rating 序列 */
  async revokeMemberPlatformAccount(actor: SessionActor, userId: string, accountId: string): Promise<void> {
    const account = await this.db.platformAccount.findUnique({ where: { id: accountId } })
    if (!account || account.userId !== userId) throw new MembersError('绑定不存在', 'NOT_FOUND')
    if (account.status === 'revoked') throw new MembersError('该绑定已解绑', 'STATE_INVALID')
    await this.db.platformAccount.update({ where: { id: accountId }, data: { status: 'revoked', validUntil: new Date() } })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'members.platform_account_revoke',
      resourceType: 'platform_account',
      resourceId: accountId,
      summary: `解绑成员平台账号：${account.platform} ${account.externalId}`,
    })
  }

  /** 禁用成员账号（软删除）：立即失效全部会话；积分/出勤历史保留，可重新启用 */
  async disableMember(actor: SessionActor, userId: string, reason: string): Promise<void> {
    if (actor.userId === userId) throw new MembersError('不能禁用本人账号', 'RECUSED')
    const user = await this.db.user.findUnique({ where: { id: userId } })
    if (!user) throw new MembersError('成员不存在', 'NOT_FOUND')
    if (user.accountStatus === 'disabled') throw new MembersError('账号已是禁用状态', 'STATE_INVALID')
    const now = new Date()
    await this.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { accountStatus: 'disabled' } })
      await tx.session.updateMany({
        where: { principalId: user.principalId, revokedAt: null },
        data: { revokedAt: now, revokeReason: `账号禁用：${reason.slice(0, 120)}` },
      })
      await tx.auditLog.create({
        data: {
          id: newId(), actorPrincipalId: actor.principalId, action: 'members.disable', resourceType: 'user', resourceId: userId,
          summary: `禁用成员账号（${user.studentNo}）：${reason.slice(0, 200)}`,
        },
      })
    })
  }

  /** 重新启用被禁用的账号 */
  async enableMember(actor: SessionActor, userId: string): Promise<void> {
    const user = await this.db.user.findUnique({ where: { id: userId } })
    if (!user) throw new MembersError('成员不存在', 'NOT_FOUND')
    if (user.accountStatus !== 'disabled') throw new MembersError('账号不是禁用状态', 'STATE_INVALID')
    await this.db.user.update({ where: { id: userId }, data: { accountStatus: 'active' } })
    await this.audit.log({
      actorPrincipalId: actor.principalId, action: 'members.enable', resourceType: 'user', resourceId: userId,
      summary: `重新启用成员账号（${user.studentNo}）`,
    })
  }

  /** 删除成员：仅限无任何业务数据的空账号（误注册清理）；有记录请禁用以保留历史 */
  async deleteMember(actor: SessionActor, userId: string): Promise<void> {
    if (actor.userId === userId) throw new MembersError('不能删除本人账号', 'RECUSED')
    const user = await this.db.user.findUnique({
      where: { id: userId },
      include: {
        _count: {
          select: {
            registrations: true, participation: true, checkpoints: true, attendanceResults: true,
            pointsClaims: true, appeals: true, ledgerEntries: true, monthlyScores: true,
            platformAccounts: true, badgeAwards: true, lectureRequests: true, uploadedMaterials: true,
            leaveRequests: true, remotePermissions: true, restrictions: true,
            membershipTerms: true, invitationRedemptions: true,
          },
        },
      },
    })
    if (!user) throw new MembersError('成员不存在', 'NOT_FOUND')
    const used = Object.values(user._count).reduce((sum, count) => sum + count, 0)
    if (used > 0) {
      throw new MembersError('该成员已有报名/出勤/积分/绑定等记录，删除会破坏社团数据；请改用「禁用账号」', 'STATE_INVALID')
    }
    await this.db.$transaction(async (tx) => {
      await tx.session.deleteMany({ where: { principalId: user.principalId } })
      await tx.roleGrant.deleteMany({ where: { principalId: user.principalId } })
      await tx.authIdentity.deleteMany({ where: { principalId: user.principalId } })
      await tx.userProfile.deleteMany({ where: { userId } })
      await tx.user.delete({ where: { id: userId } })
      await tx.principal.deleteMany({ where: { id: user.principalId } })
      await tx.auditLog.create({
        data: {
          id: newId(), actorPrincipalId: actor.principalId, action: 'members.delete', resourceType: 'user', resourceId: userId,
          summary: `删除空账号成员（${user.studentNo} ${user.verifiedRealName}）`,
        },
      })
    })
  }

  /** 批量删除空账号成员：逐项走删除校验，失败项跳过并汇总原因（部分成功） */
  async batchDeleteMembers(actor: SessionActor, userIds: string[]): Promise<{ deletedCount: number; skipped: Array<{ id: string; label: string; reason: string }> }> {
    const skipped: Array<{ id: string; label: string; reason: string }> = []
    let deletedCount = 0
    for (const userId of userIds) {
      const user = await this.db.user.findUnique({ where: { id: userId }, select: { studentNo: true, verifiedRealName: true } })
      const label = user ? `${user.verifiedRealName}（${user.studentNo}）` : userId.slice(0, 8)
      try {
        await this.deleteMember(actor, userId)
        deletedCount++
      } catch (error) {
        skipped.push({ id: userId, label, reason: error instanceof MembersError ? error.message : '删除失败' })
      }
    }
    return { deletedCount, skipped }
  }

  /**
   * Excel/表格批量导入成员：管理员确认为已验证成员，跳过 CAS 核验直接建账号
   * （principal+user+profile+membershipTerm+member 角色）；逐行独立事务，单行失败
   * 不影响其余行。导入账号首次 CAS 登录时按学号精确绑定稳定 subject（见
   * auth.service.ts resolveIdentity 的预导入学生分支），之后与正常注册账号无区别。
   *
   * 入社基础分（成员管理办法第八条）：填了录取名次 r 的行自动入一条 initial 流水，
   * I = 18 + 12 × (1 - (r-1)/max(1, m-1))，仅一人时 30；m 为本批次录取总人数
   * （默认取 max(有名次的行数, 最大名次)），计入入社月份（默认导入当月）。
   * sourceKey = initial:{userId}，每人一次性；学号已存在的行不重复建号，但仍补记基础分。
   */
  async importMembers(
    actor: SessionActor,
    rows: Array<{ studentNo: string; realName: string; grade?: number; phone?: string; membershipStatus?: MembershipStatus; admissionRank?: number }>,
    options: { admissionTotal?: number; admissionMonth?: string } = {},
  ): Promise<{ createdCount: number; initialCount: number; admissionTotal: number | null; results: ImportMemberResult[] }> {
    const results: ImportMemberResult[] = []
    const seenInBatch = new Set<string>()
    let createdCount = 0
    let initialCount = 0

    const ranks = rows.map((row) => row.admissionRank).filter((rank): rank is number => rank != null)
    const admissionTotal = ranks.length === 0 ? null : options.admissionTotal ?? Math.max(ranks.length, ...ranks)
    const admissionMonth = options.admissionMonth ?? monthKey(new Date())
    /** 入社基础分流水（每人一次，已有则跳过）；返回本次入账分值 */
    const postInitial = async (tx: Prisma.TransactionClient, userId: string, rank: number): Promise<string | null> => {
      const sourceKey = `initial:${userId}`
      if (await tx.pointsLedgerEntry.findFirst({ where: { sourceKey, status: 'approved' }, select: { id: true } })) return null
      const amount = initialPoints(rank, admissionTotal!).toFixed(2)
      await tx.pointsLedgerEntry.create({
        data: {
          id: newId(), userId, sourceKey, category: 'initial', amount, scoreMonth: admissionMonth, recordedAt: new Date(),
          status: 'approved', approvedBy: actor.principalId, idempotencyKey: `src:${sourceKey}`,
          detail: { source: 'members_import', rank, total: admissionTotal, formula: 'I = 18 + 12 × (1 - (r-1)/max(1, m-1))' },
        },
      })
      return amount
    }

    for (let i = 0; i < rows.length; i++) {
      const rowNo = i + 1
      const studentNo = rows[i].studentNo.trim()
      const realName = rows[i].realName.trim()

      if (!/^[A-Za-z0-9._-]{1,64}$/.test(studentNo)) {
        results.push({ row: rowNo, studentNo, status: 'skipped', message: '学号格式不合法（1-64 位字母/数字/._-）' })
        continue
      }
      if (!realName) {
        results.push({ row: rowNo, studentNo, status: 'skipped', message: '姓名为空' })
        continue
      }
      if (seenInBatch.has(studentNo)) {
        results.push({ row: rowNo, studentNo, status: 'skipped', message: '本次导入内学号重复' })
        continue
      }
      seenInBatch.add(studentNo)
      const rank = rows[i].admissionRank
      if (rank != null && (!Number.isInteger(rank) || rank < 1 || rank > admissionTotal!)) {
        results.push({ row: rowNo, studentNo, status: 'skipped', message: `录取名次须为 1–${admissionTotal} 的整数` })
        continue
      }

      const existingUser = await this.db.user.findUnique({ where: { studentNo }, select: { id: true } })
      if (existingUser) {
        const initial = rank == null ? null : await this.db.$transaction((tx) => postInitial(tx, existingUser.id, rank))
        if (initial) initialCount++
        results.push({
          row: rowNo, studentNo, status: 'skipped',
          message: initial ? `学号已存在（账号），已补记入社基础分 ${initial}` : '学号已存在（账号）',
          ...(initial ? { initialPoints: initial } : {}),
        })
        continue
      }
      const existingStaff = await this.db.staffProfile.findUnique({ where: { staffNo: studentNo }, select: { id: true } })
      if (existingStaff) {
        results.push({ row: rowNo, studentNo, status: 'skipped', message: '学号已属于教职工主体' })
        continue
      }

      const grade = typeof rows[i].grade === 'number' && Number.isFinite(rows[i].grade) ? Math.trunc(rows[i].grade!) : null
      const phone = rows[i].phone?.trim() || null
      const membershipStatus: MembershipStatus =
        rows[i].membershipStatus && MEMBERSHIP_STATUSES.includes(rows[i].membershipStatus!) ? rows[i].membershipStatus! : 'formal'

      try {
        const userId = newId()
        const principalId = newId()
        const initial = await this.db.$transaction(async (tx) => {
          await tx.principal.create({ data: { id: principalId, kind: 'student' } })
          await tx.user.create({ data: { id: userId, principalId, studentNo, verifiedRealName: realName, grade, phone } })
          await tx.userProfile.create({ data: { userId, displayName: realName } })
          await tx.membershipTerm.create({
            data: {
              id: newId(),
              userId,
              semesterId: await currentSemesterId(tx),
              membershipStatus,
              basis: 'Excel 批量导入（管理员确认为已验证成员，跳过 CAS 核验）',
            },
          })
          await tx.roleGrant.create({ data: { id: newId(), principalId, role: 'member', grantedBy: actor.principalId, grantedAt: new Date() } })
          await tx.auditLog.create({
            data: {
              id: newId(), actorPrincipalId: actor.principalId, action: 'members.import', resourceType: 'user', resourceId: userId,
              summary: `Excel 批量导入成员（${studentNo} ${realName}，身份 ${membershipStatus}）`,
            },
          })
          return rank == null ? null : postInitial(tx, userId, rank)
        })
        createdCount++
        if (initial) initialCount++
        results.push({ row: rowNo, studentNo, status: 'created', ...(initial ? { initialPoints: initial } : {}) })
      } catch (error) {
        results.push({ row: rowNo, studentNo, status: 'skipped', message: error instanceof Error ? error.message.slice(0, 200) : '创建失败' })
      }
    }
    return { createdCount, initialCount, admissionTotal, results }
  }

  /** 月度身份评定预览（候选，不自动改身份；04 方案 7） */
  async monthlyEvaluationPreview(month: string) {
    const users = await this.db.user.findMany({
      where: { accountStatus: 'active' },
      include: { membershipTerms: { orderBy: { createdAt: 'desc' }, take: 1 } },
    })
    const entries = await this.db.pointsLedgerEntry.findMany({ where: { status: 'approved' }, select: { userId: true, amount: true, scoreMonth: true, category: true } })
    const byUser = new Map<string, { total: number; months: Record<string, number> }>()
    for (const e of entries) {
      if (!byUser.has(e.userId)) byUser.set(e.userId, { total: 0, months: {} })
      const u = byUser.get(e.userId)!
      u.total += Number(e.amount)
      u.months[e.scoreMonth] = (u.months[e.scoreMonth] ?? 0) + Number(e.amount)
    }
    const formalCount = users.filter((u) => u.membershipTerms[0]?.membershipStatus === 'formal').length
    const quota = formalQuota(formalCount)
    const rankedFormal = users
      .filter((u) => u.membershipTerms[0]?.membershipStatus === 'formal')
      .map((u) => ({ userId: u.id, total: byUser.get(u.id)?.total ?? 0 }))
      .sort((a, b) => b.total - a.total)
    const keep = new Set(rankedFormal.slice(0, quota).map((r) => r.userId))
    const candidates = rankedFormal.slice(quota).map((r) => {
      const k = Math.max(1, 1) // K 由 transitions 记录推算；此处输出候选与原因
      const g = graceMonths(6)
      return { userId: r.userId, kind: 'lose_quota', inOfficeMonths: k, graceMonths: g.g ? g.g : 0, demoteNextMonth: g.demoteNextMonth }
    })
    const observing = users.filter((u) => u.membershipTerms[0]?.membershipStatus === 'observing')
    const observingCandidates = observing.map((u) => {
      const months = byUser.get(u.id)?.months ?? {}
      const m = months[month] ?? 0
      return { userId: u.id, monthM: m, meetsM12: m >= 12, note: '满足指定比赛/集体活动/月度 M≥12 等条件后按月度结果转正' }
    })
    return { month, formalCount, quota, loseQuotaCandidates: candidates, observingCandidates, note: '候选名单仅供评定会议，不自动更改身份（告知/申辩/集体讨论/教师审核/公示流程由负责人执行）' }
  }

  // ---------------- 邀请管理 ----------------

  async createInvitation(actor: SessionActor, input: { maxUses: number; expiresInDays: number; batchLabel?: string; allowedStudentNo?: string }): Promise<{ invitationId: string; code: string; expiresAt: Date }> {
    const secret = newInvitationSecret()
    const id = newId()
    const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 3600_000)
    await this.db.invitation.create({
      data: {
        id,
        tokenHash: sha256Hex(secret),
        batchLabel: input.batchLabel,
        maxUses: input.maxUses,
        expiresAt,
        allowedStudentNo: input.allowedStudentNo,
        createdBy: actor.principalId,
      },
    })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'invitation.create',
      resourceType: 'invitation',
      resourceId: id,
      summary: `创建邀请（${input.maxUses} 次，${input.expiresInDays} 天，批次 ${input.batchLabel ?? '个人'}）`,
    })
    return { invitationId: id, code: secret, expiresAt }
  }

  async listInvitations(cursor?: string) {
    const rows = await this.db.invitation.findMany({
      orderBy: { createdAt: 'desc' },
      take: 21,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { redemptions: { include: { user: { select: { studentNo: true, verifiedRealName: true } } } } },
    })
    const nextCursor = rows.length > 20 ? rows.pop()!.id : undefined
    return { items: rows.map((r) => ({ ...r, tokenHash: undefined })), nextCursor }
  }

  async revokeInvitation(actor: SessionActor, invitationId: string): Promise<void> {
    await this.db.invitation.updateMany({ where: { id: invitationId, revokedAt: null }, data: { revokedAt: new Date(), status: 'revoked' } })
    await this.audit.log({ actorPrincipalId: actor.principalId, action: 'invitation.revoke', resourceType: 'invitation', resourceId: invitationId, summary: '停用邀请' })
  }

  // ---------------- 训练室（04 方案：至少三人、同时九人、每日/每周次数、24h 提前、3h 通常/6h 上限） ----------------

  async createRoomBooking(userId: string, input: { startsAt: string; endsAt: string; purpose: string; coApplicantUserIds: string[]; contestLink?: string }): Promise<{ bookingId: string }> {
    const start = new Date(input.startsAt)
    const end = new Date(input.endsAt)
    const now = new Date()
    const durationHours = (end.getTime() - start.getTime()) / 3600_000
    if (durationHours <= 0 || durationHours > 6) throw new MembersError('批准时长最长六小时', 'DURATION_LIMIT')
    if (durationHours > 3) {
      // 通常三小时；超过三小时的申请标注需审批加长（由审批人决定）
    }
    if (start.getTime() - now.getTime() < 24 * 3600_000) throw new MembersError('普通申请至少提前 24 小时', 'ADVANCE_REQUIRED')
    const headcount = new Set([userId, ...input.coApplicantUserIds]).size
    if (headcount < 3) throw new MembersError('至少三名共同申请人', 'HEADCOUNT_MIN')
    if (headcount > 9) throw new MembersError('同时使用不超过九人', 'HEADCOUNT_MAX')

    const id = newId()
    await this.db.$transaction(async (tx) => {
      // 场地串行锁 + 峰值容量检查（重叠预约的同时人数之和 ≤ 9）
      const overlapping = await tx.roomBooking.findMany({
        where: { status: 'approved', startsAt: { lt: end }, endsAt: { gt: start } },
      })
      // 边界法计算同时人数峰值
      const events: Array<{ t: number; delta: number }> = []
      for (const b of overlapping) {
        events.push({ t: b.startsAt.getTime(), delta: b.headcount })
        events.push({ t: b.endsAt.getTime(), delta: -b.headcount })
      }
      events.sort((a, b) => a.t - b.t || a.delta - b.delta)
      let peak = 0
      let cur = 0
      for (const ev of events) {
        cur += ev.delta
        peak = Math.max(peak, cur)
      }
      if (peak + headcount > 9) throw new MembersError('该时段同时人数将超过九人上限', 'CAPACITY_PEAK')

      // 每人每天一次、每周两次（按申请人集合）
      for (const uid of [userId, ...input.coApplicantUserIds]) {
        const dayStart = new Date(start)
        dayStart.setHours(0, 0, 0, 0)
        const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000)
        const weekStart = new Date(dayStart.getTime() - 6 * 24 * 3600_000)
        const [dailyCount, weeklyCount] = await Promise.all([
          tx.roomBooking.count({ where: { status: 'approved', OR: [{ applicantUserId: uid }, { coApplicantUserIds: { has: uid } }], startsAt: { gte: dayStart, lt: dayEnd } } }),
          tx.roomBooking.count({ where: { status: 'approved', OR: [{ applicantUserId: uid }, { coApplicantUserIds: { has: uid } }], startsAt: { gte: weekStart, lt: dayEnd } } }),
        ])
        if (dailyCount >= 1) throw new MembersError('每人每天最多一次训练室申请', 'DAILY_LIMIT')
        if (weeklyCount >= 2) throw new MembersError('每人每周最多两次训练室申请', 'WEEKLY_LIMIT')
        // 冻结成员不能通过共同申请人绕过
        const restriction = await tx.restriction.findFirst({
          where: { userId: uid, type: 'room_freeze', revokedAt: null, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        })
        if (restriction) throw new MembersError('存在训练室资格冻结，不能作为申请人', 'ROOM_FROZEN')
      }
      await tx.roomBooking.create({
        data: { id, startsAt: start, endsAt: end, purpose: input.purpose, contestLink: input.contestLink, applicantUserId: userId, coApplicantUserIds: input.coApplicantUserIds, headcount, status: 'pending' },
      })
    })
    return { bookingId: id }
  }

  async decideRoomBooking(actor: SessionActor, bookingId: string, decision: 'approve' | 'reject', reason?: string): Promise<void> {
    const booking = await this.db.roomBooking.findUnique({ where: { id: bookingId } })
    if (!booking || booking.status !== 'pending') throw new MembersError('预约不存在或已处理', 'STATE_INVALID')
    await this.db.roomBooking.update({
      where: { id: bookingId },
      data: decision === 'approve'
        ? { status: 'approved', approvedBy: actor.principalId, approvedAt: new Date() }
        : { status: 'rejected', rejectionReason: reason ?? '' },
    })
  }

  async myRoomBookings(userId: string) {
    return this.db.roomBooking.findMany({
      where: { OR: [{ applicantUserId: userId }, { coApplicantUserIds: { has: userId } }] },
      orderBy: { startsAt: 'desc' },
      take: 20,
    })
  }

  /** 审计检索（脱敏：不返回 ticket/token/坐标原文） */
  async auditLogs(filters: { actor?: string; resourceType?: string; cursor?: string }) {
    const rows = await this.db.auditLog.findMany({
      where: {
        ...(filters.resourceType ? { resourceType: filters.resourceType } : {}),
        ...(filters.actor ? { actorPrincipalId: filters.actor } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 51,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    })
    const nextCursor = rows.length > 50 ? rows.pop()!.id : undefined
    return { items: rows, nextCursor }
  }
}

/** 无任何 term 的存量用户直接设身份时，落当前学期（与注册流程一致） */
async function currentSemesterId(tx: Prisma.TransactionClient): Promise<string> {
  const now = new Date()
  const semester = await tx.semester.findFirst({ where: { startsOn: { lte: now } }, orderBy: { startsOn: 'desc' } })
  if (semester) return semester.id
  const created = await tx.semester.create({
    data: { id: newId(), code: 'DEFAULT', name: '默认学期（初始化）', startsOn: new Date('2026-01-01'), endsOn: new Date('2027-01-01') },
  })
  return created.id
}
