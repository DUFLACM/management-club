import { createHash, randomUUID } from 'node:crypto'
import { isDuplicateKeyError, updatedDocument, type MongoCollection } from './mongo-types.js'
import type { HydroEventPayload } from './contracts.js'

/**
 * Hydro 持久 outbox 与资源状态（07 方案 6）。
 *
 * 一致性模型：核心状态更新与插件写入之间没有经核验的跨模型事务，因此：
 * - hook 只做单文档 CAS 脏标记（有界、可失败重试）；
 * - 刷新器串行读取最新源状态，以源哈希检测变化后分配 bridge revision，
 *   源哈希相同则合并不重复投递；
 * - 投递器只在 outbox 文档已持久化后发起网请求，用 Mongo 原子租约领取，
 *   完成/续租/失败必须匹配 eventId + bodyHash + leaseToken，过期投递器不能
 *   覆盖新处理结果。
 */

export type OutboxStatus = 'pending' | 'delivering' | 'delivered' | 'dead'

export interface OutboxDoc {
  _id: string
  eventId: string
  resourceKey: string
  kind: string
  domainId: string
  revision: number
  /** 不可变序列化文本（JSON 只序列化一次，投递签名与发送使用同一串字节） */
  bodyText: string
  bodyHash: string
  status: OutboxStatus
  attempts: number
  runAfter: Date
  leaseOwner: string | null
  leaseToken: string | null
  leaseUntil: Date | null
  lastError: string | null
  ackAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type ResourceKind = 'contest' | 'record'

export interface ResourceDoc {
  _id: string
  instanceId: string
  kind: ResourceKind
  domainId: string
  docId: string
  sourceHash: string | null
  revision: number
  dirty: boolean
  /** contest/del 观察到的待核验删除（事件与删除操作并行，不能认定已删完） */
  pendingDelete: boolean
  deleteConfirmations: number
  refreshUntil: Date | null
  refreshOwner: string | null
  lastError: string | null
  updatedAt: Date
  dirtyGeneration?: number
  /** 单文档 CAS 保存待持久化事件，进程中断后由下一轮恢复，不丢已分配修订。 */
  pendingEvent?: OutboxDoc | null
}

export const OUTBOX_COLLECTION = 'club_bridge.outbox'
export const RESOURCE_COLLECTION = 'club_bridge.resources'

export function contestResourceKey(domainId: string, docId: string): string {
  return `contest:${domainId}:${docId}`
}

export function recordResourceKey(domainId: string, recordId: string): string {
  return `record:${domainId}:${recordId}`
}

/** 指数退避（07 方案 6）：5s、30s、2m、10m，之后封顶 30min；带 ±20% 抖动 */
export const BACKOFF_SCHEDULE_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000]
export const MAX_BACKOFF_MS = 30 * 60_000

export function computeBackoffMs(failedAttempts: number, rng: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(failedAttempts))
  const base = n <= BACKOFF_SCHEDULE_MS.length ? BACKOFF_SCHEDULE_MS[n - 1] : MAX_BACKOFF_MS
  const jitter = 1 + (rng() * 2 - 1) * 0.2
  return Math.round(Math.min(MAX_BACKOFF_MS, base * jitter))
}

/**
 * 投递失败分类：网络超时/中断、429、5xx 可重试；其余 4xx（签名/key/时间窗/域未授权
 * 等配置错误）不可通过重试修复，进入 dead letter。
 */
export function classifyDeliveryFailure(httpStatus: number | null): 'retry' | 'dead' {
  if (httpStatus === null) return 'retry' // 网络错误/超时
  if (httpStatus === 429 || httpStatus === 408 || httpStatus === 425) return 'retry'
  if (httpStatus >= 500) return 'retry'
  return 'dead'
}

/** 投递器租约领取 filter：只领取到期 pending 文档 */
export function buildClaimFilter(now: Date): Record<string, unknown> {
  return { $or: [
    { status: 'pending' as OutboxStatus, runAfter: { $lte: now } },
    { status: 'delivering' as OutboxStatus, leaseUntil: { $lte: now } },
  ] }
}

