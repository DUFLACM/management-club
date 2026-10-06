import { DomainError } from '../../common/domain-error.js'
import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import {
  Decimal,
  computeEffectiveScore,
  specialRankingScore,
  formalContestScore,
  networkQualifierScore,
  ladderScore,
  lanqiaoScore,
  baiduStarScore,
  type ContestTier,
  type MedalLevel,
  type LadderTeamAward,
  type LadderIndividualAward,
  type LanqiaoAward,
} from '@acm/scoring-core'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { ScoringService } from '../scoring/scoring.service.js'
import { ContestStandingsService, contestExternalUrl } from '../activities/contest-standings.service.js'
import { newId, monthKey } from '../../common/utils.js'
import type { SessionActor } from '../auth/session.service.js'

/**
 * 正式赛事报名（02 方案延伸 + 《竞赛报名、名额分配与组队管理办法》）：
 * - A 类：学校配额统一管理，报名资格按积分冻结时点排名确定（办法第九~十一条），quota 截断入围。
 * - B 类：纳入积分认定（非配额），正常报名，人数不限。
 * - scoringMode=platform_auto：复用平台榜单抓取，比赛结束后按 W=λ(4S+6R)+X 自动结算（无到场基础分 B，
 *   因为正式赛事非club组织的线下活动）；manual_review：按附录二档位人工审核后入账。
 */

export class CompetitionError extends DomainError {
  constructor(message: string, readonly code: string) {
    super(message, code)
  }
}

const RANKED_MEMBERSHIPS = ['formal', 'provisional', 'observing']
const EFFECTIVE_WEIGHTS = [1, 0.85, 0.7, 0.55, 0.4, 0.25]

