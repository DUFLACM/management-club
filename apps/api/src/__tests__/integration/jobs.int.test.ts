import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { ensureTestDatabase, TEST_URL } from './setup.js'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'
import { randomUUID } from 'node:crypto'

/**
 * PostgreSQL 任务队列（真实数据库）：
 * - dedupe_key 对未完成任务唯一
 * - 领取后他人不可重复领取（SKIP LOCKED + status）
 * - 完成必须匹配 lease_token（过期 Worker 不能覆盖新结果）
 * - 失败退避重排；超次 dead
 * - 租约过期回收
 */

process.env.DATABASE_URL = TEST_URL

let db: PrismaService
let jobs: JobsService

beforeAll(async () => {
  const url = ensureTestDatabase()
  db = new PrismaService(url)
  jobs = new JobsService(db)
})

afterAll(async () => {
  await db.$disconnect()
})

describe('任务队列', () => {
  it('dedupe_key 去重：未完成同键任务只入队一次', async () => {
    const key = `dedupe-test-${randomUUID().slice(0, 8)}`
    const a = await jobs.enqueue({ type: 'platform.sync_account', payload: { x: 1 }, dedupeKey: key })
    const b = await jobs.enqueue({ type: 'platform.sync_account', payload: { x: 2 }, dedupeKey: key })
    expect(a.deduplicated).toBe(false)
    expect(b.deduplicated).toBe(true)
  })

  it('领取后其他 Worker 不可领取；完成匹配 lease_token', async () => {
    const { id } = await jobs.enqueue({ type: 'platform.sync_account', payload: {}, priority: 9 })
    const batch1 = await jobs.claimBatch('worker-a', 5)
    expect(batch1.some((j) => j.id === id)).toBe(true)
    const batch2 = await jobs.claimBatch('worker-b', 5)
    expect(batch2.some((j) => j.id === id)).toBe(false) // 已被 A 持有
    const lease = await db.job.findUnique({ where: { id }, select: { leaseToken: true } })
    // 错误 token 完成无效
    const wrong = await jobs.complete(id, randomUUID(), {})
    expect(wrong).toBe(false)
    // 正确 token 完成
    const ok = await jobs.complete(id, lease!.leaseToken!, { done: true })
    expect(ok).toBe(true)
    const job = await db.job.findUnique({ where: { id } })
    expect(job!.status).toBe('done')
  })

  it('失败退避：run_after 推后且回到 queued；超 maxAttempts 进 dead', async () => {
    let { id } = await jobs.enqueue({ type: 'platform.sync_account', payload: {}, maxAttempts: 2 })
    await jobs.claimBatch('worker-c', 10)
    let job = await db.job.findUnique({ where: { id } })
    const failed = await jobs.fail(id, job!.leaseToken!, '第一次失败')
    expect(failed).toBe(true)
    job = await db.job.findUnique({ where: { id } })
    expect(job!.status).toBe('queued')
    expect(job!.runAfter.getTime()).toBeGreaterThan(Date.now())
    // 第二次：attempts 达到 max → dead
    await db.job.update({ where: { id }, data: { runAfter: new Date(Date.now() - 1000) } })
    await jobs.claimBatch('worker-c', 10)
    job = await db.job.findUnique({ where: { id } })
    await jobs.fail(id, job!.leaseToken!, '第二次失败')
    job = await db.job.findUnique({ where: { id } })
    expect(job!.status).toBe('dead')
  })

  it('租约过期回收（崩溃 Worker 恢复）', async () => {
    const { id } = await jobs.enqueue({ type: 'platform.sync_account', payload: {} })
    await jobs.claimBatch('worker-crashed', 10)
    // 模拟租约过期
    await db.job.update({ where: { id }, data: { leaseUntil: new Date(Date.now() - 1000) } })
    const reclaimed = await jobs.reclaimExpired()
    expect(reclaimed).toBeGreaterThanOrEqual(1)
    const job = await db.job.findUnique({ where: { id } })
    expect(job!.status).toBe('queued')
  })
})