export function buildClaimUpdate(now: Date, leaseOwner: string, leaseToken: string, leaseUntil: Date): Record<string, unknown> {
  return {
    $set: {
      status: 'delivering' as OutboxStatus,
      leaseOwner,
      leaseToken,
      leaseUntil,
      updatedAt: now,
    },
  }
}

/** 完成/续租/失败必须匹配 eventId + bodyHash + leaseToken（CAS） */
export function buildCompleteFilter(doc: Pick<OutboxDoc, 'eventId' | 'bodyHash' | 'leaseToken'>): Record<string, unknown> {
  return { eventId: doc.eventId, bodyHash: doc.bodyHash, leaseToken: doc.leaseToken, status: 'delivering' as OutboxStatus }
}

export function buildCompleteUpdate(now: Date): Record<string, unknown> {
  return {
    $set: {
      status: 'delivered' as OutboxStatus,
      ackAt: now,
      leaseToken: null,
      leaseUntil: null,
      lastError: null,
      updatedAt: now,
    },
  }
}

export function buildRetryUpdate(now: Date, failedAttempts: number, delayMs: number, error: string): Record<string, unknown> {
  return {
    $set: {
      status: 'pending' as OutboxStatus,
      attempts: failedAttempts,
      runAfter: new Date(now.getTime() + delayMs),
      leaseToken: null,
      leaseUntil: null,
      lastError: truncateError(error),
      updatedAt: now,
    },
  }
}

export function buildDeadUpdate(now: Date, error: string): Record<string, unknown> {
  return {
    $set: {
      status: 'dead' as OutboxStatus,
      leaseToken: null,
      leaseUntil: null,
      lastError: truncateError(error),
      updatedAt: now,
    },
  }
}

function truncateError(error: string): string {
  const s = typeof error === 'string' ? error : String(error)
  return s.length > 500 ? `${s.slice(0, 500)}…` : s
}

/** 刷新器领取脏资源 filter：脏且刷新租约空闲或过期 */
export function buildResourceClaimFilter(now: Date, batchSize: number): { filter: Record<string, unknown>; sort: Record<string, 1 | -1> } {
  void batchSize
  return {
    filter: {
      dirty: true,
      $or: [{ refreshUntil: null }, { refreshUntil: { $exists: false } }, { refreshUntil: { $lt: now } }],
    },
    sort: { updatedAt: 1 },
  }
}

export function buildResourceClaimUpdate(now: Date, owner: string, leaseUntil: Date): Record<string, unknown> {
  return { $set: { refreshOwner: owner, refreshUntil: leaseUntil, updatedAt: now } }
}

export function buildResourceCommitFilter(key: string, owner: string): Record<string, unknown> {
  return { _id: key, refreshOwner: owner }
}

export interface RefreshOutcome {
  sourceHash: string
  /** null 表示源已不可读（删除事实） */
  sourceAvailable: boolean
  snapshot: Record<string, unknown> | null
}

/**
 * Outbox/资源存储。所有写路径均为单文档原子操作（普通部署不预设事务支持）。
 */
export class OutboxStore {
  constructor(
    private readonly outbox: MongoCollection<OutboxDoc>,
    private readonly resources: MongoCollection<ResourceDoc>,
    private readonly newId: () => string = randomUUID,
  ) {}

  async ensureIndexes(log: (msg: string, err?: unknown) => void): Promise<void> {
    try {
      await this.outbox.createIndex({ eventId: 1 }, { name: 'eventId_unique', unique: true })
      await this.outbox.createIndex({ status: 1, runAfter: 1 }, { name: 'status_runAfter' })
      await this.outbox.createIndex({ resourceKey: 1, revision: 1 }, { name: 'resource_revision' })
      await this.resources.createIndex({ dirty: 1, updatedAt: 1 }, { name: 'dirty_updatedAt' })
    } catch (error) {
      log('club-bridge: ensureIndexes 失败，必须关闭 bridge 避免缺少唯一约束', error)
      throw error
    }
  }

