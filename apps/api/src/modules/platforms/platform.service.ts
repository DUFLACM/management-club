import { DomainError } from '../../common/domain-error.js'
import { Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'
import { newId } from '../../common/utils.js'
import { z } from 'zod'

/**
 * 平台账号绑定与同步（05 方案 5-7）：
 * - 绑定 unverified → pending_review → verified → revoked；活跃绑定对 (platform, external_id) 唯一（部分索引）。
 * - 账号存在 ≠ 本人持有；首期默认管理员审核持有证明，不承诺自动 challenge。
 * - 同步只创建后台任务（202），不阻塞界面；rating 仅展示。
 */

export class PlatformError extends DomainError {
  constructor(message: string, readonly code: string) {
    super(message, code)
  }
}

export const bindAccountSchema = z.object({
  platform: z.enum(['nowcoder', 'codeforces', 'atcoder']),
  externalId: z.string().min(2).max(64).regex(/^[A-Za-z0-9_.-]+$/, '仅接受平台 UID/handle 字符'),
  proofNote: z.string().max(500).optional(),
})

const CANONICAL: Record<string, (v: string) => string> = {
  nowcoder: (v) => v.trim(), // UID 数字，保留原样
  codeforces: (v) => v.trim(), // CF handle 大小写敏感，不 lowercase
  atcoder: (v) => v.trim(),
}

@Injectable()
export class PlatformService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  /** 绑定申请：账号唯一性由部分唯一索引约束（同账号只能绑一个成员） */
  async bindAccount(userId: string, input: z.infer<typeof bindAccountSchema>): Promise<{ accountId: string }> {
    const canonical = CANONICAL[input.platform](input.externalId)
    // 每名成员每平台一个活跃绑定
    const existingOwn = await this.db.platformAccount.findFirst({
      where: { userId, platform: input.platform, status: { not: 'revoked' } },
    })
    if (existingOwn) {
      if (existingOwn.externalId === canonical) return { accountId: existingOwn.id }
      throw new PlatformError('每平台只保留一个活跃绑定；换绑请先在管理端解绑旧账号', 'ALREADY_BOUND_SELF')
    }
    const id = newId()
    try {
      await this.db.platformAccount.create({
        data: {
          id,
          userId,
          platform: input.platform,
          externalId: canonical,
          displayHandle: input.externalId,
          status: 'pending_review',
          proofSummary: input.proofNote,
        },
      })
    } catch {
      throw new PlatformError('该平台账号已绑定其他成员（活跃绑定唯一）', 'ALREADY_BOUND_OTHER')
    }
    return { accountId: id }
  }

  /** 持有证明审核：管理员人工审核；仅抓到公开资料不自动 verified */
  async reviewBinding(actorPrincipalId: string, accountId: string, decision: 'verify' | 'reject' | 'revoke', note?: string): Promise<void> {
    const account = await this.db.platformAccount.findUnique({ where: { id: accountId } })
    if (!account) throw new PlatformError('绑定不存在', 'NOT_FOUND')
    const status = decision === 'verify' ? 'verified' : decision === 'reject' ? 'revoked' : 'revoked'
    await this.db.platformAccount.update({
      where: { id: accountId },
      data: {
        status,
        verifiedBy: decision === 'verify' ? actorPrincipalId : account.verifiedBy,
        verifiedAt: decision === 'verify' ? new Date() : account.verifiedAt,
        proofSummary: note ?? account.proofSummary,
        ...(decision !== 'verify' ? { validUntil: new Date() } : {}),
      },
    })
    if (decision === 'verify') {
      // 验证完成 → 排队一次同步（不阻塞）
      await this.jobs.enqueue({
        type: 'platform.sync_account',
        payload: { accountId },
        dedupeKey: `sync:${accountId}:initial`,
      })
    }
  }

  /** 成员触发刷新：入队任务并返回 202 */
  async requestSync(userId: string, accountId: string): Promise<{ jobId: string }> {
    const account = await this.db.platformAccount.findUnique({ where: { id: accountId } })
    if (!account || account.userId !== userId) throw new PlatformError('绑定不存在', 'NOT_FOUND')
    if (account.status !== 'verified') throw new PlatformError('账号持有核验通过后才能同步', 'NOT_VERIFIED')
    // 冷却：60 秒内重复请求去重
    const enqueued = await this.jobs.enqueue({
      type: 'platform.sync_account',
      payload: { accountId },
      dedupeKey: `sync:${accountId}:${Math.floor(Date.now() / 60_000)}`,
    })
    return { jobId: enqueued.id }
  }

  /** 我的平台账号（含同步状态） */
  async myAccounts(userId: string) {
    return this.db.platformAccount.findMany({
      where: { userId, status: { not: 'revoked' } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, platform: true, externalId: true, displayHandle: true, status: true,
        verifiedAt: true, lastSyncAt: true, lastSyncStatus: true, lastSyncError: true,
      },
    })
  }

  /** 管理端：绑定列表（按状态筛选） */
  async adminList(status?: string) {
    return this.db.platformAccount.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { user: { select: { id: true, verifiedRealName: true, studentNo: true } } },
    })
  }

  /** 平台比赛目录（CF 官方 contest.list 已缓存到 platform_contests；牛客/AtCoder 走 ID 导入或尽力目录） */
  async adminContestDirectory(platform: string, q?: string) {
    return this.db.platformContest.findMany({
      where: {
        platform,
        ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { externalContestId: q }] } : {}),
      },
      orderBy: { startTime: 'desc' },
      take: 50,
    })
  }
}
