import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { SessionGuard, PermissionsGuard, ActionGuard, RequireAction, CurrentUser, CurrentActor, ok } from '../../common/guards.js'
import { ScoringService, ledgerEntrySchema } from './scoring.service.js'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import type { SessionActor } from '../auth/session.service.js'

@Controller('/api/v1/me')
@UseGuards(SessionGuard, PermissionsGuard)
export class ScoringMeController {
  constructor(private readonly scoring: ScoringService) {}

  @Get('points')
  async points(@CurrentUser() user: { userId: string }, @Query('month') month?: string, @Query('cursor') cursor?: string) {
    return ok(await this.scoring.myLedger(user.userId, { month, cursor }))
  }

  @Get('points/overview')
  async overview(@CurrentUser() user: { userId: string }) {
    return ok(await this.scoring.myScoreOverview(user.userId, monthKeyNow()))
  }

  @Get('leaderboard')
  async leaderboard(@CurrentUser() user: { userId: string } | null, @Query('kind') kind?: string, @Query('ref') ref?: string) {
    const viewerId = user?.userId ?? null
    const validKind = kind === 'disclosure' || kind === 'frozen' ? kind : 'current'
    return ok(await this.scoring.leaderboard(validKind, ref, viewerId))
  }

  @Post('claims')
  async claim(@CurrentUser() user: { userId: string }, @Body() body: unknown) {
    const parsed = z.object({
      category: z.enum(['contribution_lecture', 'solution', 'problem_setting', 'sharing', 'service', 'award']),
      title: z.string().min(2).max(120),
      description: z.string().min(5).max(2000),
      activityId: z.string().uuid().optional(),
      contestKey: z.string().max(120).optional(),
      evidenceNote: z.string().max(500).optional(),
    }).parse(body)
    return ok(await this.scoring.submitClaim(user.userId, parsed))
  }

  @Post('appeals')
  async appeal(@CurrentUser() user: { userId: string }, @Body() body: unknown) {
    const parsed = z.object({
      disclosureId: z.string().uuid().optional(),
      ledgerEntryId: z.string().uuid().optional(),
      subject: z.string().min(5).max(500),
      materials: z.string().max(4000).optional(),
    }).parse(body)
    return ok(await this.scoring.submitAppeal(user.userId, parsed))
  }
}

