import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors, BadRequestException } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { createReadStream } from 'node:fs'
import { z } from 'zod'
import { SessionGuard, CurrentUser, RequireAction, ActionGuard, PermissionsGuard, ok } from '../../common/guards.js'
import { ActivityError, ActivityService, activityInputSchema, activityUpdateSchema, lectureRatingSchema } from './activity.service.js'
import { AttendanceService, checkpointSubmitSchema, challengeRequestSchema } from '../attendance/attendance.service.js'
import { ContestStandingsService } from './contest-standings.service.js'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { monthKey } from '../../common/utils.js'
import type { SessionActor } from '../auth/session.service.js'
import { CurrentActor } from '../../common/guards.js'
import type { Response } from 'express'

/** 用户侧活动/出勤 API */
@Controller('/api/v1')
@UseGuards(SessionGuard, PermissionsGuard)
export class ActivityUserController {
  constructor(
    private readonly activities: ActivityService,
    private readonly attendance: AttendanceService,
    private readonly standings: ContestStandingsService,
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
  async detail(
    @CurrentActor() actor: SessionActor,
    @CurrentUser() user: { userId: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return ok(await this.activities.detailForUser(user.userId, id, actor))
  }

  /** 平台榜单（社团视角）：题目外链/我的成绩/对题数排名；不可抓取时降级外链 */
  @Get('activities/:id/standings')
  async contestStandings(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.activities.activityStandings(user.userId, id, this.standings))
  }

  /** 申请讲题：审批通过后获得本活动材料上传权限 */
  @Post('activities/:id/lecture-requests')
  async submitLectureRequest(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ topic: z.string().max(200).optional() }).safeParse(body ?? {})
    if (!parsed.success) throw new ActivityError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.activities.submitLectureRequest(user.userId, id, parsed.data.topic))
  }

  /** 讲题满意度评分：活动结束后由到场成员提交，可改分；聚合结果见 GET activities/:id */
  @Post('activities/:id/lectures/:lectureRequestId/rating')
  async rateLecture(
    @CurrentUser() user: { userId: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lectureRequestId', ParseUUIDPipe) lectureRequestId: string,
    @Body() body: unknown,
  ) {
    const parsed = lectureRatingSchema.safeParse(body ?? {})
    if (!parsed.success) throw new ActivityError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.activities.submitLectureRating(user.userId, id, lectureRequestId, parsed.data))
  }

  /** 撤销本人提交的讲题满意度评分 */
  @Delete('activities/:id/lectures/:lectureRequestId/rating')
  async removeLectureRating(
    @CurrentUser() user: { userId: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lectureRequestId', ParseUUIDPipe) lectureRequestId: string,
  ) {
    await this.activities.deleteLectureRating(user.userId, id, lectureRequestId)
    return ok({ deleted: true })
  }

  /** 上传活动材料（讲题幻灯片/题解）：获批讲题人或 activity.manage */
  @Post('activities/:id/materials')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024, files: 1 } }))
  async uploadMaterial(
    @CurrentActor() actor: SessionActor,
    @CurrentUser() user: { userId: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @UploadedFile() file?: { buffer: Buffer; mimetype: string; size: number; originalname?: string },
  ) {
    if (!file) throw new BadRequestException('缺少上传文件')
    const parsed = z.object({
      title: z.string().min(1).max(200),
      kind: z.enum(['slides', 'solution', 'data', 'other']).default('solution'),
    }).safeParse(body ?? {})
    if (!parsed.success) throw new ActivityError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.activities.createMaterial(actor, user.userId, id, file, parsed.data))
  }

  /** 材料下载：登录成员可见（社团内部资料，no-store） */
  @Get('activities/:id/materials/:materialId/download')
  async downloadMaterial(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('materialId', ParseUUIDPipe) materialId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { material, filePath } = await this.activities.materialForDownload(id, materialId)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Type', material.mimeType ?? 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(material.fileName)}`)
    return new StreamableFile(createReadStream(filePath))
  }

  /** 删除本人上传的材料（管理员可删任意） */
  @Delete('activities/:id/materials/:materialId')
  async removeMaterial(
    @CurrentActor() actor: SessionActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('materialId', ParseUUIDPipe) materialId: string,
  ) {
    await this.activities.deleteMaterial(actor, id, materialId)
    return ok({ deleted: true })
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

  /** 删除草稿活动（无任何业务数据；已发布活动走取消/归档） */
  @Delete(':id')
  @RequireAction('activity.manage')
  async remove(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    await this.activities.deleteDraft(actor, id)
    return ok({ deleted: true })
  }

  /** 批量删除草稿（逐项校验，失败项跳过并返回原因） */
  @Post('batch-delete')
  @RequireAction('activity.manage')
  async batchRemove(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const parsed = z.object({ activityIds: z.array(z.string().uuid()).min(1).max(100) }).safeParse(body)
    if (!parsed.success) throw new ActivityError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.activities.batchDeleteDrafts(actor, parsed.data.activityIds))
  }

  @Post(':id/required-participants')
  @RequireAction('activity.manage')
  async setRequired(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { userIds } = z.object({ userIds: z.array(z.string().uuid()).min(1).max(200) }).parse(body)
    await this.activities.setRequiredParticipants(actor, id, userIds)
    return ok({ updated: true })
  }

  /** 讲题申请队列（通过后该成员获得本活动材料上传权限） */
  @Get(':id/lecture-requests')
  @RequireAction('activity.manage')
  async lectureRequests(@Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.activities.listLectureRequests(id))
  }

  /** 讲题满意度汇总（匿名）：供无学生账号的指导教师/负责人查看 */
  @Get(':id/lecture-ratings')
  @RequireAction('activity.manage')
  async lectureRatings(@Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.activities.lectureRatingsForAdmin(id))
  }

  @Post(':id/lecture-requests/:requestId/decision')
  @RequireAction('activity.manage')
  async decideLectureRequest(
    @CurrentActor() actor: SessionActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() body: unknown,
  ) {
    const parsed = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional() }).safeParse(body)
    if (!parsed.success) throw new ActivityError(parsed.error.issues[0].message, 'INVALID_INPUT')
    await this.activities.decideLectureRequest(actor, id, requestId, parsed.data.decision, parsed.data.note)
    return ok({ decided: parsed.data.decision })
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
