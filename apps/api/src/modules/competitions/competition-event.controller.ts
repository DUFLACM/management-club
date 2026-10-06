import {
  BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { createReadStream } from 'node:fs'
import type { Response } from 'express'
import { z } from 'zod'
import { SessionGuard, PermissionsGuard, ActionGuard, RequireAction, CurrentUser, CurrentActor, ok } from '../../common/guards.js'
import { CompetitionEventService, CompetitionError, competitionEventInputSchema } from './competition-event.service.js'
import type { SessionActor } from '../auth/session.service.js'

/** 成员端 · 正式赛事报名 */
@Controller('/api/v1/me')
@UseGuards(SessionGuard, PermissionsGuard)
export class CompetitionMeController {
  constructor(private readonly events: CompetitionEventService) {}

  @Get('competition-events')
  async list(@CurrentUser() user: { userId: string } | null) {
    return ok(await this.events.listOpen(user?.userId ?? null))
  }

  @Get('competition-events/:id')
  async detail(@CurrentUser() user: { userId: string } | null, @Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.events.detailForUser(user?.userId ?? null, id))
  }

  @Get('competition-events/:id/shortlist')
  async shortlist(@CurrentUser() user: { userId: string } | null, @Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.events.shortlistForMember(user?.userId ?? null, id))
  }

  @Post('competition-events/:id/register')
  async register(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ platformAccountId: z.string().uuid().optional(), note: z.string().max(500).optional() }).safeParse(body ?? {})
    if (!parsed.success) throw new CompetitionError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.events.registerIndividual(user.userId, id, parsed.data))
  }

  @Post('competition-registrations/:id/resubmit')
  async resubmit(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ note: z.string().max(500).optional() }).safeParse(body ?? {})
    await this.events.resubmitRegistration(user.userId, id, parsed.success ? parsed.data.note : undefined)
    return ok({ resubmitted: true })
  }

  @Post('competition-registrations/:id/materials')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024, files: 1 } }))
  async uploadMaterial(
    @CurrentUser() user: { userId: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @UploadedFile() file?: { buffer: Buffer; mimetype: string; size: number; originalname?: string },
  ) {
    if (!file) throw new BadRequestException('缺少上传文件')
    const parsed = z.object({ title: z.string().min(1).max(200) }).safeParse(body ?? {})
    if (!parsed.success) throw new CompetitionError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.events.uploadRegistrationMaterial(user.userId, id, file, parsed.data))
  }

  @Get('competition-registrations/:id/materials/:materialId/download')
  async downloadMaterial(
    @CurrentUser() user: { userId: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Param('materialId', ParseUUIDPipe) materialId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { material, filePath } = await this.events.materialForDownload(id, materialId, user.userId)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Type', material.mimeType ?? 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(material.fileName)}`)
    return new StreamableFile(createReadStream(filePath))
  }
}

/** 管理端 · 正式赛事报名 */
@Controller('/api/v1/admin/competition-events')
@UseGuards(SessionGuard, PermissionsGuard, ActionGuard)
export class CompetitionAdminController {
  constructor(private readonly events: CompetitionEventService) {}

  @Get()
  @RequireAction('competitions.manage')
  async list(@Query('status') status?: string) {
    return ok(await this.events.adminList(status))
  }

  @Post()
  @RequireAction('competitions.manage')
  async create(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const parsed = competitionEventInputSchema.safeParse(body)
    if (!parsed.success) throw new CompetitionError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.events.createEvent(actor, parsed.data))
  }

  @Post(':id/publish')
  @RequireAction('competitions.manage')
  async publish(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    await this.events.publish(actor, id)
    return ok({ published: true })
  }

  @Post(':id/build-shortlist')
  @RequireAction('competitions.manage')
  async buildShortlist(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.events.buildShortlist(actor, id))
  }

  @Get(':id/shortlist')
  @RequireAction('competitions.manage')
  async shortlist(@Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.events.listShortlist(id))
  }

  @Post(':id/shortlist/:userId/override')
  @RequireAction('competitions.manage')
  async overrideShortlist(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string, @Body() body: unknown) {
    const parsed = z.object({ qScore: z.number().nullable().optional(), eligible: z.boolean().optional() }).safeParse(body ?? {})
    if (!parsed.success) throw new CompetitionError(parsed.error.issues[0].message, 'INVALID_INPUT')
    await this.events.overrideShortlistRow(actor, id, userId, parsed.data)
    return ok({ updated: true })
  }

  @Get(':id/registrations')
  @RequireAction('competitions.manage')
  async registrations(@Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.events.adminListRegistrations(id))
  }

  @Get(':id/team-entries')
  @RequireAction('competitions.manage')
  async teamEntries(@Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.events.adminListTeamEntries(id))
  }

  @Get('registrations/:registrationId/materials/:materialId/download')
  @RequireAction('competitions.manage')
  async downloadMaterial(
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
    @Param('materialId', ParseUUIDPipe) materialId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { material, filePath } = await this.events.materialForDownload(registrationId, materialId, null)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Type', material.mimeType ?? 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(material.fileName)}`)
    return new StreamableFile(createReadStream(filePath))
  }

  @Post('registrations/:registrationId/review')
  @RequireAction('competitions.manage')
  async reviewRegistration(@CurrentActor() actor: SessionActor, @Param('registrationId', ParseUUIDPipe) registrationId: string, @Body() body: unknown) {
    const parsed = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional(), award: z.record(z.string(), z.unknown()).optional() }).safeParse(body)
    if (!parsed.success) throw new CompetitionError(parsed.error.issues[0].message, 'INVALID_INPUT')
    await this.events.reviewRegistration(actor, registrationId, parsed.data.decision, { note: parsed.data.note, award: parsed.data.award })
    return ok({ reviewed: true })
  }

  @Post('team-entries/:entryId/review')
  @RequireAction('competitions.manage')
  async reviewTeamEntry(@CurrentActor() actor: SessionActor, @Param('entryId', ParseUUIDPipe) entryId: string, @Body() body: unknown) {
    const parsed = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional(), award: z.record(z.string(), z.unknown()).optional() }).safeParse(body)
    if (!parsed.success) throw new CompetitionError(parsed.error.issues[0].message, 'INVALID_INPUT')
    await this.events.reviewTeamEntry(actor, entryId, parsed.data.decision, { note: parsed.data.note, award: parsed.data.award })
    return ok({ reviewed: true })
  }

  @Post(':id/settle')
  @RequireAction('competitions.manage')
  async settle(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.events.settleEvent(actor, id))
  }

  @Get(':id/export')
  @RequireAction('competitions.manage')
  async exportRoster(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const csv = await this.events.exportRosterCsv(id)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="roster-${id}.csv"`)
    return new StreamableFile(Buffer.from(`﻿${csv}`, 'utf-8'))
  }
}
