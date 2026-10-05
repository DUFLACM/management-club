import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { SessionGuard, CurrentUser, RequireAction, ActionGuard, PermissionsGuard, ok } from '../../common/guards.js'
import { ActivityError, ActivityService, activityInputSchema, activityUpdateSchema } from './activity.service.js'
import { AttendanceService, checkpointSubmitSchema, challengeRequestSchema } from '../attendance/attendance.service.js'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { monthKey } from '../../common/utils.js'
import type { SessionActor } from '../auth/session.service.js'
import { CurrentActor } from '../../common/guards.js'

/** 用户侧活动/出勤 API */
@Controller('/api/v1')
@UseGuards(SessionGuard, PermissionsGuard)
export class ActivityUserController {
  constructor(
    private readonly activities: ActivityService,
    private readonly attendance: AttendanceService,
  ) {}

  @Get('activities')
  async list(
    @CurrentUser() user: { userId: string },
    @Query('tab') tab?: string,
    @Query('type') type?: string,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
  ) {
    return ok(await this.activities.listForUser(user.userId, { tab: whitelist(tab, ['all', 'open', 'mine', 'ongoing', 'ended']), type, q, cursor }))
  }

  @Get('activities/:id')
  async detail(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.activities.detailForUser(user.userId, id))
  }

  @Post('activities/:id/registrations')
  async register(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { idempotencyKey } = z.object({ idempotencyKey: z.string().min(8).max(120).optional() }).parse(body ?? {})
    return ok(await this.activities.register(user.userId, id, idempotencyKey))
  }

  @Delete('activities/:id/registrations/me')
  async cancelReg(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = z.object({ reason: z.string().max(300).optional() }).parse(body ?? {})
    return ok(await this.activities.cancelRegistration(user.userId, id, reason))
  }

  @Post('activities/:id/leave-requests')
  async leave(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = z.object({ reason: z.string().min(3).max(1000) }).parse(body)
    await this.activities.requestLeave(user.userId, id, reason)
    return ok({ submitted: true })
  }

  @Post('activities/:id/remote-requests')
  async remote(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = z.object({ reason: z.string().min(3).max(1000) }).parse(body)
    await this.activities.requestRemote(user.userId, id, reason, monthKey(new Date()))
    return ok({ submitted: true })
  }

  @Get('activities/:id/attendance-context')
  async attendanceContext(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.attendance.attendanceContext(user.userId, id))
  }

  @Post('activities/:id/attendance/challenge')
  async challenge(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = challengeRequestSchema.parse({ ...parsedBody(body), activityId: id })
    return ok(await this.attendance.issueChallenge(user.userId, id, input.checkpoint))
  }

  @Post('activities/:id/attendance/checkpoints')
  async submitCheckpoint(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = checkpointSubmitSchema.parse(parsedBody(body))
    return ok(await this.attendance.submitCheckpoint(user.userId, input))
  }
}

function parsedBody(body: unknown): Record<string, unknown> {
  return (body ?? {}) as Record<string, unknown>
}

function whitelist(value: string | undefined, allowed: string[]): string | undefined {
  return value && allowed.includes(value) ? value : undefined
}

/** 管理侧活动 API */
@Controller('/api/v1/admin/activities')
@UseGuards(SessionGuard, PermissionsGuard, ActionGuard)
export class ActivityAdminController {
  constructor(
    private readonly activities: ActivityService,
    private readonly db: PrismaService,
  ) {}

