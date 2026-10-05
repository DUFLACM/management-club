import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { SessionGuard, PermissionsGuard, ActionGuard, RequireAction, CurrentUser, ok, CurrentActor } from '../../common/guards.js'
import { PlatformService, bindAccountSchema } from './platform.service.js'
import type { SessionActor } from '../auth/session.service.js'
import { PrismaService } from '../../infrastructure/database/database.module.js'

@Controller('/api/v1/me')
@UseGuards(SessionGuard, PermissionsGuard)
export class PlatformMeController {
  constructor(private readonly platforms: PlatformService) {}

  @Get('platform-accounts')
  async list(@CurrentUser() user: { userId: string }) {
    return ok(await this.platforms.myAccounts(user.userId))
  }

  @Post('platform-accounts')
  async bind(@CurrentUser() user: { userId: string }, @Body() body: unknown) {
    const input = bindAccountSchema.parse(body)
    return ok(await this.platforms.bindAccount(user.userId, input))
  }

  @Post('platform-syncs')
  async sync(@CurrentUser() user: { userId: string }, @Body() body: unknown) {
    const { accountId } = z.object({ accountId: z.string().uuid() }).parse(body)
    const result = await this.platforms.requestSync(user.userId, accountId)
    return { ...ok(result), status: 202 } as never
  }
}

@Controller('/api/v1/admin/platform')
@UseGuards(SessionGuard, PermissionsGuard, ActionGuard)
export class PlatformAdminController {
  constructor(
    private readonly platforms: PlatformService,
    private readonly db: PrismaService,
  ) {}

  @Get('accounts')
  @RequireAction('members.read')
  async accounts(@Query('status') status?: string) {
    return ok(await this.platforms.adminList(status))
  }

  @Post('accounts/:id/review')
  @RequireAction('claims.review')
  async review(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ decision: z.enum(['verify', 'reject', 'revoke']), note: z.string().max(500).optional() }).parse(body)
    await this.platforms.reviewBinding(actor.principalId, id, parsed.decision, parsed.note)
    return ok({ reviewed: true })
  }

  /** 平台比赛目录（管理导入筛选） */
  @Get('contests')
  @RequireAction('activity.manage')
  async contestDirectory(@Query('platform') platform?: string, @Query('q') q?: string) {
    if (!platform || !['nowcoder', 'codeforces', 'atcoder', 'hydro'].includes(platform)) {
      return ok([])
    }
    return ok(await this.platforms.adminContestDirectory(platform, q))
  }

  /** 同步任务状态（最近成功/失败/排队） */
  @Get('jobs')
  @RequireAction('sync.manage')
  async jobs(@Query('limit') limit?: string) {
    const rows = await this.db.job.findMany({
      where: { type: { startsWith: 'platform.' } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(limit ?? 30), 100),
      select: { id: true, type: true, status: true, attempts: true, runAfter: true, lastError: true, createdAt: true },
    })
    return ok(rows)
  }

  /** 重试失败任务（dead → queued） */
  @Post('jobs/:id/retry')
  @RequireAction('sync.manage')
  async retry(@Param('id', ParseUUIDPipe) id: string) {
    const job = await this.db.job.findUnique({ where: { id } })
    if (!job) return ok({ retried: false })
    if (job.status !== 'dead' && job.status !== 'failed') return ok({ retried: false, reason: '仅失败/死信任务可重试' })
    await this.db.job.update({ where: { id }, data: { status: 'queued', attempts: 0, runAfter: new Date() } })
    return ok({ retried: true })
  }
}