function monthKeyNow(): string {
  const d = new Date(Date.now() + 8 * 3600_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

@Controller('/api/v1/admin')
@UseGuards(SessionGuard, PermissionsGuard, ActionGuard)
export class ScoringAdminController {
  constructor(
    private readonly scoring: ScoringService,
    private readonly db: PrismaService,
  ) {}

  @Post('scoring-batches')
  @RequireAction('points.propose')
  async buildBatch(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(body)
    return ok(await this.scoring.buildMonthlyBatch(actor, month))
  }

  @Post('ledger-entries')
  @RequireAction('points.review')
  async postEntry(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const input = ledgerEntrySchema.parse(body)
    return ok(await this.scoring.postLedgerEntry(actor, input))
  }

  @Post('ledger-entries/:id/reverse')
  @RequireAction('points.review')
  async reverse(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ reason: z.string().min(3).max(500), replacementAmount: z.string().regex(/^-?\d+(\.\d+)?$/).nullable().optional() }).parse(body)
    return ok(await this.scoring.reverseEntry(actor, id, parsed.reason, parsed.replacementAmount ?? null))
  }

  @Post('disclosures')
  @RequireAction('disclosure.publish')
  async publishDisclosure(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const parsed = z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/),
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
    }).parse(body)
    return ok(await this.scoring.publishMonthlyDisclosure(actor, parsed.month, new Date(parsed.startsAt), new Date(parsed.endsAt)))
  }

  @Get('disclosures')
  @RequireAction('points.review')
  async listDisclosures() {
    const rows = await this.db.disclosure.findMany({ orderBy: { publishedAt: 'desc' }, take: 20 })
    return ok(rows)
  }

  @Get('reviews')
  @RequireAction('points.review')
  async reviewQueue(@Query('type') type?: string) {
    const cases = await this.db.reviewCase.findMany({
      where: type ? { type } : undefined,
      orderBy: { createdAt: 'asc' },
      take: 50,
      include: { votes: true },
    })
    const claims = await this.db.pointsClaim.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, take: 50, include: { user: { select: { verifiedRealName: true, studentNo: true } } } })
    const appeals = await this.db.appeal.findMany({ where: { status: 'submitted' }, orderBy: { createdAt: 'asc' }, take: 50, include: { user: { select: { verifiedRealName: true, studentNo: true } } } })
    return ok({ cases, claims, appeals })
  }

  @Post('reviews/:id/votes')
  @RequireAction('points.review')
  async vote(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ verdict: z.enum(['approve', 'reject', 'more_info']), reason: z.string().min(3).max(500) }).parse(body)
    return ok(await this.scoring.voteOnCase(actor, id, parsed.verdict, parsed.reason))
  }

  @Post('claims/:id/decision')
  @RequireAction('claims.review')
  async claimDecision(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ decision: z.enum(['approve', 'reject', 'more_info']), note: z.string().max(500).optional(), amount: z.string().regex(/^-?\d+(\.\d+)?$/).optional() }).parse(body)
    const claim = await this.db.pointsClaim.findUnique({ where: { id } })
    if (!claim) return ok({ decided: false })
    if (claim.userId === actor.userId) return ok({ decided: false, reason: '涉及本人需回避' })
    await this.db.pointsClaim.update({
      where: { id },
      data: { status: parsed.decision === 'approve' ? 'approved' : parsed.decision === 'reject' ? 'rejected' : 'more_info', reviewNote: parsed.note, reviewedBy: actor.principalId, reviewedAt: new Date() },
    })
    if (parsed.decision === 'approve' && parsed.amount) {
      await this.scoring.postLedgerEntry(actor, {
        userId: claim.userId,
        sourceKey: `contribution:${claim.userId}:${claim.id}`,
        category: claim.category === 'award' ? 'award' : 'contribution',
        amount: parsed.amount,
        scoreMonth: claim.scoreMonth,
        detail: { claimId: claim.id, title: claim.title },
        evidenceRef: `claim:${claim.id}`,
      })
    }
    return ok({ decided: true })
  }

  /** 冻结榜（02 方案 6.4）：默认报名截止前一日 22:00；冻结后回填不改变名单 */
  @Post('freezes')
  @RequireAction('competitions.manage')
  async createFreeze(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const parsed = z.object({
      contestKey: z.string().min(2).max(120),
      title: z.string().min(2).max(120),
      freezeAt: z.string().datetime(),
    }).parse(body)
    const rule = await this.db.ruleVersion.findFirst({ where: { status: 'published' }, orderBy: { version: 'desc' } })
    const freezeId = crypto.randomUUID()
    await this.db.$transaction(async (tx) => {
      await tx.rankingFreeze.create({
        data: { id: freezeId, contestKey: parsed.contestKey, title: parsed.title, freezeAt: new Date(parsed.freezeAt), ruleVersionId: rule?.id ?? '', status: 'scheduled' },
      })
    })
    await this.db.job.create({
      data: { id: crypto.randomUUID(), type: 'disclosure.freeze_ranking', payload: { freezeId } as never, dedupeKey: `freeze:${freezeId}`, priority: 3 },
    })
    void actor
    return ok({ freezeId })
  }

  @Get('freezes')
  @RequireAction('competitions.manage')
  async listFreezes() {
    const rows = await this.db.rankingFreeze.findMany({ orderBy: { freezeAt: 'desc' }, take: 30, include: { rows: { orderBy: { position: 'asc' }, take: 5 } } })
    return ok(rows)
  }
}
