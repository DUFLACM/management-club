import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { SessionGuard, PermissionsGuard, ActionGuard, RequireAction, CurrentUser, CurrentActor, ok } from '../../common/guards.js'
import { ProfilesService, profileUpdateSchema } from './profiles.service.js'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import type { SessionActor } from '../auth/session.service.js'

@Controller('/api/v1')
@UseGuards(SessionGuard, PermissionsGuard)
export class ProfilesController {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly db: PrismaService,
  ) {}

  @Get('me/profile')
  async mine(@CurrentUser() user: { userId: string }) {
    return ok(await this.profiles.myProfile(user.userId))
  }

  @Put('me/profile')
  async update(@CurrentUser() user: { userId: string }, @Body() body: unknown) {
    const input = profileUpdateSchema.parse(body) // strictObject：追加学号/角色等字段直接拒绝
    return ok(await this.profiles.updateMyProfile(user.userId, input))
  }

  @Get('me/badges')
  async myBadges(@CurrentUser() user: { userId: string }) {
    return ok(await this.profiles.myBadges(user.userId))
  }

  @Put('me/profile/badge-pins')
  async pinBadges(@CurrentUser() user: { userId: string }, @Body() body: unknown) {
    const { awardIds } = z.object({ awardIds: z.array(z.string().uuid()).max(3) }).parse(body)
    await this.profiles.setFeaturedBadges(user.userId, awardIds)
    return ok({ pinned: awardIds.length })
  }

  @Get('profiles/:memberId')
  async member(@CurrentActor() actor: SessionActor, @Param('memberId', ParseUUIDPipe) memberId: string) {
    return ok(await this.profiles.memberProfile(actor, memberId))
  }

  @Get('profiles/:memberId/ratings')
  async ratings(@CurrentActor() actor: SessionActor, @Param('memberId', ParseUUIDPipe) memberId: string) {
    return ok(await this.profiles.memberRatings(actor, memberId))
  }

  /** 比赛成绩（牛客/CF/AtCoder/VJudge/校内 OJ；合并平台同步结果与已结算/历史导入的平台赛流水） */
  @Get('profiles/:memberId/competition-results')
  async competitionResults(
    @CurrentActor() actor: SessionActor,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Query('platform') platform?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
  ) {
    const isSelf = actor.userId === memberId
    const fromAt = from && !Number.isNaN(Date.parse(from)) ? new Date(from) : null
    const toAt = to && !Number.isNaN(Date.parse(to)) ? new Date(to) : null
    const accounts = await this.db.platformAccount.findMany({ where: { userId: memberId } })
    const verifiedPlatforms = new Set(accounts.filter((a) => a.status === 'verified').map((a) => a.platform))
    const contestFilter = {
      ...(platform ? { platform } : {}),
      ...((fromAt || toAt) ? { startTime: { ...(fromAt ? { gte: fromAt } : {}), ...(toAt ? { lte: toAt } : {}) } } : {}),
    }
    const [rows, contestLedger, formalRegs, formalTeamEntries] = await Promise.all([
      this.db.platformResult.findMany({
        where: {
          platformAccountId: { in: accounts.map((a) => a.id) },
          ...(Object.keys(contestFilter).length > 0 ? { platformContest: contestFilter } : {}),
        },
        orderBy: [{ platformContest: { startTime: 'desc' } }, { id: 'desc' }],
        take: 200,
        include: { platformContest: true, platformAccount: true },
      }),
      this.db.pointsLedgerEntry.findMany({
        where: {
          userId: memberId,
          status: 'approved',
          category: { in: ['contest', 'remote_contest'] },
          sourceKey: { startsWith: 'contest:' },
        },
        orderBy: { recordedAt: 'desc' },
        take: 200,
        select: { id: true, sourceKey: true, amount: true, recordedAt: true, detail: true },
      }),
      !platform || platform === 'formal'
        ? (this.db.competitionRegistration?.findMany({
            where: {
              userId: memberId,
              status: { in: ['approved', 'confirmed'] },
              ...((fromAt || toAt) ? { event: { startAt: { ...(fromAt ? { gte: fromAt } : {}), ...(toAt ? { lte: toAt } : {}) } } } : {}),
            },
            include: { event: true },
            orderBy: { registeredAt: 'desc' },
            take: 100,
          }) ?? Promise.resolve([]))
        : Promise.resolve([]),
      !platform || platform === 'formal'
        ? (this.db.teamCompetitionEntry?.findMany({
            where: {
              status: { in: ['approved', 'confirmed'] },
              team: { members: { some: { userId: memberId, status: 'active' } } },
              ...((fromAt || toAt) ? { event: { startAt: { ...(fromAt ? { gte: fromAt } : {}), ...(toAt ? { lte: toAt } : {}) } } } : {}),
            },
            include: { event: true, team: true },
            orderBy: { registeredAt: 'desc' },
            take: 100,
          }) ?? Promise.resolve([]))
        : Promise.resolve([]),
    ])

    type ResultItem = {
      cursorKey: string
      platform: string
      contestId: string
      contestName: string
      startTime: string
      participationType: string
      score: number | null
      fullScore: number | null
      acceptedCount: number | null
      problemCount: number | null
      rank: number | null
      rankTotal: number | null
      status: string
      verifiedBinding: boolean
    }

    const items: ResultItem[] = rows.map((r) => ({
      cursorKey: `pr:${r.id}`,
      platform: r.platformContest.platform,
      contestId: r.platformContest.externalContestId,
      contestName: r.platformContest.name,
      startTime: r.platformContest.startTime.toISOString(),
      participationType: r.participationType,
      score: r.score ? Number(r.score) : null,
      fullScore: r.fullScore ? Number(r.fullScore) : null,
      acceptedCount: r.acceptedCount,
      problemCount: r.problemCount,
      rank: r.rank,
      rankTotal: r.rankTotal,
      status: r.status,
      verifiedBinding: r.platformAccount.status === 'verified',
    }))

    const seenKeys = new Set(items.map((item) => `${item.platform}:${item.contestId}`))

    // 历史已结算或 Excel 导入的平台赛（尤其是 VJudge）回补展示，不重复
    const activityIds: string[] = []
    for (const entry of contestLedger) {
      const d = (entry.detail && typeof entry.detail === 'object' ? entry.detail : {}) as Record<string, unknown>
      if (typeof d.activityId === 'string' && /^[0-9a-f-]{36}$/i.test(d.activityId)) {
        activityIds.push(d.activityId)
      }
    }
    const activities = activityIds.length > 0
      ? await this.db.activity.findMany({
          where: { id: { in: [...new Set(activityIds)] } },
          select: { id: true, title: true, startAt: true, teamSize: true },
        })
      : []
    const actMap = new Map(activities.map((a) => [a.id, a]))

    for (const entry of contestLedger) {
      const parts = entry.sourceKey.split(':')
      const plat = parts[1]
      const cid = parts[2]
      if (!plat || !cid) continue
      const dedupeKey = `${plat}:${cid}`
      if (seenKeys.has(dedupeKey)) continue
      if (platform && plat !== platform) continue
      const d = (entry.detail && typeof entry.detail === 'object' ? entry.detail : {}) as Record<string, unknown>
      const act = typeof d.activityId === 'string' ? actMap.get(d.activityId) : undefined
      const startDate =
        act?.startAt ??
        (typeof d.activityDate === 'string' && !Number.isNaN(Date.parse(d.activityDate)) ? new Date(d.activityDate) : entry.recordedAt)
      if (fromAt && startDate < fromAt) continue
      if (toAt && startDate > toAt) continue
      seenKeys.add(dedupeKey)
      const isTeam = Boolean(d.teamId || d.teamName || (act?.teamSize && act.teamSize > 1))
      const contestName =
        act?.title ??
        (typeof d.activityTitle === 'string' && d.activityTitle.trim() ? d.activityTitle.trim() : `${plat.toUpperCase()} #${cid}`)
      items.push({
        cursorKey: `le:${entry.id}`,
        platform: plat,
        contestId: cid,
        contestName,
        startTime: startDate.toISOString(),
        participationType: isTeam ? 'TEAM' : 'OFFICIAL',
        score: Number(entry.amount),
        fullScore: null,
        acceptedCount: null,
        problemCount: null,
        rank: null,
        rankTotal: null,
        status: 'complete',
        verifiedBinding: verifiedPlatforms.has(plat),
      })
    }

    // 正式赛事（个人赛与团队赛，含导入归档记录）联动展示在比赛成绩列表
    const seenFormalEvents = new Set<string>()
    for (const reg of formalRegs) {
      if (seenFormalEvents.has(reg.eventId)) continue
      seenFormalEvents.add(reg.eventId)
      const d = (reg.resultDetail && typeof reg.resultDetail === 'object' && !Array.isArray(reg.resultDetail)
        ? reg.resultDetail
        : {}) as Record<string, unknown>
      const awardLabel = typeof d.awardText === 'string' && d.awardText.trim() ? d.awardText.trim() : null
      const rankNum = typeof d.rankText === 'string' && /^\d+$/.test(d.rankText.trim()) ? Number(d.rankText.trim()) : null
      items.push({
        cursorKey: `cr:${reg.id}`,
        platform: 'formal',
        contestId: reg.eventId,
        contestName: reg.event.title,
        startTime: reg.event.startAt.toISOString(),
        participationType: awardLabel ?? 'OFFICIAL',
        score: reg.resultScore ? Number(reg.resultScore) : null,
        fullScore: null,
        acceptedCount: null,
        problemCount: null,
        rank: rankNum,
        rankTotal: null,
        status: 'complete',
        verifiedBinding: true,
      })
    }
    for (const entry of formalTeamEntries) {
      if (seenFormalEvents.has(entry.eventId)) continue
      seenFormalEvents.add(entry.eventId)
      const d = (entry.resultDetail && typeof entry.resultDetail === 'object' && !Array.isArray(entry.resultDetail)
        ? entry.resultDetail
        : {}) as Record<string, unknown>
      const memberResults = Array.isArray(d.memberResults)
        ? (d.memberResults as Array<Record<string, unknown>>)
        : []
      const mr = memberResults.find((m) => m.userId === memberId)
      const awardLabel =
        (mr && typeof mr.awardText === 'string' && mr.awardText.trim() ? mr.awardText.trim() : null) ??
        (typeof d.awardText === 'string' && d.awardText.trim() ? d.awardText.trim() : null)
      const rawRank =
        (mr && typeof mr.rankText === 'string' ? mr.rankText.trim() : null) ??
        (typeof d.rankText === 'string' ? d.rankText.trim() : null)
      const rankNum = rawRank && /^\d+$/.test(rawRank) ? Number(rawRank) : null
      const scoreVal =
        mr && typeof mr.points === 'string' && Number(mr.points) !== 0
          ? Number(mr.points)
          : entry.resultScore
            ? Number(entry.resultScore)
            : null
      items.push({
        cursorKey: `te:${entry.id}`,
        platform: 'formal',
        contestId: entry.eventId,
        contestName: entry.event.title,
        startTime: entry.event.startAt.toISOString(),
        participationType: awardLabel ? `${entry.team.name} · ${awardLabel}` : `TEAM · ${entry.team.name}`,
        score: scoreVal,
        fullScore: null,
        acceptedCount: null,
        problemCount: null,
        rank: rankNum,
        rankTotal: null,
        status: 'complete',
        verifiedBinding: true,
      })
    }

    items.sort((a, b) => b.startTime.localeCompare(a.startTime) || b.cursorKey.localeCompare(a.cursorKey))

    const startIndex = cursor ? Math.max(0, items.findIndex((item) => item.cursorKey === cursor) + 1) : 0
    const page = items.slice(startIndex, startIndex + 25)
    const nextCursor = startIndex + 25 < items.length ? page.at(-1)?.cursorKey : undefined

    return ok({
      items: page.map(({ cursorKey: _k, ...rest }) => rest),
      nextCursor,
      note: isSelf ? undefined : '他人视图仅含可见字段',
    })
  }

  /** 活动参与历史（报名/到场/认定分维度） */
  @Get('profiles/:memberId/activities')
  async memberActivities(@CurrentActor() actor: SessionActor, @Param('memberId', ParseUUIDPipe) memberId: string, @Query('cursor') cursor?: string) {
    const isSelf = actor.userId === memberId
    const regs = await this.db.activityRegistration.findMany({
      where: { userId: memberId },
      orderBy: { createdAt: 'desc' },
      take: 26,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { activity: { select: { id: true, title: true, type: true, startAt: true, endAt: true } } },
    })
    const checkpoints = await this.db.attendanceCheckpoint.findMany({ where: { userId: memberId } })
    const results = await this.db.attendanceAttendanceResult.findMany({ where: { userId: memberId } })
    const cpKey = (a: string, c: string) => `${a}:${c}`
    const cpMap = new Map(checkpoints.map((c) => [cpKey(c.activityId, c.checkpoint), c.acceptedAt.toISOString()]))
    const resultMap = new Map(results.map((r) => [r.activityId, r.status]))
    const nextCursor = regs.length > 25 ? regs.pop()!.id : undefined
    return ok({
      items: regs.map((r) => ({
        activityId: r.activity.id,
        title: r.activity.title,
        type: r.activity.type,
        startAt: r.activity.startAt.toISOString(),
        registration: isSelf ? r.status : r.status === 'enrolled' ? 'participated' : null,
        checkin: cpMap.get(cpKey(r.activityId, 'IN')) ?? null,
        checkout: cpMap.get(cpKey(r.activityId, 'OUT')) ?? null,
        attendanceResult: resultMap.get(r.activityId) ?? null,
      })),
      nextCursor,
    })
  }
}

