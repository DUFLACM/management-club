import { Body, Controller, Inject, Delete, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { SessionGuard, PermissionsGuard, ActionGuard, RequireAction, CurrentUser, CurrentActor, ok } from '../../common/guards.js'
import { ScoringService, ScoringError, ledgerEntrySchema } from './scoring.service.js'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { ActivityService } from '../activities/activity.service.js'
import { ContestStandingsService } from '../activities/contest-standings.service.js'
import type { SessionActor } from '../auth/session.service.js'

@Controller('/api/v1/me')
@UseGuards(SessionGuard, PermissionsGuard)
export class ScoringMeController {
  constructor(
    private readonly scoring: ScoringService,
    private readonly db: PrismaService,
  ) {}

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
    const validKind = kind === 'disclosure' ? kind : 'current'
    return ok(await this.scoring.leaderboard(validKind, ref, viewerId))
  }

  /** 成员端公示批次卡片列表（进行中优先，不再依赖粘贴引用） */
  @Get('disclosures')
  async myDisclosures() {
    const rows = await this.db.disclosure.findMany({
      where: { status: 'published' },
      orderBy: { publishedAt: 'desc' },
      take: 12,
      select: { id: true, monthKey: true, status: true, startsAt: true, endsAt: true },
    })
    return ok(rows)
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
      evidenceAssetIds: z.array(z.string().uuid()).max(5).optional(),
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
    @Inject(ActivityService) private readonly activities: ActivityService,
    @Inject(ContestStandingsService) private readonly standings: ContestStandingsService,
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

  /** 批量手动加分（粘贴/导入：学号+分数+备注；可关联活动，成员端活动详情展示积分） */
  @Post('ledger-entries/batch')
  @RequireAction('points.review')
  async postEntriesBatch(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const parsed = z.object({
      rows: z.array(z.object({
        studentNo: z.string().min(3).max(64),
        amount: z.string().regex(/^-?\d+(\.\d+)?$/, '分数为十进制（可负）'),
        note: z.string().max(300).optional(),
      })).min(1).max(200),
      category: z.enum(['contest', 'remote_contest', 'activity', 'contribution', 'service', 'award', 'initial', 'penalty']).default('activity'),
      activityId: z.string().uuid().optional(),
      scoreMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    }).safeParse(body)
    if (!parsed.success) throw new ScoringError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.scoring.batchPostEntries(actor, parsed.data))
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

  /** 提前结束公示（保留批次与快照，状态转 closed） */
  @Post('disclosures/:id/close')
  @RequireAction('disclosure.publish')
  async closeDisclosure(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    await this.scoring.closeDisclosure(actor, id)
    return ok({ closed: true })
  }

  /** 删除公示批次（连同快照行；审计保留） */
  @Delete('disclosures/:id')
  @RequireAction('disclosure.publish')
  async deleteDisclosure(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    await this.scoring.deleteDisclosure(actor, id)
    return ok({ deleted: true })
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
    const claims = await this.db.pointsClaim.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: 50,
      include: {
        user: { select: { verifiedRealName: true, studentNo: true } },
        assets: { orderBy: { sortOrder: 'asc' }, select: { assetId: true } },
      },
    })
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

  /** 平台赛积分结算（引擎：有效提交自动核验 + λ 目录匹配；结束后 5 分钟窗口） */
  @Post('activities/:id/settle-scores')
  @RequireAction('activity.manage')
  async settleScores(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.scoring.settleContestScores(actor, id))
  }

  /** 管理端比赛榜单：社团排名 + 平台位次 + 逐题通过情况 */
  @Get('activities/:id/standings')
  @RequireAction('activity.manage')
  async adminStandings(@Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.activities.activityStandings(null as never, id, this.standings))
  }

}
