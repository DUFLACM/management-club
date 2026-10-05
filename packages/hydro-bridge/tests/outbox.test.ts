import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  buildClaimFilter,
  buildClaimUpdate,
  buildCompleteFilter,
  buildCompleteUpdate,
  buildDeadUpdate,
  buildRetryUpdate,
  classifyDeliveryFailure,
  computeBackoffMs,
  contestResourceKey,
  BACKOFF_SCHEDULE_MS,
  MAX_BACKOFF_MS,
  OutboxStore,
  recordResourceKey,
  type OutboxDoc,
  type ResourceDoc,
} from '../src/outbox.js'
import { MockCollection } from './helpers/mock-collection.js'
import { sha256Hex } from '../src/contracts.js'

function outboxDoc(overrides: Partial<OutboxDoc> = {}): OutboxDoc {
  const now = new Date('2026-10-05T11:00:00Z')
  return {
    _id: 'contest:acm-club:670100000000000000000001:1:x',
    eventId: randomUUID(),
    resourceKey: 'contest:acm-club:670100000000000000000001',
    kind: 'contest.meta.changed',
    domainId: 'acm-club',
    revision: 1,
    bodyText: '{"schemaVersion":1}',
    bodyHash: sha256Hex('{"schemaVersion":1}'),
    status: 'pending',
    attempts: 0,
    runAfter: now,
    leaseOwner: null,
    leaseToken: null,
    leaseUntil: null,
    lastError: null,
    ackAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function resourceDoc(overrides: Partial<ResourceDoc> = {}): ResourceDoc {
  const now = new Date('2026-10-05T11:00:00Z')
  return {
    _id: contestResourceKey('acm-club', '670100000000000000000001'),
    instanceId: '11111111-1111-4111-8111-111111111111',
    kind: 'contest',
    domainId: 'acm-club',
    docId: '670100000000000000000001',
    sourceHash: null,
    revision: 0,
    dirty: true,
    pendingDelete: false,
    deleteConfirmations: 0,
    refreshUntil: null,
    refreshOwner: null,
    lastError: null,
    updatedAt: now,
    ...overrides,
  }
}

describe('退避与失败分类（纯函数）', () => {
  it('退避序列 5s/30s/2m/10m，之后封顶 30min；抖动 ±20%', () => {
    const mid = () => 0.5
    expect(computeBackoffMs(1, mid)).toBe(5_000)
    expect(computeBackoffMs(2, mid)).toBe(30_000)
    expect(computeBackoffMs(3, mid)).toBe(120_000)
    expect(computeBackoffMs(4, mid)).toBe(600_000)
    expect(computeBackoffMs(5, mid)).toBe(MAX_BACKOFF_MS)
    expect(computeBackoffMs(100, mid)).toBe(MAX_BACKOFF_MS)
    expect(BACKOFF_SCHEDULE_MS).toEqual([5_000, 30_000, 120_000, 600_000])
    expect(computeBackoffMs(1, () => 0)).toBe(4_000)
    expect(computeBackoffMs(1, () => 1)).toBe(6_000)
    expect(computeBackoffMs(5, () => 1)).toBe(MAX_BACKOFF_MS)
  })

  it('网络/429/408/425/5xx 可重试；其余 4xx 进入 dead letter', () => {
    expect(classifyDeliveryFailure(null)).toBe('retry')
    expect(classifyDeliveryFailure(429)).toBe('retry')
    expect(classifyDeliveryFailure(408)).toBe('retry')
    expect(classifyDeliveryFailure(425)).toBe('retry')
    expect(classifyDeliveryFailure(500)).toBe('retry')
    expect(classifyDeliveryFailure(503)).toBe('retry')
    expect(classifyDeliveryFailure(400)).toBe('dead')
    expect(classifyDeliveryFailure(401)).toBe('dead')
    expect(classifyDeliveryFailure(403)).toBe('dead')
    expect(classifyDeliveryFailure(404)).toBe('dead')
    expect(classifyDeliveryFailure(409)).toBe('dead')
  })
})

describe('租约状态机 filter/update 构造（纯函数）', () => {
  const now = new Date('2026-10-05T11:00:00Z')

  it('领取只匹配到期 pending 文档', () => {
    expect(buildClaimFilter(now)).toEqual({ $or: [
      { status: 'pending', runAfter: { $lte: now } },
      { status: 'delivering', leaseUntil: { $lte: now } },
    ] })
  })

  it('领取写入 delivering + 租约', () => {
    const update = buildClaimUpdate(now, 'worker-a', 'token-1', new Date(now.getTime() + 60_000))
    expect(update.$set).toMatchObject({ status: 'delivering', leaseOwner: 'worker-a', leaseToken: 'token-1' })
  })

  it('完成/重试/死亡均要求 eventId+bodyHash+leaseToken 匹配', () => {
    const doc = outboxDoc({ leaseToken: 'token-1' })
    expect(buildCompleteFilter(doc)).toEqual({
      eventId: doc.eventId,
      bodyHash: doc.bodyHash,
      leaseToken: 'token-1',
      status: 'delivering',
    })
    expect(buildCompleteUpdate(now).$set).toMatchObject({ status: 'delivered', ackAt: now, leaseToken: null, lastError: null })
    expect(buildRetryUpdate(now, 3, 5_000, 'HTTP 500').$set).toMatchObject({ status: 'pending', attempts: 3, runAfter: new Date(now.getTime() + 5_000), leaseToken: null })
    expect(buildDeadUpdate(now, 'HTTP 403').$set).toMatchObject({ status: 'dead', leaseToken: null })
  })
})

describe('OutboxStore（mock collection）', () => {
  const now = new Date('2026-10-05T11:00:00Z')

  function createStore() {
    const outbox = new MockCollection<OutboxDoc>()
    const resources = new MockCollection<ResourceDoc>()
    return { outbox, resources, store: new OutboxStore(outbox, resources) }
  }

  it('claimDue：领取到期 pending、写租约；未到期/非 pending 不领取；同批不重复', async () => {
    const { outbox, store } = createStore()
    outbox.docs.push(outboxDoc({ _id: 'a', eventId: 'a', runAfter: new Date(now.getTime() - 1_000) }))
    outbox.docs.push(outboxDoc({ _id: 'b', eventId: 'b', runAfter: new Date(now.getTime() + 60_000) }))
    outbox.docs.push(outboxDoc({ _id: 'c', eventId: 'c', status: 'delivering', leaseToken: 'old' }))
    const claimed = await store.claimDue(now, 10, 'worker-a')
    expect(claimed.map((d) => d._id)).toEqual(['a'])
    expect(outbox.docs[0]).toMatchObject({ status: 'delivering', leaseOwner: 'worker-a' })
    expect(outbox.docs[0].leaseToken).toBeTruthy()
    // 再领取不会重复拿到 a
    expect((await store.claimDue(now, 10, 'worker-b')).length).toBe(0)
  })

  it('markDelivered 幂等完成：必须匹配 leaseToken；错误 token 不生效', async () => {
    const { outbox, store } = createStore()
    outbox.docs.push(outboxDoc({ _id: 'a', eventId: 'a' }))
    const [claimed] = await store.claimDue(now, 1, 'worker-a')
    // 错误 leaseToken：CAS 不生效，仍是 delivering
    expect(await store.markDelivered({ ...claimed, leaseToken: 'stale-token' }, now)).toBe(false)
    expect(outbox.docs[0].status).toBe('delivering')
    expect(await store.markDelivered(claimed, now)).toBe(true)
    expect(outbox.docs[0]).toMatchObject({ status: 'delivered', ackAt: now })
    // 已完成后重复 ack（过期投递器）不能覆盖
    expect(await store.markDelivered(claimed, now)).toBe(false)
  })

  it('markRetry：attempts+1、runAfter=now+backoff；markDead：dead + lastError', async () => {
    const { outbox, store } = createStore()
    outbox.docs.push(outboxDoc())
    const [claimed] = await store.claimDue(now, 1, 'worker-a')
    expect(await store.markRetry(claimed, 'HTTP 503', 5_000, now)).toBe(true)
    expect(outbox.docs[0]).toMatchObject({ status: 'pending', attempts: 1, lastError: 'HTTP 503', runAfter: new Date(now.getTime() + 5_000) })
    const [again] = await store.claimDue(new Date(now.getTime() + 6_000), 1, 'worker-b')
    expect(await store.markDead(again, 'HTTP 403 SIGNATURE_INVALID', now)).toBe(true)
    expect(outbox.docs[0]).toMatchObject({ status: 'dead', lastError: 'HTTP 403 SIGNATURE_INVALID' })
  })

  it('markDirty 幂等 upsert；commitRefresh 源哈希相同合并不投递、变化则 revision+1 入队', async () => {
    const { outbox, resources, store } = createStore()
    await store.markDirty({ instanceId: 'i', kind: 'contest', domainId: 'acm-club', docId: '670100000000000000000001', now })
    await store.markDirty({ instanceId: 'i', kind: 'contest', domainId: 'acm-club', docId: '670100000000000000000001', now })
    expect(resources.docs.length).toBe(1)
    const [claimed] = await store.claimDirtyResources(now, 10, 'refresher-a')
    expect(claimed.dirty).toBe(true)
    const snapshot = { kind: 'contest', title: '新生赛' }
    const first = await store.commitRefresh(claimed, { sourceHash: sha256Hex(JSON.stringify(snapshot)), sourceAvailable: true, snapshot }, {
      now,
      buildBody: (revision, snapshotHash) => ({ schemaVersion: 1, eventId: randomUUID(), instanceId: 'i', domainId: 'acm-club', kind: 'contest.meta.changed', resource: { contestId: '670100000000000000000001' }, revision, snapshotHash, observedAt: now.toISOString() }),
    })
    expect(first).not.toBeNull()
    expect(outbox.docs.length).toBe(1)
    expect(outbox.docs[0]).toMatchObject({ status: 'pending', revision: 1, domainId: 'acm-club' })
    expect(JSON.parse(outbox.docs[0].bodyText)).toMatchObject({ schemaVersion: 1, revision: 1 })
    expect(resources.docs[0]).toMatchObject({ dirty: false, revision: 1 })

    // 同一源哈希再次刷新：合并，不产生新事件
    await store.markDirty({ instanceId: 'i', kind: 'contest', domainId: 'acm-club', docId: '670100000000000000000001', now: new Date(now.getTime() + 1_000) })
    const [secondClaim] = await store.claimDirtyResources(new Date(now.getTime() + 2_000), 10, 'refresher-b')
    const second = await store.commitRefresh(secondClaim, { sourceHash: sha256Hex(JSON.stringify(snapshot)), sourceAvailable: true, snapshot }, {
      now: new Date(now.getTime() + 2_000),
      buildBody: (revision) => ({ schemaVersion: 1, eventId: randomUUID(), instanceId: 'i', domainId: 'acm-club', kind: 'contest.meta.changed', resource: {}, revision, snapshotHash: 'x', observedAt: '' }),
    })
    expect(second).toBeNull()
    expect(outbox.docs.length).toBe(1)
    expect(resources.docs[0].revision).toBe(1)

    // 源变化（重判 AC→WA 等）：revision+1 产生新事件
    const changed = { kind: 'contest', title: '新生赛（改期）' }
    await store.markDirty({ instanceId: 'i', kind: 'contest', domainId: 'acm-club', docId: '670100000000000000000001', now: new Date(now.getTime() + 3_000) })
    const [thirdClaim] = await store.claimDirtyResources(new Date(now.getTime() + 4_000), 10, 'refresher-c')
    const third = await store.commitRefresh(thirdClaim, { sourceHash: sha256Hex(JSON.stringify(changed)), sourceAvailable: true, snapshot: changed }, {
      now: new Date(now.getTime() + 4_000),
      buildBody: (revision) => ({ schemaVersion: 1, eventId: randomUUID(), instanceId: 'i', domainId: 'acm-club', kind: 'contest.meta.changed', resource: {}, revision, snapshotHash: 'y', observedAt: '' }),
    })
    expect(third?.revision).toBe(2)
    expect(outbox.docs.length).toBe(2)
  })

  it('刷新租约过期后可被其他实例重新领取', async () => {
    const { resources, store } = createStore()
    resources.docs.push(resourceDoc({ refreshOwner: 'refresher-a', refreshUntil: new Date(now.getTime() - 1_000) }))
    const claimed = await store.claimDirtyResources(now, 10, 'refresher-b')
    expect(claimed.length).toBe(1)
    expect(resources.docs[0].refreshOwner).toBe('refresher-b')
    // 未过期的租约不可抢占
    const [, ...rest] = await store.claimDirtyResources(new Date(now.getTime() + 10_000), 10, 'refresher-c')
    expect(rest.length).toBe(0)
  })

  it('资源键：contest/record 分别编码 domainId+docId', () => {
    expect(contestResourceKey('acm-club', 'abc')).toBe('contest:acm-club:abc')
    expect(recordResourceKey('acm-club', 'def')).toBe('record:acm-club:def')
  })

  it('eventId 唯一约束：重复 eventId 插入按幂等合并不抛出', async () => {
    const { outbox } = createStore()
    outbox.withUnique('eventId')
    const resources = new MockCollection<ResourceDoc>()
    const store = new OutboxStore(outbox, resources, () => 'fixed-event-id')
    const resource = resourceDoc({ dirty: true, refreshOwner: 'r' })
    resources.docs.push(resource)
    const buildBody = (revision: number) => ({ schemaVersion: 1, eventId: 'fixed-event-id', instanceId: 'i', domainId: 'acm-club', kind: 'contest.meta.changed', resource: {}, revision, snapshotHash: 'h', observedAt: now.toISOString() })
    const first = await store.commitRefresh(resource, { sourceHash: 'h1', sourceAvailable: true, snapshot: {} }, { now, buildBody })
    expect(first).not.toBeNull()
    resources.docs[0] = { ...resource, sourceHash: 'h1' }
    const dup = await store.commitRefresh(resources.docs[0], { sourceHash: 'h2', sourceAvailable: true, snapshot: {} }, { now, buildBody })
    // 第二次因 eventId 冲突按幂等合并，返回 null 且不抛异常
    expect(dup).toBeNull()
    expect(outbox.docs.length).toBe(1)
  })

  it('过期 delivering 可重领，旧 token 不能覆盖新的投递结果', async () => {
    const { outbox, store } = createStore()
    outbox.docs.push(outboxDoc())
    const [old] = await store.claimDue(now, 1, 'a')
    expect(await store.claimDue(new Date(now.getTime() + 59_000), 1, 'b')).toEqual([])
    const [fresh] = await store.claimDue(new Date(now.getTime() + 60_000), 1, 'b')
    expect(fresh.leaseToken).not.toBe(old.leaseToken)
    expect(await store.markDelivered(old)).toBe(false)
    expect(await store.markDelivered(fresh)).toBe(true)
  })

  it('同毫秒新 hook 的 generation 阻止旧刷新清脏或产生事件', async () => {
    const { outbox, resources, store } = createStore()
    const input = { instanceId: 'i', kind: 'contest' as const, domainId: 'acm-club', docId: '670100000000000000000001', now }
    await store.markDirty(input)
    const [old] = await store.claimDirtyResources(now, 1, 'old')
    await store.markDirty(input)
    const event = await store.commitRefresh(old, { sourceHash: 'h', sourceAvailable: true, snapshot: {} }, {
      now, buildBody: (revision) => ({ schemaVersion: 1, eventId: 'stale', instanceId: 'i', domainId: 'acm-club', kind: 'contest.meta.changed', resource: {}, revision, observedAt: now.toISOString() }),
    })
    expect(event).toBeNull()
    expect(outbox.docs).toHaveLength(0)
    expect(resources.docs[0]).toMatchObject({ dirty: true, revision: 0, dirtyGeneration: 2 })
  })

  it('outbox 写失败后恢复 pendingEvent，保留原 eventId/body/revision', async () => {
    const { outbox, resources, store } = createStore()
    const input = { instanceId: 'i', kind: 'contest' as const, domainId: 'acm-club', docId: '670100000000000000000001', now }
    await store.markDirty(input)
    const [claimed] = await store.claimDirtyResources(now, 1, 'a')
    const originalInsert = outbox.insertOne.bind(outbox)
    outbox.insertOne = async () => { throw new Error('disk unavailable') }
    const outcome = { sourceHash: 'h', sourceAvailable: true, snapshot: {} }
    const options = { now, buildBody: (revision: number) => ({ schemaVersion: 1 as const, eventId: 'saved-id', instanceId: 'i', domainId: 'acm-club', kind: 'contest.meta.changed', resource: {}, revision, observedAt: now.toISOString() }) }
    await expect(store.commitRefresh(claimed, outcome, options)).rejects.toThrow('disk unavailable')
    const saved = resources.docs[0].pendingEvent!
    expect(resources.docs[0]).toMatchObject({ revision: 1, dirty: true })
    outbox.insertOne = originalInsert
    const [recovered] = await store.claimDirtyResources(new Date(now.getTime() + 61_000), 1, 'b')
    expect(await store.commitRefresh(recovered, outcome, options)).toBeNull()
    expect(outbox.docs).toHaveLength(1)
    expect(outbox.docs[0]).toMatchObject({ eventId: saved.eventId, bodyText: saved.bodyText, revision: 1 })
    expect(resources.docs[0]).toMatchObject({ dirty: false, pendingEvent: null, revision: 1 })
  })
})
