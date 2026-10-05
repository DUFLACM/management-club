import { Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../database/database.module.js'
import { newId } from '../../common/utils.js'

/**
 * PostgreSQL jobs 队列（02 方案 7）：lease + outbox + dedupe_key。
 * Worker 领取使用 FOR UPDATE SKIP LOCKED；完成更新匹配 lease_token 防过期 Worker 覆盖。
 * 副作用由业务唯一键防重，系统提供至少一次处理。
 */

export type JobType =
  | 'platform.sync_account'
  | 'platform.fetch_contest_meta'
  | 'platform.sync_contest_standings'
  | 'hydro.pull_contest'
  | 'hydro.repair'
  | 'scoring.recalc_user'
  | 'scoring.monthly_batch'
  | 'disclosure.freeze_ranking'
  | 'disclosure.publish_rows'
  | 'activity.import_contest'
  | 'activity.settle_attendance'
  | 'media.process_avatar'
  | 'badge.evaluate_rules'

export interface EnqueueJobOptions {
  type: JobType
  payload: Record<string, unknown>
  dedupeKey?: string
  priority?: number
  runAfter?: Date
  maxAttempts?: number
}

@Injectable()
export class JobsService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  async enqueue(opts: EnqueueJobOptions): Promise<{ id: string; deduplicated: boolean }> {
    // dedupe_key 对未完成同类任务唯一（部分唯一索引）；重复入队直接返回既有任务
    if (opts.dedupeKey) {
      const existing = await this.db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM jobs WHERE dedupe_key = ${opts.dedupeKey} AND status IN ('queued','running') LIMIT 1`
      if (existing.length > 0) return { id: existing[0].id, deduplicated: true }
    }
    const id = newId()
    try {
      await this.db.job.create({
        data: {
          id,
          type: opts.type,
          payload: opts.payload as never,
          dedupeKey: opts.dedupeKey,
          priority: opts.priority ?? 5,
          runAfter: opts.runAfter ?? new Date(),
          maxAttempts: opts.maxAttempts ?? 8,
        },
      })
      return { id, deduplicated: false }
    } catch {
      // 并发下的唯一冲突：读回既有任务
      if (opts.dedupeKey) {
        const existing = await this.db.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM jobs WHERE dedupe_key = ${opts.dedupeKey} AND status IN ('queued','running') LIMIT 1`
        if (existing.length > 0) return { id: existing[0].id, deduplicated: true }
      }
      throw new Error('enqueue failed')
    }
  }

  /** 领取任务（Worker 主循环；lockedBy 唯一标识 Worker 实例） */
  async claimBatch(workerId: string, limit = 5): Promise<Array<{ id: string; type: string; payload: unknown; attempts: number }>> {
    const rows = await this.db.$queryRaw<Array<{ id: string; type: string; payload: unknown; attempts: number }>>`
      WITH picked AS (
        SELECT id FROM jobs
        WHERE status = 'queued' AND run_after <= now()
        ORDER BY priority DESC, run_after, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE jobs AS j
      SET status = 'running', locked_by = ${workerId},
          lease_token = gen_random_uuid(), lease_until = now() + interval '2 minutes',
          attempts = j.attempts + 1
      FROM picked WHERE j.id = picked.id
      RETURNING j.id, j.type, j.payload, j.attempts`
    return rows
  }

  /** 心跳续约 */
  async heartbeat(workerId: string, leaseToken: string): Promise<void> {
    await this.db.$executeRaw`
      UPDATE jobs SET lease_until = now() + interval '2 minutes'
      WHERE locked_by = ${workerId} AND lease_token = ${leaseToken}::uuid AND status = 'running'`
  }

  /** 完成任务：必须匹配本次 lease_token，防止过期 Worker 覆盖新结果 */
  async complete(jobId: string, leaseToken: string, result?: Record<string, unknown>): Promise<boolean> {
    const rows = await this.db.$executeRaw`
      UPDATE jobs SET status = 'done', result = ${JSON.stringify(result ?? {})}::jsonb, lease_until = NULL, locked_by = NULL, lease_token = NULL
      WHERE id = ${jobId}::uuid AND lease_token = ${leaseToken}::uuid AND status = 'running'`
    return rows > 0
  }

  /** 失败：指数退避 + 抖动；超次进 dead-letter */
  async fail(jobId: string, leaseToken: string, error: string, baseDelaySec = 10): Promise<boolean> {
    const job = await this.db.job.findUnique({ where: { id: jobId }, select: { attempts: true, maxAttempts: true } })
    if (!job) return false
    if (job.attempts >= job.maxAttempts) {
      const rows = await this.db.$executeRaw`
        UPDATE jobs SET status = 'dead', last_error = ${error}, lease_until = NULL, locked_by = NULL, lease_token = NULL
        WHERE id = ${jobId}::uuid AND lease_token = ${leaseToken}::uuid AND status = 'running'`
      return rows > 0
    }
    const jitter = Math.random() * 0.4 + 0.8
    const delaySec = Math.round(baseDelaySec * 2 ** Math.min(job.attempts, 6) * jitter)
    const rows = await this.db.$executeRaw`
      UPDATE jobs SET status = 'queued', last_error = ${error}, run_after = now() + (${delaySec} || ' seconds')::interval,
        lease_until = NULL, locked_by = NULL, lease_token = NULL
      WHERE id = ${jobId}::uuid AND lease_token = ${leaseToken}::uuid AND status = 'running'`
    return rows > 0
  }

  /** 回收过期租约（崩溃 Worker 恢复） */
  async reclaimExpired(): Promise<number> {
    const rows = await this.db.$executeRaw`
      UPDATE jobs SET status = 'queued', locked_by = NULL, lease_token = NULL, lease_until = NULL,
        last_error = COALESCE(last_error, '') || '; lease expired'
      WHERE status = 'running' AND lease_until < now()`
    return rows
  }
}