  /** hook 入口：有界单文档 CAS 脏标记（可重复调用，幂等） */
  async markDirty(input: {
    instanceId: string
    kind: ResourceKind
    domainId: string
    docId: string
    pendingDelete?: boolean
    now?: Date
  }): Promise<void> {
    const now = input.now ?? new Date()
    const _id = input.kind === 'contest'
      ? contestResourceKey(input.domainId, input.docId)
      : recordResourceKey(input.domainId, input.docId)
    const update: Record<string, unknown> = {
      $set: { dirty: true, updatedAt: now, instanceId: input.instanceId },
      $inc: { dirtyGeneration: 1 },
      $setOnInsert: {
        _id,
        kind: input.kind,
        domainId: input.domainId,
        docId: input.docId,
        sourceHash: null,
        revision: 0,
        ...(!input.pendingDelete ? { pendingDelete: false } : {}),
        deleteConfirmations: 0,
        refreshUntil: null,
        refreshOwner: null,
        lastError: null,
      },
    }
    if (input.pendingDelete) (update.$set as Record<string, unknown>).pendingDelete = true
    await this.resources.updateOne({ _id }, update, { upsert: true })
  }

  /** 刷新器领取一批脏资源（租约 CAS，多进程安全） */
  async claimDirtyResources(now: Date, batchSize: number, owner = this.newId()): Promise<ResourceDoc[]> {
    const { filter, sort } = buildResourceClaimFilter(now, batchSize)
    const claimed: ResourceDoc[] = []
    for (let i = 0; i < batchSize; i++) {
      const res = await this.resources.findOneAndUpdate(
        { ...filter, ...(claimed.length ? { _id: { $nin: claimed.map((c) => c._id) } } : {}) },
        buildResourceClaimUpdate(now, owner, new Date(now.getTime() + 60_000)),
        { returnDocument: 'after', sort, includeResultMetadata: false },
      )
      const doc = updatedDocument(res)
      if (!doc) break
      claimed.push(doc)
    }
    return claimed
  }

  /**
   * 刷新提交：源哈希相同则仅清脏（合并不重复投递）；变化则 revision+1 并入队事件。
   * 返回新插入的 outbox 事件（无变化时为 null）。
   */
  async commitRefresh(
    resource: ResourceDoc,
    outcome: RefreshOutcome,
    options: { now?: Date; buildBody: (revision: number, snapshotHash: string, observedAt: string) => HydroEventPayload; sourceVersion?: string },
  ): Promise<OutboxDoc | null> {
    const now = options.now ?? new Date()
    // 恢复上次 CAS 已保存但尚未写入 outbox 的不可变事件。
    if (resource.pendingEvent) await this.persistEvent(resource.pendingEvent)
    const unchanged = resource.sourceHash === outcome.sourceHash
    const generationFilter = resource.dirtyGeneration === undefined ? {} : { dirtyGeneration: resource.dirtyGeneration }
    const commitFilter = { ...buildResourceCommitFilter(resource._id, resource.refreshOwner ?? ''), revision: resource.revision, updatedAt: resource.updatedAt, ...generationFilter }
    if (unchanged) {
      const res = await this.resources.updateOne(commitFilter, {
        $set: { dirty: false, pendingEvent: null, pendingDelete: false, deleteConfirmations: 0, refreshOwner: null, refreshUntil: null, updatedAt: now },
      })
      void res
      return null
    }
    const revision = resource.revision + 1
    const snapshotHash = outcome.sourceHash
    const observedAt = now.toISOString()
    const payload = options.buildBody(revision, snapshotHash, observedAt)
    const bodyText = JSON.stringify(payload)
    const doc: OutboxDoc = {
      _id: `${resource._id}:${revision}:${this.newId()}`,
      eventId: payload.eventId,
      resourceKey: resource._id,
      kind: payload.kind,
      domainId: resource.domainId,
      revision,
      bodyText,
      bodyHash: bufferHash(bodyText),
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
    }
    // 先把修订与不可变事件一起保存在资源单文档；失败/中断时 dirty 保留供恢复。
    const committed = await this.resources.updateOne(commitFilter, {
      $set: {
        sourceHash: snapshotHash,
        revision,
        dirty: true,
        pendingEvent: doc,
        pendingDelete: false,
        deleteConfirmations: 0,
        updatedAt: now,
      },
    })
    if (!committed.matchedCount) return null // 租约已被接管，或读取期间出现新 hook。
    const inserted = await this.persistEvent(doc)
    await this.resources.updateOne({ ...buildResourceCommitFilter(resource._id, resource.refreshOwner ?? ''), revision, updatedAt: now, ...generationFilter }, {
      $set: { pendingEvent: null, dirty: false, refreshOwner: null, refreshUntil: null },
    })
    return inserted ? doc : null
  }