@Controller('/api/v1/admin/badges')
@UseGuards(SessionGuard, PermissionsGuard, ActionGuard)
export class BadgesAdminController {
  constructor(private readonly profiles: ProfilesService, private readonly db: PrismaService) {}

  @Get('definitions')
  @RequireAction('members.read')
  async listDefinitions() {
    return ok(await this.db.badgeDefinition.findMany({ orderBy: { createdAt: 'desc' } }))
  }

  @Post('definitions')
  @RequireAction('badges.define')
  async define(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const parsed = z.object({
      key: z.string().regex(/^[a-z0-9_]{2,40}$/),
      name: z.string().min(2).max(40),
      description: z.string().min(5).max(300),
      icon: z.enum(['award', 'book-open', 'code', 'heart', 'star', 'target', 'users', 'zap']),
      theme: z.enum(['blue', 'mint', 'lilac', 'amber']),
      category: z.enum(['honor', 'contribution', 'service', 'activity', 'growth']),
      grantMethod: z.enum(['manual', 'rule']),
      isOfficialHonor: z.boolean().optional(),
    }).parse(body)
    return ok(await this.profiles.defineBadge(actor, parsed))
  }

  @Get('awards')
  @RequireAction('members.read')
  async listAwards() {
    return ok(await this.profiles.listBadgeAwards())
  }

  @Post('auto-grant')
  @RequireAction('badges.grant')
  async autoGrant(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const parsed = z.object({ dryRun: z.boolean().default(false) }).parse(body ?? {})
    return ok(await this.profiles.autoGrantBadges(actor, parsed.dryRun))
  }

  @Post('awards')
  @RequireAction('badges.grant')
  async grant(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const parsed = z.object({
      definitionKey: z.string().min(2).max(40),
      userId: z.string().uuid(),
      reason: z.string().min(3).max(500),
      evidenceRef: z.string().max(200).optional(),
      expiresAt: z.string().datetime().optional(),
    }).parse(body)
    return ok(await this.profiles.grantBadge(actor, parsed))
  }

  @Post('awards/:id/revoke')
  @RequireAction('badges.grant')
  async revoke(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(body)
    return ok(await this.profiles.revokeBadge(actor, id, reason))
  }
}
