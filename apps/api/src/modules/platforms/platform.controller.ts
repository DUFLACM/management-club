import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { SessionGuard, PermissionsGuard, ActionGuard, RequireAction, CurrentUser, ok, CurrentActor } from '../../common/guards.js'
import { PlatformService, bindAccountSchema } from './platform.service.js'
import type { SessionActor } from '../auth/session.service.js'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { newId } from '../../common/utils.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import type { Prisma } from '@acm/db'

@Controller('/api/v1/me')
@UseGuards(SessionGuard, PermissionsGuard)
export class PlatformMeController {
  constructor(
    private readonly platforms: PlatformService,
    private readonly db: PrismaService,
  ) {}

  @Get('platform-accounts')
  async list(@CurrentUser() user: { userId: string }) {
    return ok(await this.platforms.myAccounts(user.userId))
  }

  /** 指定比赛认定目录（附录一 A/B/C 分类；成员端「指定与备案」展示） */
  @Get('designated-contests')
  async designatedContests() {
    const rows = await this.db.designatedContest.findMany({
      where: { status: 'active' },
      orderBy: [{ category: 'asc' }, { groupName: 'asc' }, { name: 'asc' }],
      select: { id: true, category: true, groupName: true, name: true, platform: true, lambdaKey: true, note: true, evidenceRef: true, effectiveFrom: true },
    })
    return ok(rows)
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

const JOB_SELECT = {
  id: true, type: true, status: true, attempts: true, runAfter: true, lastError: true,
  createdAt: true, updatedAt: true, payload: true,
} as const

type JobRow = {
  id: string
  type: string
  status: string
  attempts: number
  runAfter: Date
  lastError: string | null
  createdAt: Date
  updatedAt: Date
  payload: unknown
}

@Controller('/api/v1/admin/platform')
@UseGuards(SessionGuard, PermissionsGuard, ActionGuard)
export class PlatformAdminController {
  constructor(
    private readonly platforms: PlatformService,
    private readonly db: PrismaService,
    private readonly audit: AuditService,
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

  /** 手动触发账号同步：失败任务被忽略、或成员没有主动刷新时由管理员补一次 */
  @Post('accounts/:id/sync')
  @RequireAction('sync.manage')
  async syncAccount(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    const result = await this.platforms.adminRequestSync(id)
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'platform.account_sync',
      resourceType: 'platform_account',
      resourceId: id,
      summary: `管理员触发平台账号同步${result.deduplicated ? '（30 秒内已有排队任务，复用）' : ''}`,
    })
    return ok(result)
  }

  /** 指定目录管理（competitions.manage）：列表 / 新增 / 删除；λ 供结算引擎匹配 */
  @Get('designated-contests')
  @RequireAction('competitions.manage')
  async listDesignated() {
    const rows = await this.db.designatedContest.findMany({
      orderBy: [{ category: 'asc' }, { groupName: 'asc' }, { name: 'asc' }],
    })
    return ok(rows)
  }

  @Post('designated-contests')
  @RequireAction('competitions.manage')
  async createDesignated(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const parsed = z.object({
      category: z.enum(['A', 'B', 'C']),
      groupName: z.string().min(1).max(64),
      name: z.string().min(2).max(160),
      platform: z.enum(['nowcoder', 'codeforces', 'atcoder', 'hydro', 'other']).optional(),
      lambdaKey: z.enum(['A', 'B', 'C']).optional(),
      note: z.string().max(500).optional(),
      evidenceRef: z.string().max(300).optional(),
    }).safeParse(body)
    if (!parsed.success) throw new Error(parsed.error.issues[0].message)
    const id = newId()
    await this.db.designatedContest.create({
      data: { id, ...parsed.data, platform: parsed.data.platform === 'other' ? null : parsed.data.platform ?? null, status: 'active' },
    })
    return ok({ id })
  }

  @Delete('designated-contests/:id')
  @RequireAction('competitions.manage')
  async deleteDesignated(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.designatedContest.deleteMany({ where: { id } })
    return ok({ deleted: true })
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

  /** 同步任务状态（最近成功/失败/排队）；账号同步任务附带对应平台账号与成员，失败时可直接定位 */
  @Get('jobs')
  @RequireAction('sync.manage')
  async jobs(@Query('limit') limit?: string, @Query('status') status?: string) {
    const take = Math.min(Math.max(Number(limit ?? 50) || 50, 1), 200)
    const where: Prisma.JobWhereInput = { type: { startsWith: 'platform.' } }
    if (status === 'failed') where.status = { in: ['dead', 'failed'] }
    else if (status === 'active') where.status = { in: ['queued', 'running'] }
    else if (status && ['dead', 'failed', 'queued', 'running', 'done', 'cancelled'].includes(status)) where.status = status
    const rows = await this.db.job.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take,
      select: JOB_SELECT,
    })
    return ok(await this.attachAccounts(rows))
  }

