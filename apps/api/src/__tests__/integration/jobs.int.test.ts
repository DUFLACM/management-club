import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { ensureTestDatabase, TEST_URL } from './setup.js'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'
import { randomUUID } from 'node:crypto'
import { PlatformAdminController } from '../../modules/platforms/platform.controller.js'
import { PlatformService } from '../../modules/platforms/platform.service.js'
import { createTestUser, makeActor } from './helpers.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'

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

  it('管理端同步任务列表：失败的账号同步任务附带对应平台账号与成员', async () => {
    const owner = await createTestUser(db, { studentNo: '20269901', name: '同步失败者' })
    const accountId = randomUUID()
    await db.platformAccount.create({ data: { id: accountId, platform: 'nowcoder', externalId: '785693755', displayHandle: 'nc-owner', userId: owner.userId, status: 'verified' } })
    const failed = await jobs.enqueue({ type: 'platform.sync_account', payload: { accountId } })
    await db.job.update({ where: { id: failed.id }, data: { status: 'dead', lastError: 'nowcoder 403' } })
    const orphan = await jobs.enqueue({ type: 'platform.sync_account', payload: { accountId: randomUUID() } })
    const refreshAll = await db.job.create({ data: { id: randomUUID(), type: 'platform.refresh_all', payload: {} } })

    const { data } = await new PlatformAdminController(null as never, db, new AuditService(db)).jobs('100')
    const byId = new Map(data.map((row) => [row.id, row]))
    expect(byId.get(failed.id)).toMatchObject({
      status: 'dead', lastError: 'nowcoder 403', accountId,
      account: { platform: 'nowcoder', externalId: '785693755', displayHandle: 'nc-owner', user: { verifiedRealName: '同步失败者', studentNo: '20269901' } },
    })
    // 账号已删除：保留 accountId 供定位，account 为 null
    expect(byId.get(orphan.id)).toMatchObject({ account: null })
    expect(byId.get(orphan.id)?.accountId).toBeTruthy()
    // 全量刷新任务没有目标账号
    expect(byId.get(refreshAll.id)).toMatchObject({ accountId: null, account: null })
    expect(byId.get(failed.id)).not.toHaveProperty('payload')
  })

  it('失败队列不受最近 N 条限制；可单个忽略、批量重试', async () => {
    const owner = await createTestUser(db, { studentNo: '20269902', name: '失败队列成员' })
    const accountId = randomUUID()
    await db.platformAccount.create({ data: { id: accountId, platform: 'codeforces', externalId: 'failure-queue', userId: owner.userId, status: 'verified' } })
    const failed = await jobs.enqueue({ type: 'platform.sync_account', payload: { accountId } })
    await db.job.update({ where: { id: failed.id }, data: { status: 'dead', lastError: 'codeforces 429 rate limit' } })
    // 造出足够多的更新任务，让默认“最近 50 条”不再包含上面的失败任务
    for (let index = 0; index < 60; index++) {
      await db.job.create({ data: { id: randomUUID(), type: 'platform.sync_account', payload: { accountId: randomUUID() }, status: 'done' } })
    }
    const controller = new PlatformAdminController(null as never, db, new AuditService(db))
    const recent = await controller.jobs()
    expect(recent.data.some((row) => row.id === failed.id)).toBe(false)

    const failures = await controller.jobFailures()
    expect(failures.data.total).toBeGreaterThanOrEqual(1)
    expect(failures.data.items.some((row) => row.id === failed.id && row.account?.id === accountId)).toBe(true)

    // 忽略后从失败队列消失，状态保留 cancelled 供审计
    const cancelled = await controller.cancelJob(makeActor(), failed.id)
    expect(cancelled.data).toEqual({ cancelled: true })
    expect((await db.job.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe('cancelled')
    const afterCancel = await controller.jobFailures()
    expect(afterCancel.data.items.some((row) => row.id === failed.id)).toBe(false)

    // 批量重试：新的 dead 任务进入 queued，且错误被清空
    const another = await jobs.enqueue({ type: 'platform.sync_account', payload: { accountId } })
    await db.job.update({ where: { id: another.id }, data: { status: 'dead', lastError: 'nowcoder timeout' } })
    const retried = await controller.retryFailures(makeActor())
    expect(retried.data.retried).toBeGreaterThanOrEqual(1)
    const jobAfterRetry = await db.job.findUniqueOrThrow({ where: { id: another.id } })
    expect(jobAfterRetry).toMatchObject({ status: 'queued', attempts: 0, lastError: null })

    // 账号级手动同步：失败任务被忽略后仍可重新排队
    const withPlatform = new PlatformAdminController(new PlatformService(db, jobs), db, new AuditService(db))
    const synced = await withPlatform.syncAccount(makeActor(), accountId)
    expect(synced.data).toMatchObject({ deduplicated: false })
    const manual = await db.job.findUniqueOrThrow({ where: { id: synced.data.jobId } })
    expect(manual).toMatchObject({ type: 'platform.sync_account', status: 'queued' })
    expect(manual.payload).toMatchObject({ accountId, source: 'admin' })
  })
})