  @Get()
  @RequireAction('activity.manage')
  async list(@Query('status') status?: string, @Query('q') q?: string, @Query('cursor') cursor?: string) {
    const where: Record<string, unknown> = {}
    if (status && ['draft', 'published', 'cancelled', 'archived'].includes(status)) where.status = status
    if (q) where.title = { contains: q, mode: 'insensitive' }
    const rows = await this.db.activity.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 21,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        policy: true,
        venueVersion: true,
        _count: { select: { registrations: { where: { status: 'enrolled' } } } },
      },
    })
    const nextCursor = rows.length > 20 ? rows.pop()!.id : undefined
    return ok(rows, { nextCursor })
  }

  @Post()
  @RequireAction('activity.manage')
  async create(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const parsed = activityInputSchema.safeParse(body)
    if (!parsed.success) throw new ActivityError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.activities.createActivity(actor, parsed.data))
  }

  /** 管理详情使用主体权限，不要求关联学生账号。 */
  @Get(':id')
  @RequireAction('activity.manage')
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.activities.detailForAdmin(id))
  }

  @Patch(':id')
  @RequireAction('activity.manage')
  async update(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = activityUpdateSchema.safeParse(body)
    if (!parsed.success) throw new ActivityError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.activities.updateDraft(actor, id, parsed.data))
  }

  @Post('import-contest')
  @RequireAction('activity.manage')
  async importContest(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const parsed = z.object({
      platform: z.enum(['nowcoder', 'codeforces', 'atcoder', 'hydro']),
      contestId: z.string().min(1).max(64).optional(),
      officialUrl: z.string().url().optional(),
      hydroInstanceId: z.string().uuid().optional(),
      hydroDomainId: z.string().max(64).optional(),
    }).refine((v) => v.contestId || v.officialUrl, { message: '需要 contestId 或 officialUrl' }).parse(body)
    const result = await this.activities.importContest(actor, parsed)
    return { ...ok(result), status: 202 } as never
  }

  @Post(':id/publish')
  @RequireAction('activity.manage')
  async publish(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    await this.activities.publish(actor, id)
    return ok({ published: true })
  }

  @Post(':id/required-participants')
  @RequireAction('activity.manage')
  async setRequired(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { userIds } = z.object({ userIds: z.array(z.string().uuid()).min(1).max(200) }).parse(body)
    await this.activities.setRequiredParticipants(actor, id, userIds)
    return ok({ updated: true })
  }

  /** 现场出勤名单（分组统计 + 搜索 + 分页） */
  @Get(':id/attendance')
  @RequireAction('attendance.review')
  async attendanceList(@Param('id', ParseUUIDPipe) id: string, @Query('group') group?: string, @Query('cursor') cursor?: string) {
    const participants = await this.db.activityParticipant.findMany({
      where: { activityId: id },
      take: 51,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { user: { select: { id: true, verifiedRealName: true, studentNo: true } } },
    })
    const registrations = await this.db.activityRegistration.findMany({
      where: { activityId: id },
      include: { user: { select: { id: true, verifiedRealName: true, studentNo: true } } },
    })
    const checkpoints = await this.db.attendanceCheckpoint.findMany({ where: { activityId: id } })
    const results = await this.db.attendanceAttendanceResult.findMany({ where: { activityId: id } })
    const leaves = await this.db.leaveRequest.findMany({ where: { activityId: id } })
    const cpByUser = new Map(checkpoints.map((c) => [`${c.userId}:${c.checkpoint}`, c]))
    const resultByUser = new Map(results.map((r) => [r.userId, r]))
    const leaveByUser = new Map(leaves.map((l) => [l.userId, l]))
    const registrationByUser = new Map(registrations.map((registration) => [registration.userId, registration]))
    const participantByUser = new Map(participants.map((participant) => [participant.userId, participant]))
    const rows = [
      ...participants.map((p) => ({ userId: p.user.id, name: p.user.verifiedRealName, studentNo: p.user.studentNo, required: p.required, regStatus: registrationByUser.get(p.user.id)?.status ?? 'required_list' })),
      ...registrations.map((r) => ({ userId: r.user.id, name: r.user.verifiedRealName, studentNo: r.user.studentNo, required: participantByUser.get(r.user.id)?.required ?? false, regStatus: r.status })),
    ].filter((row, i, arr) => arr.findIndex((x) => x.userId === row.userId) === i)
    const withStatus = rows.map((row) => ({
      ...row,
      checkin: cpByUser.get(`${row.userId}:IN`)?.acceptedAt.toISOString() ?? null,
      checkout: cpByUser.get(`${row.userId}:OUT`)?.acceptedAt.toISOString() ?? null,
      resultStatus: resultByUser.get(row.userId)?.status ?? null,
      leave: leaveByUser.get(row.userId)?.status ?? null,
    }))
    const filtered = group === 'not_checked_in' ? withStatus.filter((r) => !r.checkin) : withStatus
    return ok({
      items: filtered.slice(0, 50),
      stats: {
        total: withStatus.length,
        checkedIn: withStatus.filter((r) => r.checkin).length,
        checkedOut: withStatus.filter((r) => r.checkout).length,
        notCheckedIn: withStatus.filter((r) => !r.checkin).length,
        leaveApproved: withStatus.filter((r) => r.leave === 'approved').length,
        pendingReview: withStatus.filter((r) => r.resultStatus === 'pending_review').length,
      },
    })
  }
}
