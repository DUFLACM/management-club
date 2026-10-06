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

  /** 比赛成绩（四平台 + 自定义；按比赛时间倒序，支持平台/时间段筛选，分页） */
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
    const contestFilter = {
      ...(platform ? { platform } : {}),
      ...((fromAt || toAt) ? { startTime: { ...(fromAt ? { gte: fromAt } : {}), ...(toAt ? { lte: toAt } : {}) } } : {}),
    }
    const rows = await this.db.platformResult.findMany({
      where: {
        platformAccountId: { in: accounts.map((a) => a.id) },
        ...(Object.keys(contestFilter).length > 0 ? { platformContest: contestFilter } : {}),
      },
      orderBy: [{ platformContest: { startTime: 'desc' } }, { id: 'desc' }],
      take: 26,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { platformContest: true, platformAccount: true },
    })
    const nextCursor = rows.length > 25 ? rows.pop()!.id : undefined
    return ok(
      {
        items: rows.map((r) => ({
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
        })),
        nextCursor,
        note: isSelf ? undefined : '他人视图仅含可见字段',
      },
    )
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