  /**
   * 失败任务队列：不再受“最近 N 条”限制，确保总览里看到的同步失败一定能在这里定位。
   * 返回全部 dead/failed 平台任务（最多 200 条）与真实总数。
   */
  @Get('jobs/failures')
  @RequireAction('sync.manage')
  async jobFailures() {
    const where: Prisma.JobWhereInput = { type: { startsWith: 'platform.' }, status: { in: ['dead', 'failed'] } }
    const [rows, total] = await Promise.all([
      this.db.job.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200, select: JOB_SELECT }),
      this.db.job.count({ where }),
    ])
    return ok({ items: await this.attachAccounts(rows), total })
  }

  /** 重试失败任务（dead/failed → queued）；也允许把退避等待中的任务立即重试 */
  @Post('jobs/:id/retry')
  @RequireAction('sync.manage')
  async retry(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    const job = await this.db.job.findUnique({ where: { id } })
    if (!job) return ok({ retried: false })
    const retryable = job.status === 'dead' || job.status === 'failed' || (job.status === 'queued' && job.attempts > 0)
    if (!retryable) return ok({ retried: false, reason: '仅失败或等待重试的任务可重试' })
    const updated = await this.db.job.updateMany({
      where: { id, status: job.status, ...(job.status === 'queued' ? { attempts: { gt: 0 } } : {}) },
      data: {
        status: 'queued',
        attempts: 0,
        runAfter: new Date(),
        lastError: null,
        leaseUntil: null,
        lockedBy: null,
        leaseToken: null,
      },
    })
    if (updated.count === 0) return ok({ retried: false, reason: '任务状态已变化，请刷新后重试' })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'platform.job_retry',
      resourceType: 'job',
      resourceId: id,
      summary: `重试平台同步任务 ${job.type}（原状态 ${job.status}，尝试 ${job.attempts} 次）`,
    })
    return ok({ retried: true })
  }

  /** 批量重试失败任务：最多 50 条，每 30 秒错峰执行，避免同时打满第三方平台限流 */
  @Post('jobs/retry-failures')
  @RequireAction('sync.manage')
  async retryFailures(@CurrentActor() actor: SessionActor) {
    const rows = await this.db.job.findMany({
      where: { type: { startsWith: 'platform.' }, status: { in: ['dead', 'failed'] } },
      orderBy: { updatedAt: 'asc' },
      take: 50,
      select: { id: true, type: true },
    })
    const start = Date.now()
    let retried = 0
    for (const [index, row] of rows.entries()) {
      try {
        const updated = await this.db.job.updateMany({
          where: { id: row.id, status: { in: ['dead', 'failed'] } },
          data: {
            status: 'queued',
            attempts: 0,
            runAfter: new Date(start + index * 30_000),
            lastError: null,
            leaseUntil: null,
            lockedBy: null,
            leaseToken: null,
          },
        })
        if (updated.count > 0) retried++
      } catch {
        // 同 dedupeKey 的另一个任务已排队时跳过该条，其余继续
      }
    }
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'platform.job_retry_all',
      resourceType: 'job',
      resourceId: 'platform-sync-failures',
      summary: `批量重试平台同步失败任务 ${retried}/${rows.length} 条（每 30 秒错峰）`,
    })
    return ok({ retried, total: rows.length })
  }

  /** 批量忽略全部失败任务：不再进入自动重试，错误仍保留在 jobs/审计中供追溯 */
  @Post('jobs/cancel-failures')
  @RequireAction('sync.manage')
  async cancelFailures(@CurrentActor() actor: SessionActor) {
    const where: Prisma.JobWhereInput = { type: { startsWith: 'platform.' }, status: { in: ['dead', 'failed'] } }
    const total = await this.db.job.count({ where })
    const updated = await this.db.job.updateMany({
      where,
      data: { status: 'cancelled', leaseUntil: null, lockedBy: null, leaseToken: null },
    })
    if (updated.count > 0) {
      await this.audit.log({
        actorPrincipalId: actor.principalId,
        action: 'platform.job_cancel_all',
        resourceType: 'job',
        resourceId: 'platform-sync-failures',
        summary: `批量忽略平台同步失败任务 ${updated.count}/${total} 条`,
      })
    }
    return ok({ cancelled: updated.count, total })
  }

  /** 忽略失败任务：标记 cancelled，不再进入自动重试；保留原错误供审计追溯 */
  @Post('jobs/:id/cancel')
  @RequireAction('sync.manage')
  async cancelJob(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    const job = await this.db.job.findUnique({ where: { id } })
    if (!job) return ok({ cancelled: false })
    const cancellable = job.status === 'dead' || job.status === 'failed' || (job.status === 'queued' && job.attempts > 0)
    if (!cancellable) return ok({ cancelled: false, reason: '仅失败或等待重试的任务可忽略' })
    const updated = await this.db.job.updateMany({
      where: { id, status: job.status, ...(job.status === 'queued' ? { attempts: { gt: 0 } } : {}) },
      data: { status: 'cancelled', leaseUntil: null, lockedBy: null, leaseToken: null },
    })
    if (updated.count === 0) return ok({ cancelled: false, reason: '任务状态已变化，请刷新后重试' })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'platform.job_cancel',
      resourceType: 'job',
      resourceId: id,
      summary: `忽略平台同步失败任务 ${job.type}（尝试 ${job.attempts} 次；${job.lastError ?? '无错误信息'}）`,
    })
    return ok({ cancelled: true })
  }

  /** 给任务行补上平台账号与成员，失败时管理员能直接定位到人 */
  private async attachAccounts(rows: JobRow[]) {
    const accountIdOf = (payload: unknown): string | null => {
      const value = (payload as { accountId?: unknown } | null)?.accountId
      return typeof value === 'string' && z.string().uuid().safeParse(value).success ? value : null
    }
    const accountIds = [...new Set(rows.map((row) => accountIdOf(row.payload)).filter((id): id is string => id !== null))]
    const accounts = accountIds.length === 0 ? [] : await this.db.platformAccount.findMany({
      where: { id: { in: accountIds } },
      select: {
        id: true, platform: true, externalId: true, displayHandle: true, status: true,
        user: { select: { id: true, verifiedRealName: true, studentNo: true } },
      },
    })
    const accountById = new Map(accounts.map((account) => [account.id, account]))
    return rows.map(({ payload, ...row }) => {
      const accountId = accountIdOf(payload)
      return { ...row, accountId, account: accountId ? accountById.get(accountId) ?? null : null }
    })
  }
}
