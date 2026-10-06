import { randomUUID } from 'node:crypto'
import { createPrismaClient, loadRuntimeEnvironment, type PrismaClient } from '@acm/db'
import { getJobHandler, handledJobTypes } from './handlers.js'

/**
 * 独立 NestJS application-context Worker（本进程为纯 Node 主循环，等价 application context）：
 * - PostgreSQL jobs + lease：FOR UPDATE SKIP LOCKED 领取、心跳续约、lease_token 匹配完成。
 * - 与 API 进程分开运行；第三方平台延迟不占用签到请求进程。
 * - 平台同步/图片处理/导出/重算与现场签到隔离（不同任务优先级）。
 */

const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`
const POLL_INTERVAL_MS = 1500
const HEARTBEAT_INTERVAL_MS = 45_000

async function main(): Promise<void> {
  loadRuntimeEnvironment()
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the Worker')
  const db: PrismaClient = createPrismaClient(process.env.DATABASE_URL!)
  // eslint-disable-next-line no-console
  console.log(`[${WORKER_ID}] Worker 启动；已注册处理器：${handledJobTypes.join(', ')}`)

  const running = new Map<string, { jobId: string; leaseToken: string }>()

  const heartbeat = setInterval(async () => {
    for (const [key, job] of [...running.entries()]) {
      try {
        await db.$executeRaw`
          UPDATE jobs SET lease_until = now() + interval '2 minutes'
          WHERE id = ${job.jobId}::uuid AND lease_token = ${job.leaseToken}::uuid AND status = 'running'`
        void key
      } catch {
        // 心跳失败由 lease 回收兜底
      }
    }
  }, HEARTBEAT_INTERVAL_MS)

  // 定期回收过期租约（崩溃 Worker 恢复）与过期匿名绑定清理
  const reclaimer = setInterval(async () => {
    try {
      await db.$executeRaw`
        UPDATE jobs SET status = 'queued', locked_by = NULL, lease_token = NULL, lease_until = NULL,
          last_error = COALESCE(last_error, '') || '; lease expired'
        WHERE status = 'running' AND lease_until < now()`
      await db.anonymousBinding.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 3600_000) } } })
      await db.hydroNonce.deleteMany({ where: { expiresAt: { lt: new Date() } } })
    } catch {
      // 忽略
    }
  }, 30_000)

  // 每日平台账号自动刷新（24h 一次；04:37 Asia/Shanghai 后触发，dedupeKey 保证全天只排一次）
  const ensureDailyRefresh = async (): Promise<void> => {
    try {
      const shanghai = new Date(Date.now() + 8 * 3600_000)
      const dateKey = shanghai.toISOString().slice(0, 10)
      const dedupeKey = `platform-refresh-all:${dateKey}`
      const existing = await db.job.findFirst({ where: { dedupeKey } })
      if (existing) return
      const minuteOfDay = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes()
      if (minuteOfDay < 4 * 60 + 37) return
      await db.job.create({ data: { id: randomUUID(), type: 'platform.refresh_all', payload: {}, dedupeKey, priority: 8 } })
      // eslint-disable-next-line no-console
      console.log(`[${WORKER_ID}] 已排入每日平台账号刷新（${dateKey}）`)
    } catch {
      // 调度失败不影响主循环；下个检查窗口重试
    }
  }
  void ensureDailyRefresh()
  const dailyRefresh = setInterval(() => void ensureDailyRefresh(), 10 * 60_000)

  let shutdown = false
  process.on('SIGINT', () => {
    shutdown = true
  })
  process.on('SIGTERM', () => {
    shutdown = true
  })

  while (!shutdown) {
    let batch: Array<{ id: string; type: string; payload: unknown; attempts: number }> = []
    try {
      batch = await db.$queryRaw<Array<{ id: string; type: string; payload: unknown; attempts: number }>>`
        WITH picked AS (
          SELECT id FROM jobs
          WHERE status = 'queued' AND run_after <= now()
          ORDER BY priority DESC, run_after, id
          FOR UPDATE SKIP LOCKED
          LIMIT 3
        )
        UPDATE jobs AS j
        SET status = 'running', locked_by = ${WORKER_ID},
            lease_token = gen_random_uuid(), lease_until = now() + interval '2 minutes',
            attempts = j.attempts + 1
        FROM picked WHERE j.id = picked.id
        RETURNING j.id, j.type, j.payload, j.attempts`
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[${WORKER_ID}] 领取任务失败:`, (e as Error).message)
      await sleep(POLL_INTERVAL_MS * 2)
      continue
    }

    if (batch.length === 0) {
      await sleep(POLL_INTERVAL_MS)
      continue
    }

    await Promise.all(
      batch.map(async (job) => {
        const lease = await db.$queryRaw<Array<{ lease_token: string }>>`
          SELECT lease_token FROM jobs WHERE id = ${job.id}::uuid AND locked_by = ${WORKER_ID} AND status = 'running' LIMIT 1`
        if (lease.length === 0) return
        const leaseToken = lease[0].lease_token
        running.set(job.id, { jobId: job.id, leaseToken })
        const handler = getJobHandler(job.type)
        try {
          if (!handler) {
            await failJob(db, job.id, leaseToken, `无处理器: ${job.type}`)
            return
          }
          const result = await handler({ db, workerId: WORKER_ID }, (job.payload ?? {}) as Record<string, unknown>)
          await db.$executeRaw`
            UPDATE jobs SET status = 'done', result = ${JSON.stringify(result ?? {})}::jsonb,
              lease_until = NULL, locked_by = NULL, lease_token = NULL, last_error = NULL
            WHERE id = ${job.id}::uuid AND lease_token = ${leaseToken}::uuid AND status = 'running'`
        } catch (e) {
          await failJob(db, job.id, leaseToken, `${(e as Error).message}`.slice(0, 2000))
        } finally {
          running.delete(job.id)
        }
      }),
    )
  }

  clearInterval(heartbeat)
  clearInterval(reclaimer)
  clearInterval(dailyRefresh)
  await db.$disconnect()
  // eslint-disable-next-line no-console
  console.log(`[${WORKER_ID}] Worker 已停止`)
}

async function failJob(db: PrismaClient, jobId: string, leaseToken: string, error: string): Promise<void> {
  const job = await db.job.findUnique({ where: { id: jobId }, select: { attempts: true, maxAttempts: true } })
  if (!job) return
  if (job.attempts >= job.maxAttempts) {
    await db.$executeRaw`
      UPDATE jobs SET status = 'dead', last_error = ${error}, lease_until = NULL, locked_by = NULL, lease_token = NULL
      WHERE id = ${jobId}::uuid AND lease_token = ${leaseToken}::uuid AND status = 'running'`
    return
  }
  const jitter = Math.random() * 0.4 + 0.8
  const delaySec = Math.round(10 * 2 ** Math.min(job.attempts, 6) * jitter)
  await db.$executeRaw`
    UPDATE jobs SET status = 'queued', last_error = ${error}, run_after = now() + (${delaySec} || ' seconds')::interval,
      lease_until = NULL, locked_by = NULL, lease_token = NULL
    WHERE id = ${jobId}::uuid AND lease_token = ${leaseToken}::uuid AND status = 'running'`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

void main()
