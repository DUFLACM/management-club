import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { SessionGuard, PermissionsGuard, ActionGuard, RequireAction, CurrentActor, actorCan, ok } from '../../common/guards.js'
import type { SessionActor } from '../auth/session.service.js'
import { VenueService, VenueError, venueDraftSchema, sampleSchema } from './venue.service.js'
import { PrismaService } from '../../infrastructure/database/database.module.js'

/** /api/v1/admin/venues（09 方案 7；操作人取 session principal，写操作校验动作权限） */
@Controller('/api/v1/admin/venues')
@UseGuards(SessionGuard, PermissionsGuard, ActionGuard)
export class VenueAdminController {
  constructor(
    private readonly venues: VenueService,
    private readonly db: PrismaService,
  ) {}

  @Get()
  @RequireAction('venue.manage')
  async list(
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @CurrentActor() _actor?: SessionActor,
  ) {
    const where: Record<string, unknown> = {}
    if (status === 'active' || status === 'suspended' || status === 'archived') where.operationalStatus = status
    if (q) where.name = { contains: q, mode: 'insensitive' }
    const rows = await this.db.venue.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 21,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        versions: {
          orderBy: { versionNo: 'desc' },
          take: 3,
          select: {
            id: true, versionNo: true, status: true, name: true, building: true, room: true,
            allowedCapabilities: true, validFrom: true, validUntil: true, revokedAt: true,
            approvedAt: true, approvedBy: true, rejectedReason: true, submittedAt: true,
          },
        },
        _count: { select: { versions: true } },
      },
    })
    const nextCursor = rows.length > 20 ? rows.pop()!.id : undefined
    return ok(
      rows.map((v) => ({
        id: v.id,
        name: v.name,
        campus: v.campus,
        building: v.building,
        floor: v.floor,
        room: v.room,
        operationalStatus: v.operationalStatus,
        suspendReason: v.suspendReason,
        effectiveVersionId: v.effectiveVersionId,
        versions: v.versions,
        versionCount: v._count.versions,
      })),
      { nextCursor },
    )
  }

  @Post()
  @RequireAction('venue.manage')
  async create(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const input = venueDraftSchema.parse(body)
    const result = await this.venues.createVenue(actor, input)
    return ok(result)
  }

  @Get(':id')
  @RequireAction('venue.manage')
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    const venue = await this.db.venue.findUnique({
      where: { id },
      include: {
        versions: {
          orderBy: { versionNo: 'desc' },
          include: {
            contributors: true,
            samples: { select: { id: true, source: true, sampledAt: true, accuracyMeters: true, deviceType: true, note: true, contentHash: true } },
            reviewEvents: true,
            activityBindings: { include: { activity: { select: { id: true, title: true, status: true, startAt: true } } } },
          },
        },
      },
    })
    return ok(venue)
  }

  @Post(':id/versions')
  @RequireAction('venue.manage')
  async newVersion(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ baseVersionId: z.string().uuid(), input: venueDraftSchema }).parse(body)
    return ok(await this.venues.newDraftFromVersion(actor, id, parsed.baseVersionId, parsed.input))
  }

  @Patch(':id/versions/:versionId')
  @RequireAction('venue.manage')
  async updateDraft(
    @CurrentActor() actor: SessionActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() body: unknown,
  ) {
    const parsed = z.object({ expectedRevision: z.number().int().min(1), input: venueDraftSchema }).parse(body)
    await this.venues.updateDraft(actor, id, versionId, parsed.expectedRevision, parsed.input)
    return ok({ updated: true })
  }

  @Post(':id/versions/:versionId/samples')
  @RequireAction('venue.manage')
  async addSample(
    @CurrentActor() actor: SessionActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() body: unknown,
  ) {
    const input = sampleSchema.parse(body)
    await this.venues.addSample(actor, id, versionId, input)
    return ok({ added: true })
  }

  @Post(':id/versions/:versionId/submit')
  @RequireAction('venue.manage')
  async submit(
    @CurrentActor() actor: SessionActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() body: unknown,
  ) {
    const { expectedRevision } = z.object({ expectedRevision: z.number().int().min(1) }).parse(body)
    await this.venues.submitForReview(actor, id, versionId, expectedRevision)
    return ok({ submitted: true })
  }

  @Post(':id/versions/:versionId/decisions')
  @RequireAction('venue.verify')
  async decide(
    @CurrentActor() actor: SessionActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() body: unknown,
  ) {
    const parsed = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().min(3).max(1000), expectedContentHash: z.string().length(64).optional() }).parse(body)
    await this.venues.decide(actor, id, versionId, parsed.decision, parsed.reason, parsed.expectedContentHash)
    return ok({ decided: parsed.decision })
  }

  @Post(':id/versions/:versionId/revoke')
  @RequireAction('venue.verify')
  async revoke(
    @CurrentActor() actor: SessionActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() body: unknown,
  ) {
    const { reason } = z.object({ reason: z.string().min(3).max(1000) }).parse(body)
    await this.venues.revoke(actor, id, versionId, reason)
    return ok({ revoked: true })
  }

  @Get(':id/impact')
  @RequireAction('venue.manage')
  async impact(@Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.venues.impactPreview(id))
  }

  @Post(':id/suspend')
  @RequireAction('venue.suspend')
  async suspend(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = z.object({ reason: z.string().min(3).max(1000) }).parse(body)
    await this.venues.setOperationalStatus(actor, id, 'suspended', reason)
    return ok({ status: 'suspended' })
  }

  @Post(':id/resume')
  @RequireAction('venue.suspend')
  async resume(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = z.object({ reason: z.string().max(500).optional() }).parse(body ?? {})
    await this.venues.setOperationalStatus(actor, id, 'active', reason ?? '恢复运行')
    return ok({ status: 'active' })
  }

  @Post(':id/archive')
  @RequireAction('venue.suspend')
  async archive(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = z.object({ reason: z.string().min(3).max(1000) }).parse(body)
    await this.venues.setOperationalStatus(actor, id, 'archived', reason)
    return ok({ status: 'archived' })
  }
}

export { VenueError, actorCan }