  /** 刷新失败：保留脏标记按退避重试（删除断言需要连续确认） */
  async refreshFailed(resource: ResourceDoc, error: string, options: { now?: Date; confirmDelete?: boolean } = {}): Promise<void> {
    const now = options.now ?? new Date()
    await this.resources.updateOne(buildResourceCommitFilter(resource._id, resource.refreshOwner ?? ''), {
      $set: {
        dirty: true,
        lastError: truncateError(error),
        refreshOwner: null,
        refreshUntil: new Date(now.getTime() + 15_000),
        updatedAt: now,
        ...(options.confirmDelete ? { deleteConfirmations: (resource.deleteConfirmations || 0) + 1 } : {}),
      },
    })
  }

  /** 投递器领取到期事件（多进程：Mongo 原子 findOneAndUpdate 抢占租约） */
  async claimDue(now: Date, batchSize: number, owner = `worker-${process.pid}-${this.newId()}`): Promise<OutboxDoc[]> {
    const claimed: OutboxDoc[] = []
    for (let i = 0; i < batchSize; i++) {
      const res = await this.outbox.findOneAndUpdate(
        { ...buildClaimFilter(now), ...(claimed.length ? { _id: { $nin: claimed.map((c) => c._id) } } : {}) },
        buildClaimUpdate(now, owner, this.newId(), new Date(now.getTime() + 60_000)),
        { returnDocument: 'after', sort: { runAfter: 1, _id: 1 }, includeResultMetadata: false },
      )
      const doc = updatedDocument(res)
      if (!doc) break
      claimed.push(doc)
    }
    return claimed
  }

  async markDelivered(doc: OutboxDoc, now = new Date()): Promise<boolean> {
    const res = await this.outbox.updateOne(buildCompleteFilter(doc), buildCompleteUpdate(now))
    return res.modifiedCount === 1 || res.matchedCount === 1
  }

  async markRetry(doc: OutboxDoc, error: string, delayMs: number, now = new Date()): Promise<boolean> {
    const failedAttempts = doc.attempts + 1
    const res = await this.outbox.updateOne(
      buildCompleteFilter(doc),
      buildRetryUpdate(now, failedAttempts, delayMs, error),
    )
    return res.matchedCount === 1
  }

  async markDead(doc: OutboxDoc, error: string, now = new Date()): Promise<boolean> {
    const res = await this.outbox.updateOne(buildCompleteFilter(doc), buildDeadUpdate(now, error))
    return res.matchedCount === 1
  }

  async findResource(key: string): Promise<ResourceDoc | null> {
    return await this.resources.findOne({ _id: key })
  }

  private async persistEvent(doc: OutboxDoc): Promise<boolean> {
    try {
      await this.outbox.insertOne(doc)
      return true
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error
      const existing = await this.outbox.findOne({ eventId: doc.eventId })
      if (!existing || existing.bodyHash !== doc.bodyHash) throw new Error('club-bridge: eventId 冲突且 bodyHash 不同')
      return false
    }
  }
}

function bufferHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
