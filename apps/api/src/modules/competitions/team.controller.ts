import {
  BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { createReadStream } from 'node:fs'
import type { Response } from 'express'
import { z } from 'zod'
import { SessionGuard, PermissionsGuard, ActionGuard, RequireAction, CurrentUser, CurrentActor, ok } from '../../common/guards.js'
import { TeamService, TeamError } from './team.service.js'
import { TeamAdminService } from './team-admin.service.js'
import type { SessionActor } from '../auth/session.service.js'

/** 成员端 · 组队广场 */
@Controller('/api/v1/me')
@UseGuards(SessionGuard, PermissionsGuard)
export class TeamMeController {
  constructor(private readonly teams: TeamService) {}

  @Get('teams')
  async myTeams(@CurrentUser() user: { userId: string }) {
    return ok(await this.teams.myTeams(user.userId))
  }

  @Post('teams')
  async createTeam(@CurrentUser() user: { userId: string }, @Body() body: unknown) {
    const parsed = z.object({ name: z.string().min(2).max(80), teamSize: z.number().int().min(2).max(10) }).safeParse(body)
    if (!parsed.success) throw new TeamError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.teams.createTeam(user.userId, parsed.data))
  }

  @Get('team-invites')
  async myInvites(@CurrentUser() user: { userId: string }) {
    return ok(await this.teams.myInvites(user.userId))
  }

  @Get('invitable-members')
  async invitableMembers(@CurrentUser() user: { userId: string }, @Query('q') q?: string) {
    return ok(await this.teams.searchInvitableMembers(user.userId, q ?? ''))
  }

  @Post('teams/:id/invite')
  async invite(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ inviteeUserId: z.string().uuid() }).safeParse(body)
    if (!parsed.success) throw new TeamError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.teams.inviteMember(id, user.userId, parsed.data.inviteeUserId))
  }

  @Post('team-invites/:id/respond')
  async respond(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ decision: z.enum(['accept', 'decline']) }).safeParse(body)
    if (!parsed.success) throw new TeamError(parsed.error.issues[0].message, 'INVALID_INPUT')
    await this.teams.respondInvite(id, user.userId, parsed.data.decision)
    return ok({ responded: true })
  }

  @Post('teams/:id/leave')
  async leave(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string) {
    await this.teams.leaveTeam(id, user.userId)
    return ok({ left: true })
  }

  /** 招募广场 */
  @Get('team-recruitments')
  async recruitments(@CurrentUser() user: { userId: string }, @Query('q') q?: string) {
    return ok(await this.teams.listRecruitments(user.userId, q))
  }

  @Post('teams/:id/recruitment')
  async upsertRecruitment(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ description: z.string().trim().min(5, '招募说明至少 5 字').max(1000), activityId: z.string().uuid().nullable().optional() }).safeParse(body)
    if (!parsed.success) throw new TeamError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.teams.upsertRecruitment(user.userId, id, parsed.data))
  }

  @Post('teams/:id/recruitment/close')
  async closeRecruitment(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string) {
    await this.teams.closeRecruitment(user.userId, id)
    return ok({ closed: true })
  }

  @Post('teams/:id/join-requests')
  async apply(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ message: z.string().max(500).optional() }).safeParse(body ?? {})
    if (!parsed.success) throw new TeamError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.teams.applyToTeam(user.userId, id, parsed.data.message))
  }

  @Get('team-join-requests')
  async myJoinRequests(@CurrentUser() user: { userId: string }) {
    return ok(await this.teams.myJoinRequests(user.userId))
  }

  @Post('team-join-requests/:id/cancel')
  async cancelJoin(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string) {
    await this.teams.cancelJoinRequest(user.userId, id)
    return ok({ cancelled: true })
  }

  @Post('team-join-requests/:id/decision')
  async decideJoin(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ decision: z.enum(['approve', 'reject']) }).safeParse(body)
    if (!parsed.success) throw new TeamError(parsed.error.issues[0].message, 'INVALID_INPUT')
    await this.teams.decideJoinRequest(user.userId, id, parsed.data.decision)
    return ok({ decided: parsed.data.decision })
  }

  @Get('teams/:id/eligible-events')
  async eligibleEvents(@Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.teams.eligibleEvents(id))
  }

  @Post('teams/:id/register/:eventId')
  async registerForEvent(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string, @Param('eventId', ParseUUIDPipe) eventId: string) {
    return ok(await this.teams.registerTeamForEvent(id, eventId, user.userId))
  }

  @Post('team-competition-entries/:entryId/materials')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024, files: 1 } }))
  async uploadMaterial(
    @CurrentUser() user: { userId: string },
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() body: unknown,
    @UploadedFile() file?: { buffer: Buffer; mimetype: string; size: number; originalname?: string },
  ) {
    if (!file) throw new BadRequestException('缺少上传文件')
    const parsed = z.object({ title: z.string().min(1).max(200) }).safeParse(body ?? {})
    if (!parsed.success) throw new TeamError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.teams.uploadTeamMaterial(user.userId, entryId, file, parsed.data))
  }

  @Get('team-competition-entries/:entryId/materials/:materialId/download')
  async downloadMaterial(
    @CurrentUser() user: { userId: string },
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Param('materialId', ParseUUIDPipe) materialId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { material, filePath } = await this.teams.teamMaterialForDownload(entryId, materialId, user.userId)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Type', material.mimeType ?? 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(material.fileName)}`)
    return new StreamableFile(createReadStream(filePath))
  }
}