export const competitionEventInputSchema = z.object({
  designatedContestId: z.string().uuid().optional(),
  title: z.string().min(2).max(160),
  category: z.enum(['A', 'B']),
  teamSize: z.number().int().min(2).max(10).nullable().optional(),
  scoringMode: z.enum(['platform_auto', 'manual_review']),
  platform: z.enum(['nowcoder', 'codeforces', 'atcoder', 'hydro']).optional(),
  platformContestId: z.string().max(64).optional(),
  contestTier: z
    .enum(['school_select', 'provincial', 'icpc_invite', 'icpc_regional', 'top_final', 'network_qualifier', 'ladder', 'lanqiao', 'baidu_star'])
    .optional(),
  lambdaKey: z.enum(['A', 'B', 'C']).optional(),
  announcement: z.string().min(5).max(20000),
  registerStartAt: z.string().datetime().nullable().optional(),
  registerDeadline: z.string().datetime(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  quota: z.number().int().min(1).max(500).nullable().optional(),
  qualificationRule: z
    .object({
      basedOn: z.enum(['currentE', 'specialQ']),
      specialWeight: z.number().min(0.3).max(0.5).optional(),
    })
    .nullable()
    .optional(),
  freezeAt: z.string().datetime().nullable().optional(),
  teamFormDeadline: z.string().datetime().nullable().optional(),
})
export type CompetitionEventInput = z.infer<typeof competitionEventInputSchema>

@Injectable()
export class CompetitionEventService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    private readonly audit: AuditService,
    private readonly scoring: ScoringService,
    private readonly standings: ContestStandingsService,
  ) {}

  async createEvent(actor: SessionActor, input: CompetitionEventInput): Promise<{ eventId: string }> {
    if (new Date(input.registerDeadline) >= new Date(input.startAt)) {
      throw new CompetitionError('报名截止须早于赛事开始', 'TIME_ORDER')
    }
    if (input.scoringMode === 'platform_auto' && (!input.platform || !input.platformContestId)) {
      throw new CompetitionError('平台自动积分模式需要选择平台与平台赛事 ID', 'PLATFORM_REQUIRED')
    }
    if (input.scoringMode === 'manual_review' && !input.contestTier) {
      throw new CompetitionError('人工审核模式需要选择积分档位', 'TIER_REQUIRED')
    }
    const id = newId()
    const deadline = new Date(input.registerDeadline)
    const defaultFreezeAt = new Date(deadline.getTime() - 24 * 3600_000)
    defaultFreezeAt.setUTCHours(14, 0, 0, 0) // 报名截止前一日 22:00（Asia/Shanghai = UTC+8）
    await this.db.competitionEvent.create({
      data: {
        id,
        designatedContestId: input.designatedContestId,
        title: input.title,
        category: input.category,
        teamSize: input.teamSize ?? null,
        scoringMode: input.scoringMode,
        platform: input.platform,
        platformContestId: input.platformContestId,
        contestTier: input.contestTier,
        lambdaKey: input.lambdaKey,
        announcement: input.announcement,
        registerStartAt: input.registerStartAt ? new Date(input.registerStartAt) : null,
        registerDeadline: deadline,
        startAt: new Date(input.startAt),
        endAt: new Date(input.endAt),
        quota: input.category === 'A' ? input.quota ?? null : null,
        qualificationRule: input.category === 'A' ? ((input.qualificationRule ?? undefined) as never) : undefined,
        freezeAt: input.category === 'A' ? (input.freezeAt ? new Date(input.freezeAt) : defaultFreezeAt) : null,
        teamFormDeadline: input.teamSize
          ? input.teamFormDeadline
            ? new Date(input.teamFormDeadline)
            : new Date(deadline.getTime() + 3 * 24 * 3600_000)
          : null,
        status: 'draft',
        createdBy: actor.principalId,
      },
    })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'competition_event.create',
      resourceType: 'competition_event',
      resourceId: id,
      summary: `创建正式赛事：${input.title}（${input.category} 类）`,
    })
    return { eventId: id }
  }

  async publish(actor: SessionActor, eventId: string): Promise<void> {
    const event = await this.db.competitionEvent.findUnique({ where: { id: eventId } })
    if (!event) throw new CompetitionError('赛事不存在', 'NOT_FOUND')
    if (event.status !== 'draft') throw new CompetitionError('仅草稿状态可发布', 'STATE_INVALID')
    await this.db.competitionEvent.update({ where: { id: eventId }, data: { status: 'open' } })
    await this.audit.log({ actorPrincipalId: actor.principalId, action: 'competition_event.publish', resourceType: 'competition_event', resourceId: eventId, summary: `发布赛事：${event.title}` })
  }

  async adminList(status?: string) {
    return this.db.competitionEvent.findMany({
      where: status ? { status } : undefined,
      orderBy: { registerDeadline: 'desc' },
      take: 100,
      include: { _count: { select: { registrations: true, teamEntries: true } } },
    })
  }

  async listOpen(userId: string | null) {
    const events = await this.db.competitionEvent.findMany({
      where: { status: { in: ['open', 'shortlisted', 'team_forming'] } },
      orderBy: { registerDeadline: 'asc' },
      take: 100,
    })
    if (!userId) return events.map((e) => ({ ...e, myStatus: null as string | null }))
    const [regs, entries] = await Promise.all([
      this.db.competitionRegistration.findMany({ where: { userId, eventId: { in: events.map((e) => e.id) } }, select: { eventId: true, status: true } }),
      this.db.teamCompetitionEntry.findMany({
        where: { eventId: { in: events.map((e) => e.id) }, team: { members: { some: { userId, status: 'active' } } } },
        select: { eventId: true, status: true },
      }),
    ])
    const byEvent = new Map<string, string>()
    for (const r of regs) byEvent.set(r.eventId, r.status)
    for (const e of entries) byEvent.set(e.eventId, e.status)
    return events.map((e) => ({ ...e, myStatus: byEvent.get(e.id) ?? null }))
  }

  /** 报名详情：赛事信息 + 我的报名/队伍状态 + 结算后积分 + 驳回原因 */
  async detailForUser(userId: string | null, eventId: string) {
    const event = await this.db.competitionEvent.findUnique({ where: { id: eventId } })
    if (!event) throw new CompetitionError('赛事不存在', 'NOT_FOUND')
    const contestUrl = event.platform && event.platformContestId ? contestExternalUrl(event.platform, event.platformContestId) : null
    if (!userId) return { event, contestUrl, myShortlist: null, myRegistration: null, myTeamEntries: [] }
    const [myShortlist, myRegistration, myTeamEntries] = await Promise.all([
      this.db.competitionShortlistRow.findUnique({ where: { eventId_userId: { eventId, userId } } }),
      this.db.competitionRegistration.findUnique({ where: { eventId_userId: { eventId, userId } }, include: { materials: true, platformAccount: true } }),
      this.db.teamCompetitionEntry.findMany({
        where: { eventId, team: { members: { some: { userId, status: 'active' } } } },
        include: { team: { include: { members: { where: { status: 'active' } } } }, materials: true },
      }),
    ])
    return { event, contestUrl, myShortlist, myRegistration, myTeamEntries }
  }

  /** 成员端资格名单：按成员引用展示（不含姓名），出场资格以冻结时点为准 */
  async shortlistForMember(userId: string | null, eventId: string) {
    const event = await this.db.competitionEvent.findUnique({ where: { id: eventId } })
    if (!event) throw new CompetitionError('赛事不存在', 'NOT_FOUND')
    const rows = await this.db.competitionShortlistRow.findMany({ where: { eventId }, orderBy: { position: 'asc' } })
    return {
      event: {
        id: event.id, title: event.title, category: event.category, status: event.status,
        quota: event.quota, teamSize: event.teamSize, freezeAt: event.freezeAt,
      },
      rows: rows.map((r) => ({
        position: r.position, userId: r.userId,
        eSnapshot: r.eSnapshot.toFixed(4), qScore: r.qScore?.toFixed(4) ?? null,
        eligible: r.eligible, shortlisted: r.shortlisted, isMe: r.userId === userId,
      })),
    }
  }

  // ---------------- 资格排名（办法第九~十一条） ----------------

  /** 生成报名资格排名快照：A 类赛事按积分冻结时点的有效积分 E（或专项选拔 Q）排序，按 quota 截断入围 */
  async buildShortlist(actor: SessionActor, eventId: string): Promise<{ shortlisted: number; total: number }> {
    const event = await this.db.competitionEvent.findUnique({ where: { id: eventId } })
    if (!event) throw new CompetitionError('赛事不存在', 'NOT_FOUND')
    if (event.category !== 'A') throw new CompetitionError('仅 A 类赛事需要生成资格名单', 'NOT_QUOTA_EVENT')
    const freezeAt = event.freezeAt ?? new Date()
    const entries = await this.db.pointsLedgerEntry.findMany({
      where: { status: 'approved', recordedAt: { lte: freezeAt } },
      select: { userId: true, amount: true, scoreMonth: true },
    })
    const byUser = new Map<string, Record<string, number>>()
    for (const e of entries) {
      const m = byUser.get(e.userId) ?? {}
      m[e.scoreMonth] = (m[e.scoreMonth] ?? 0) + Number(e.amount)
      byUser.set(e.userId, m)
    }
    const users = await this.db.user.findMany({
      where: { id: { in: [...byUser.keys()] } },
      include: { membershipTerms: { orderBy: { createdAt: 'desc' }, take: 1 } },
    })
    const monthOfFreeze = freezeAt.toISOString().slice(0, 7)
    const rule = (event.qualificationRule ?? {}) as { basedOn?: 'currentE' | 'specialQ'; specialWeight?: number }
    const withE = users
      .filter((u) => RANKED_MEMBERSHIPS.includes(u.membershipTerms[0]?.membershipStatus ?? ''))
      .map((u) => {
        const eff = computeEffectiveScore({ monthlyScores: byUser.get(u.id) ?? {}, currentMonth: monthOfFreeze }, { effectiveWeights: EFFECTIVE_WEIGHTS })
        return { userId: u.id, e: Number(eff.e) }
      })
    const maxE = withE.reduce((max, row) => Math.max(max, row.e), 0)
    const useQ = rule.basedOn === 'specialQ'
    const weight = Math.min(0.5, Math.max(0.3, rule.specialWeight ?? 0.3))
    // T（专项选拔归一分）暂无独立评定录入入口，默认 0；管理员可在生成名单后对个别成员用
    // overrideShortlistRow 手工修正 qScore 并重新排序截断（对应办法"允许自定义"的专项选拔口径）。
    const ranked = withE
      .map((row) => ({
        ...row,
        q: useQ ? Number(specialRankingScore(new Decimal(maxE > 0 ? row.e / maxE : 0), new Decimal(0), { pWeight: 1 - weight, tWeight: weight })) : null,
      }))
      .sort((a, b) => (useQ ? b.q! - a.q! : b.e - a.e))
    await this.db.$transaction(async (tx) => {
      await tx.competitionShortlistRow.deleteMany({ where: { eventId } })
      let position = 0
      for (const row of ranked) {
        position++
        const shortlisted = event.quota == null || position <= event.quota
        await tx.competitionShortlistRow.create({
          data: {
            id: newId(), eventId, userId: row.userId, position,
            eSnapshot: row.e.toFixed(4), qScore: row.q != null ? row.q.toFixed(4) : null,
            eligible: true, shortlisted,
          },
        })
      }
      await tx.competitionEvent.update({ where: { id: eventId }, data: { status: event.teamSize ? 'team_forming' : 'shortlisted' } })
    })
    await this.audit.log({
      actorPrincipalId: actor.principalId, action: 'competition_event.build_shortlist',
      resourceType: 'competition_event', resourceId: eventId,
      summary: `生成资格名单（候选 ${ranked.length} 人，quota=${event.quota ?? '不限'}）`,
    })
    const shortlistedCount = event.quota == null ? ranked.length : Math.min(ranked.length, event.quota)
    return { shortlisted: shortlistedCount, total: ranked.length }
  }

  async listShortlist(eventId: string) {
    return this.db.competitionShortlistRow.findMany({
      where: { eventId },
      orderBy: { position: 'asc' },
      include: { user: { select: { verifiedRealName: true, studentNo: true, profile: { select: { displayName: true } } } } },
    })
  }

  /** 专项选拔个别调整（允许自定义）：改 qScore/eligible 后按新 qScore（或 E）重新排序与截断 */
  async overrideShortlistRow(actor: SessionActor, eventId: string, userId: string, input: { qScore?: number | null; eligible?: boolean }): Promise<void> {
    const row = await this.db.competitionShortlistRow.findUnique({ where: { eventId_userId: { eventId, userId } } })
    if (!row) throw new CompetitionError('名单行不存在', 'NOT_FOUND')
    await this.db.competitionShortlistRow.update({
      where: { eventId_userId: { eventId, userId } },
      data: { qScore: input.qScore === undefined ? row.qScore : input.qScore?.toFixed(4), eligible: input.eligible ?? row.eligible },
    })
    const event = await this.db.competitionEvent.findUniqueOrThrow({ where: { id: eventId } })
    const rows = await this.db.competitionShortlistRow.findMany({ where: { eventId }, orderBy: [{ qScore: 'desc' }, { eSnapshot: 'desc' }] })
    await this.db.$transaction(
      rows.map((r, i) =>
        this.db.competitionShortlistRow.update({
          where: { id: r.id },
          data: { position: i + 1, shortlisted: r.eligible && (event.quota == null || i + 1 <= event.quota) },
        }),
      ),
    )
    await this.audit.log({ actorPrincipalId: actor.principalId, action: 'competition_event.shortlist_override', resourceType: 'competition_event', resourceId: eventId, summary: `手工调整资格名单成员 ${userId}` })
  }

  // ---------------- 个人赛报名 ----------------

  async registerIndividual(userId: string, eventId: string, input: { platformAccountId?: string; note?: string }): Promise<{ registrationId: string }> {
    const event = await this.db.competitionEvent.findUnique({ where: { id: eventId } })
    if (!event) throw new CompetitionError('赛事不存在', 'NOT_FOUND')
    if (event.teamSize) throw new CompetitionError('该赛事为团队赛，请通过组队广场报名', 'TEAM_EVENT')
    if (!['open', 'shortlisted'].includes(event.status)) throw new CompetitionError('当前不在报名窗口', 'STATE_INVALID')
    if (event.registerDeadline.getTime() < Date.now()) throw new CompetitionError('报名已截止', 'DEADLINE_PASSED')
    if (event.category === 'A') {
      const row = await this.db.competitionShortlistRow.findUnique({ where: { eventId_userId: { eventId, userId } } })
      if (!row?.shortlisted) throw new CompetitionError('未在本场 A 类赛事的入围名单内', 'NOT_SHORTLISTED')
    }
    let platformAccountId: string | null = null
    if (event.scoringMode === 'platform_auto') {
      if (!input.platformAccountId) {
        const bound = await this.db.platformAccount.findFirst({ where: { userId, platform: event.platform!, status: 'verified' } })
        if (!bound) throw new CompetitionError('请先绑定并核验对应平台账号后再报名', 'NEEDS_PLATFORM_BIND')
        platformAccountId = bound.id
      } else {
        const account = await this.db.platformAccount.findUnique({ where: { id: input.platformAccountId } })
        if (!account || account.userId !== userId || account.status !== 'verified' || account.platform !== event.platform) {
          throw new CompetitionError('请先绑定并核验对应平台账号后再报名', 'NEEDS_PLATFORM_BIND')
        }
        platformAccountId = account.id
      }
    }
    const id = newId()
    await this.db.competitionRegistration.upsert({
      where: { eventId_userId: { eventId, userId } },
      create: {
        id, eventId, userId, platformAccountId,
        status: event.scoringMode === 'platform_auto' ? 'confirmed' : 'pending_review',
        note: input.note, confirmedAt: event.scoringMode === 'platform_auto' ? new Date() : null,
      },
      update: {
        platformAccountId, note: input.note,
        status: event.scoringMode === 'platform_auto' ? 'confirmed' : 'pending_review',
        reviewNote: null, confirmedAt: event.scoringMode === 'platform_auto' ? new Date() : null,
      },
    })
    const registration = await this.db.competitionRegistration.findUniqueOrThrow({ where: { eventId_userId: { eventId, userId } } })
    return { registrationId: registration.id }
  }

  async resubmitRegistration(userId: string, registrationId: string, note?: string): Promise<void> {
    const reg = await this.db.competitionRegistration.findUnique({ where: { id: registrationId } })
    if (!reg || reg.userId !== userId) throw new CompetitionError('报名不存在', 'NOT_FOUND')
    if (reg.status !== 'rejected') throw new CompetitionError('仅被驳回的报名可重新提交', 'STATE_INVALID')
    await this.db.competitionRegistration.update({ where: { id: registrationId }, data: { status: 'pending_review', note: note ?? reg.note, reviewNote: null } })
  }

  private static readonly MATERIAL_MIME_WHITELIST = new Set([
    'application/pdf', 'application/zip', 'application/x-zip-compressed',
    'text/markdown', 'text/plain',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png', 'image/jpeg',
  ])

  async uploadRegistrationMaterial(
    userId: string,
    registrationId: string,
    file: { buffer: Buffer; mimetype: string; size: number; originalname?: string },
    input: { title: string },
  ): Promise<{ materialId: string }> {
    const reg = await this.db.competitionRegistration.findUnique({ where: { id: registrationId } })
    if (!reg || reg.userId !== userId) throw new CompetitionError('报名不存在', 'NOT_FOUND')
    if (file.size > 20 * 1024 * 1024) throw new CompetitionError('单个材料不超过 20 MiB', 'PAYLOAD_TOO_LARGE')
    if (!CompetitionEventService.MATERIAL_MIME_WHITELIST.has(file.mimetype)) throw new CompetitionError('仅支持 PDF / Markdown / 文本 / Office 文档 / 图片 / ZIP', 'UNSUPPORTED_MEDIA')
    const fileName = (file.originalname ?? 'material').replace(/[/\\?%*:|"<>]/g, '_').slice(0, 180)
    const id = newId()
    const storageKey = `materials/competitions/${reg.eventId}/${registrationId}/${id}/source.bin`
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const target = path.join(process.env.STORAGE_LOCAL_DIR ?? './storage', storageKey)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, file.buffer)
    await this.db.competitionRegistrationMaterial.create({
      data: { id, registrationId, title: input.title, fileName, mimeType: file.mimetype, sizeBytes: file.size, storageKey },
    })
    return { materialId: id }
  }

  /** userId 为 null 时表示管理端下载（由 ActionGuard 校验权限），否则仅限报名本人 */
  async materialForDownload(registrationId: string, materialId: string, userId: string | null) {
    const material = await this.db.competitionRegistrationMaterial.findUnique({
      where: { id: materialId },
      include: { registration: { select: { userId: true } } },
    })
    if (!material || material.registrationId !== registrationId) throw new CompetitionError('材料不存在', 'NOT_FOUND')
    if (userId !== null && material.registration.userId !== userId) throw new CompetitionError('材料不存在', 'NOT_FOUND')
    const path = await import('node:path')
    return {
      material: { fileName: material.fileName, mimeType: material.mimeType, storageKey: material.storageKey },
      filePath: path.join(process.env.STORAGE_LOCAL_DIR ?? './storage', material.storageKey),
    }
  }

  // ---------------- 审核（人工审核档位） ----------------

  async adminListRegistrations(eventId: string) {
    return this.db.competitionRegistration.findMany({
      where: { eventId },
      orderBy: { registeredAt: 'asc' },
      include: { materials: true, user: { select: { verifiedRealName: true, studentNo: true, profile: { select: { displayName: true } } } } },
    })
  }

  /** 管理端队伍报名列表：审核以队为单位，通过时为每名在队成员分别入账 */
  async adminListTeamEntries(eventId: string) {
    return this.db.teamCompetitionEntry.findMany({
      where: { eventId },
      orderBy: { registeredAt: 'asc' },
      include: {
        materials: true,
        team: {
          include: {
            members: {
              where: { status: 'active' },
              include: { user: { select: { id: true, verifiedRealName: true, studentNo: true, profile: { select: { displayName: true } } } } },
            },
          },
        },
      },
    })
  }

  /** 人工审核档位计分输入（按附录二档位对应的奖项枚举） */
  private computeManualScore(tier: string, award: Record<string, unknown>): { value: InstanceType<typeof Decimal>; detail: unknown } {
    switch (tier) {
      case 'school_select': case 'provincial': case 'icpc_invite': case 'icpc_regional': case 'top_final': {
        const outcome = formalContestScore({ tier: tier as ContestTier, medal: (award.medal as MedalLevel) ?? null, registeredOfficial: true })
        if (outcome.status !== 'ok' || outcome.value == null) throw new CompetitionError(outcome.pendingReason ?? '计分口径未决', 'SCORE_PENDING')
        return { value: outcome.value, detail: { tier, medal: award.medal ?? null, decisions: outcome.decisions } }
      }
      case 'network_qualifier': {
        const outcome = networkQualifierScore({
          participatedWithSubmission: Boolean(award.participatedWithSubmission),
          advanced: Boolean(award.advanced),
          rankAmongAdvanced: (award.rankAmongAdvanced as { rank: number; total: number } | null) ?? null,
        })
        if (outcome.status !== 'ok' || outcome.value == null) throw new CompetitionError(outcome.pendingReason ?? '计分口径未决', 'SCORE_PENDING')
        return { value: outcome.value, detail: { tier, decisions: outcome.decisions } }
      }
      case 'ladder': {
        const value = ladderScore((award.teamAwards as LadderTeamAward[]) ?? [], (award.individual as LadderIndividualAward) ?? null)
        return { value, detail: { tier, teamAwards: award.teamAwards ?? [], individual: award.individual ?? null } }
      }
      case 'lanqiao': {
        const value = lanqiaoScore((award.group as 'A' | 'B') ?? 'B', (award.awards as LanqiaoAward[]) ?? [])
        return { value, detail: { tier, group: award.group ?? 'B', awards: award.awards ?? [] } }
      }
      case 'baidu_star': {
        const value = baiduStarScore((award.preliminary as MedalLevel) ?? null, (award.final as MedalLevel) ?? null)
        return { value, detail: { tier, preliminary: award.preliminary ?? null, final: award.final ?? null } }
      }
      default:
        throw new CompetitionError(`未知积分档位 ${tier}`, 'UNKNOWN_TIER')
    }
  }

  async reviewRegistration(actor: SessionActor, registrationId: string, decision: 'approve' | 'reject', input: { note?: string; award?: Record<string, unknown> }): Promise<void> {
    const reg = await this.db.competitionRegistration.findUnique({ where: { id: registrationId }, include: { event: true } })
    if (!reg) throw new CompetitionError('报名不存在', 'NOT_FOUND')
    if (decision === 'reject') {
      await this.db.competitionRegistration.update({ where: { id: registrationId }, data: { status: 'rejected', reviewNote: input.note ?? '未说明原因', reviewedBy: actor.principalId, reviewedAt: new Date() } })
      await this.audit.log({ actorPrincipalId: actor.principalId, action: 'competition_registration.reject', resourceType: 'competition_registration', resourceId: registrationId, summary: input.note ?? '驳回' })
      return
    }
    const { value, detail } = this.computeManualScore(reg.event.contestTier ?? '', input.award ?? {})
    await this.scoring.postLedgerEntry(actor, {
      userId: reg.userId,
      sourceKey: `competition:${reg.eventId}:${reg.userId}`,
      category: 'award',
      amount: value.toFixed(2),
      scoreMonth: monthKey(new Date()),
      detail: { eventId: reg.eventId, eventTitle: reg.event.title, ...(detail as object) },
      evidenceRef: `competition_registration:${registrationId}`,
    })
    await this.db.competitionRegistration.update({
      where: { id: registrationId },
      data: { status: 'approved', resultScore: value.toFixed(2), resultDetail: detail as never, reviewNote: input.note, reviewedBy: actor.principalId, reviewedAt: new Date(), confirmedAt: new Date() },
    })
    await this.audit.log({ actorPrincipalId: actor.principalId, action: 'competition_registration.approve', resourceType: 'competition_registration', resourceId: registrationId, summary: `通过并入账 ${value.toFixed(2)} 分` })
  }

  async reviewTeamEntry(actor: SessionActor, entryId: string, decision: 'approve' | 'reject', input: { note?: string; award?: Record<string, unknown> }): Promise<void> {
    const entry = await this.db.teamCompetitionEntry.findUnique({ where: { id: entryId }, include: { event: true, team: { include: { members: { where: { status: 'active' } } } } } })
    if (!entry) throw new CompetitionError('队伍报名不存在', 'NOT_FOUND')
    if (decision === 'reject') {
      await this.db.teamCompetitionEntry.update({ where: { id: entryId }, data: { status: 'rejected', reviewNote: input.note ?? '未说明原因', reviewedBy: actor.principalId, reviewedAt: new Date() } })
      await this.audit.log({ actorPrincipalId: actor.principalId, action: 'team_competition_entry.reject', resourceType: 'team_competition_entry', resourceId: entryId, summary: input.note ?? '驳回' })
      return
    }
    const { value, detail } = this.computeManualScore(entry.event.contestTier ?? '', input.award ?? {})
    for (const member of entry.team.members) {
      await this.scoring.postLedgerEntry(actor, {
        userId: member.userId,
        sourceKey: `team-competition:${entry.eventId}:${entry.teamId}:${member.userId}`,
        category: 'award',
        amount: value.toFixed(2),
        scoreMonth: monthKey(new Date()),
        detail: { eventId: entry.eventId, eventTitle: entry.event.title, teamId: entry.teamId, teamName: entry.team.name, ...(detail as object) },
        evidenceRef: `team_competition_entry:${entryId}`,
      })
    }
    await this.db.teamCompetitionEntry.update({
      where: { id: entryId },
      data: { status: 'approved', resultScore: value.toFixed(2), resultDetail: detail as never, reviewNote: input.note, reviewedBy: actor.principalId, reviewedAt: new Date() },
    })
    await this.audit.log({ actorPrincipalId: actor.principalId, action: 'team_competition_entry.approve', resourceType: 'team_competition_entry', resourceId: entryId, summary: `通过并为 ${entry.team.members.length} 名队员各入账 ${value.toFixed(2)} 分` })
  }

  // ---------------- 平台自动结算（无到场基础分 B；非 club 组织的线下活动） ----------------

  async settleEvent(actor: SessionActor | null, eventId: string): Promise<{ posted: number; deduplicated: number; skipped: Array<{ name: string; reason: string }> }> {
    const event = await this.db.competitionEvent.findUnique({ where: { id: eventId } })
    if (!event) throw new CompetitionError('赛事不存在', 'NOT_FOUND')
    if (event.scoringMode !== 'platform_auto') throw new CompetitionError('仅平台自动积分模式支持结算', 'NOT_PLATFORM_AUTO')
    if (!event.platform || !event.platformContestId) throw new CompetitionError('赛事未关联平台', 'NOT_CONTEST')
    if (event.endAt.getTime() + 5 * 60_000 > Date.now()) throw new CompetitionError('比赛结束后有 5 分钟数据同步处理窗口，请稍后再试', 'PROCESSING_WINDOW')
    const result = await this.standings.fetch(event.platform, event.platformContestId)
    if (!result.available) throw new CompetitionError(`平台榜单暂不可用：${result.reason}`, 'STANDINGS_UNAVAILABLE')
    const entryByHandle = new Map(result.entries.map((e) => [e.handle, e]))
    const totalProblems = result.problems.length || 1
    const fullTotal = result.problems.reduce((sum, p) => sum + (p.fullScore ?? 0), 0)
    const lambdaValue = event.lambdaKey === 'A' ? 1.2 : event.lambdaKey === 'C' ? 0.8 : 1.0

    const skipped: Array<{ name: string; reason: string }> = []
    let posted = 0
    let deduplicated = 0

    type Row = { subjectLabel: string; handle: string; solvedCount: number; score: number; platformRank: number | null; post: (w: number) => Promise<void> }
    const rows: Row[] = []

    if (event.teamSize) {
      const entries = await this.db.teamCompetitionEntry.findMany({
        where: { eventId, status: { in: ['submitted', 'confirmed'] } },
        include: { team: { include: { members: { where: { status: 'active' }, include: { user: { include: { platformAccounts: true } } } } } } },
      })
      for (const entry of entries) {
        const matched = entry.team.members
          .map((m) => m.user.platformAccounts.find((a) => a.platform === event.platform && a.status === 'verified'))
          .map((acc) => (acc ? entryByHandle.get(acc.externalId) : undefined))
          .find((e) => e != null)
        if (!matched) { skipped.push({ name: entry.team.name, reason: '队员均未在榜单上匹配到已核验平台账号' }); continue }
        rows.push({
          subjectLabel: entry.team.name, handle: matched.handle, solvedCount: matched.solvedCount, score: matched.score, platformRank: matched.rank,
          post: async (w) => {
            for (const member of entry.team.members) {
              const outcome = await this.scoring.postLedgerEntry(actor, {
                userId: member.userId, sourceKey: `team-competition:${eventId}:${entry.teamId}:${member.userId}`,
                category: 'contest', amount: w.toFixed(2), scoreMonth: monthKey(event.endAt),
                detail: { eventId, eventTitle: event.title, teamId: entry.teamId, teamName: entry.team.name, formula: { lambda: lambdaValue, W: w } },
              })
              if (outcome.deduplicated) deduplicated++; else posted++
            }
            await this.db.teamCompetitionEntry.update({ where: { id: entry.id }, data: { status: 'confirmed', resultScore: w.toFixed(2), resultDetail: { lambda: lambdaValue, W: w } as never } })
          },
        })
      }
    } else {
      const regs = await this.db.competitionRegistration.findMany({
        where: { eventId, status: { in: ['confirmed', 'approved'] } },
        include: { platformAccount: true, user: { select: { verifiedRealName: true, profile: { select: { displayName: true } } } } },
      })
      for (const reg of regs) {
        const entry = reg.platformAccount ? entryByHandle.get(reg.platformAccount.externalId) : undefined
        const name = reg.user.profile?.displayName ?? reg.user.verifiedRealName
        if (!entry) { skipped.push({ name, reason: '榜上未匹配到已核验平台账号' }); continue }
        rows.push({
          subjectLabel: name, handle: entry.handle, solvedCount: entry.solvedCount, score: entry.score, platformRank: entry.rank,
          post: async (w) => {
            const outcome = await this.scoring.postLedgerEntry(actor, {
              userId: reg.userId, sourceKey: `competition:${eventId}:${reg.userId}`,
              category: 'contest', amount: w.toFixed(2), scoreMonth: monthKey(event.endAt),
              detail: { eventId, eventTitle: event.title, formula: { lambda: lambdaValue, W: w } },
            })
            if (outcome.deduplicated) deduplicated++; else posted++
            await this.db.competitionRegistration.update({ where: { id: reg.id }, data: { status: 'approved', resultScore: w.toFixed(2), resultDetail: { lambda: lambdaValue, W: w } as never, confirmedAt: new Date() } })
          },
        })
      }
    }

    const sortedBySolve = [...rows].sort((a, b) => b.solvedCount - a.solvedCount || b.score - a.score)
    const rankOf = new Map(sortedBySolve.map((r, i) => [r.handle, i + 1]))
    const n = rows.length
    for (const row of rows) {
      const s = row.solvedCount > 0 ? Math.min(1, row.solvedCount / totalProblems) : fullTotal > 0 ? Math.min(1, row.score / fullTotal) : 0
      const rank = rankOf.get(row.handle)!
      const r = n <= 1 ? 0.5 : (1 - (rank - 1) / (n - 1)) * (n < 3 ? 0.5 : 1)
      let x = 0
      if (row.platformRank != null && result.entries.length > 0) {
        const pct = row.platformRank / result.entries.length
        x = pct <= 0.05 ? 3 : pct <= 0.1 ? 2 : pct <= 0.3 ? 1 : 0
      }
      const w = Math.min(20, lambdaValue * (4 * s + 6 * r) + x)
      await row.post(w)
    }
    if (event.status !== 'settled') await this.db.competitionEvent.update({ where: { id: eventId }, data: { status: 'settled' } })
    return { posted, deduplicated, skipped }
  }

  async exportRosterCsv(eventId: string): Promise<string> {
    const event = await this.db.competitionEvent.findUniqueOrThrow({ where: { id: eventId } })
    const header = '学号,姓名,平台账号,状态,积分\n'
    if (event.teamSize) {
      const entries = await this.db.teamCompetitionEntry.findMany({
        where: { eventId },
        include: { team: { include: { members: { where: { status: 'active' }, include: { user: true } } } } },
      })
      const lines = entries.flatMap((entry) =>
        entry.team.members.map((m) => [m.user.studentNo, m.user.verifiedRealName, entry.team.name, entry.status, entry.resultScore ?? ''].join(',')),
      )
      return header + lines.join('\n')
    }
    const regs = await this.db.competitionRegistration.findMany({ where: { eventId }, include: { user: true, platformAccount: true } })
    const lines = regs.map((r) => [r.user.studentNo, r.user.verifiedRealName, r.platformAccount?.displayHandle ?? '', r.status, r.resultScore ?? ''].join(','))
    return header + lines.join('\n')
  }
}