/** 管理端 · 强制编组 */
@Controller('/api/v1/admin/competition-events')
@UseGuards(SessionGuard, PermissionsGuard, ActionGuard)
export class TeamAdminController {
  constructor(private readonly teams: TeamService) {}

  @Post(':id/force-team-assignment')
  @RequireAction('competitions.manage')
  async forceAssign(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.teams.forceTeamAssignment(actor, id))
  }

  @Get('team-entries/:entryId/materials/:materialId/download')
  @RequireAction('competitions.manage')
  async downloadMaterial(
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Param('materialId', ParseUUIDPipe) materialId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { material, filePath } = await this.teams.teamMaterialForDownload(entryId, materialId, null)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Type', material.mimeType ?? 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(material.fileName)}`)
    return new StreamableFile(createReadStream(filePath))
  }
}

/** 管理端 · 组队管理页（/admin?section=teams） */
@Controller('/api/v1/admin/teams')
@UseGuards(SessionGuard, PermissionsGuard, ActionGuard)
export class TeamManageController {
  constructor(private readonly teams: TeamAdminService) {}

  @Get()
  @RequireAction('competitions.manage')
  async list(@Query('q') q?: string, @Query('status') status?: string, @Query('cursor') cursor?: string) {
    return ok(await this.teams.list({ q, status, cursor }))
  }

  @Get(':id')
  @RequireAction('competitions.manage')
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.teams.detail(id))
  }

  @Post()
  @RequireAction('competitions.manage')
  async create(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const parsed = z.object({
      name: z.string().trim().min(2, '队名至少 2 个字').max(80),
      teamSize: z.number().int().min(1).max(10),
      captainUserId: z.string().uuid(),
      memberUserIds: z.array(z.string().uuid()).max(10).optional(),
    }).safeParse(body)
    if (!parsed.success) throw new TeamError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.teams.create(actor, parsed.data))
  }

  @Post(':id')
  @RequireAction('competitions.manage')
  async update(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({
      name: z.string().trim().min(2, '队名至少 2 个字').max(80).optional(),
      teamSize: z.number().int().min(1).max(10).optional(),
      status: z.enum(['forming', 'locked']).optional(),
    }).safeParse(body)
    if (!parsed.success) throw new TeamError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.teams.update(actor, id, parsed.data))
  }

  @Post(':id/members')
  @RequireAction('competitions.manage')
  async addMember(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ userId: z.string().uuid() }).safeParse(body)
    if (!parsed.success) throw new TeamError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.teams.addMember(actor, id, parsed.data.userId))
  }

  @Post(':id/members/:userId/remove')
  @RequireAction('competitions.manage')
  async removeMember(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string) {
    return ok(await this.teams.removeMember(actor, id, userId))
  }

  @Post(':id/captain')
  @RequireAction('competitions.manage')
  async setCaptain(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ userId: z.string().uuid() }).safeParse(body)
    if (!parsed.success) throw new TeamError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.teams.setCaptain(actor, id, parsed.data.userId))
  }

  @Post(':id/disband')
  @RequireAction('competitions.manage')
  async disband(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ reason: z.string().trim().max(200).optional() }).safeParse(body ?? {})
    if (!parsed.success) throw new TeamError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.teams.disband(actor, id, parsed.data.reason || undefined))
  }

  @Post(':id/invites/:inviteId/cancel')
  @RequireAction('competitions.manage')
  async cancelInvite(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Param('inviteId', ParseUUIDPipe) inviteId: string) {
    return ok(await this.teams.cancelInvite(actor, id, inviteId))
  }
}
