import { randomUUID } from 'node:crypto'
import type { Context } from 'hydrooj'
import { ContestModel, RecordModel } from 'hydrooj'
import { loadConfig } from './config.js'
import { sha256Hex, type HydroEventPayload } from './contracts.js'
import {
  contestSourceSnapshot,
  deletedContestSnapshot,
  recordSourceSnapshot,
  sourceHashOf,
  sweepQuery,
} from './adapters/hydro-v5.js'
import {
  contestResourceKey,
  OUTBOX_COLLECTION,
  OutboxStore,
  recordResourceKey,
  RESOURCE_COLLECTION,
  type OutboxDoc,
  type ResourceDoc,
  type ResourceKind,
} from './outbox.js'
import { startDeliveryLoop } from './delivery.js'
import { NONCE_COLLECTION, getHydroObjectIdCtor, registerReadRoutes } from './handlers/read.js'
import type { MongoCollection } from './mongo-types.js'

/**
 * @acm/hydro-bridge —— 校内 Hydro OJ 附属 bridge 插件（docs/scheme/07-hydro-oj-plugin.md）。
 *
 * 结构：本地事件提示 + Hydro 持久 outbox + 签名 webhook + 授权回拉。
 * - hook 只做有界本地 outbox 入队/脏标记（合并重复标记），绝不向判题回调抛出插件错误；
 * - 不使用 contest/scoreboard 触发结赛，不猜测 contest/end、contest/attend 等
 *   不存在的事件；真实名单与终判由主系统授权回拉与周期核对发现；
 * - 插件只写自有集合（club_bridge.*），不写核心 event/task 等 collection；
 * - 配置不完整时启动失败只告警并关闭 bridge，Hydro 与判题继续运行（07 §11.1）。
 */

const PLUGIN_VERSION = '0.1.0'

interface PluginLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

function createLogger(): PluginLogger {
  // 优先使用 Hydro 的 Logger（@hydrooj/utils），不可用时退回 console。
  try {
    const mod = require('hydrooj') as { logger?: PluginLogger; Logger?: new (name: string) => PluginLogger }
    if (mod.logger) return mod.logger
    if (mod.Logger) return new mod.Logger('club-bridge')
  } catch {
    /* fallthrough */
  }
  const tag = '[club-bridge]'
  return {
    info: (...args: unknown[]) => console.info(tag, ...args),
    warn: (...args: unknown[]) => console.warn(tag, ...args),
    error: (...args: unknown[]) => console.error(tag, ...args),
  }
}

function hydroVersion(): string {
  const hydro = (globalThis as { Hydro?: { version?: Record<string, string> } }).Hydro
  return hydro?.version?.hydrooj ?? 'unknown'
}

/** hook 安全包装：捕获全部异常，绝不向 Hydro 判题/比赛回调抛出插件错误 */
function safeHook<A extends unknown[]>(log: PluginLogger, name: string, fn: (...args: A) => void | Promise<void>) {
  return async (...args: A) => {
    try {
      await fn(...args)
    } catch (error) {
      log.error(`club-bridge: hook ${name} 失败（已吞掉，不影响判题）`, error)
    }
  }
}

export async function apply(ctx: Context): Promise<void> {
  const log = createLogger()
  try {
    await initialize(ctx, log)
  } catch (error) {
    log.error('club-bridge: 初始化失败，bridge 已关闭', error)
  }
}

async function initialize(ctx: Context, log: PluginLogger): Promise<void> {
  const { config, issues } = loadConfig()
  for (const warning of issues.warnings) log.warn('club-bridge: %s', warning)
  if (issues.errors.length > 0) {
    for (const error of issues.errors) log.error('club-bridge: %s', error)
    log.error('club-bridge: 配置不完整，插件已停用（Hydro 本体与判题不受影响）。请核对 HYDROOJ_CLUB_* 环境变量或 ~/.hydro/club-bridge.json')
    return
  }

  const outboxColl = ctx.db.collection(OUTBOX_COLLECTION) as unknown as MongoCollection<OutboxDoc>
  const resourceColl = ctx.db.collection(RESOURCE_COLLECTION) as unknown as MongoCollection<ResourceDoc>
  const nonceColl = ctx.db.collection(NONCE_COLLECTION) as unknown as MongoCollection<{ _id: string; expiresAt: Date }>
  const store = new OutboxStore(outboxColl, resourceColl)
  await store.ensureIndexes((message, error) => log.warn(message, error))
  await nonceColl.createIndex({ expiresAt: 1 }, { name: 'expiresAt_ttl', expireAfterSeconds: 0 })

  const allowed = new Set(config.allowedDomains)
  const ObjectIdCtor = getHydroObjectIdCtor()
  if (!ObjectIdCtor) {
    log.error('club-bridge: 无法从 Hydro 运行时获取 ObjectId 构造器（RecordModel.RECORD_PRETEST），插件停用')
    return
  }

  const markContest = async (domainId: string, docId: string, pendingDelete = false): Promise<void> => {
    await store.markDirty({ instanceId: config.instanceId, kind: 'contest', domainId, docId, pendingDelete })
  }

  const markRecord = async (domainId: string, recordId: string): Promise<void> => {
    await store.markDirty({ instanceId: config.instanceId, kind: 'record', domainId, docId: recordId })
  }

  // ---- hook：只做有界本地脏标记（07 §2.2 / §3） ----

  /** 判题后调用：updated=false 也不能忽略；重判 AC→WA 会产生新修订 */
  ctx.on('record/judge', safeHook(log, 'record/judge', (rdoc: { domainId: string; _id: { toHexString(): string }; contest?: unknown }, _updated: boolean) => {
    if (!rdoc?.contest || !rdoc.domainId || !allowed.has(rdoc.domainId)) return
    return markRecord(rdoc.domainId, rdoc._id.toHexString())
  }))

  /** 创建、过程更新、重判重置等：合并重复脏标记，不逐中间状态发事件 */
  ctx.on('record/change', safeHook(log, 'record/change', (rdoc: { domainId: string; _id: { toHexString(): string }; contest?: unknown }) => {
    if (!rdoc?.contest || !rdoc.domainId || !allowed.has(rdoc.domainId)) return
    return markRecord(rdoc.domainId, rdoc._id.toHexString())
  }))

  /** payload 未保证包含 domainId：在允许域内回查（有界：仅允许域列表） */
  ctx.on('contest/add', safeHook(log, 'contest/add', async (payload: { domainId?: string }, id: { toHexString(): string }) => {
    const docId = id.toHexString()
    if (payload?.domainId) {
      if (allowed.has(payload.domainId)) await markContest(payload.domainId, docId)
      return
    }
    for (const domainId of config.allowedDomains) {
      const hit = await ContestModel.getMulti(domainId, { docId: new ObjectIdCtor(docId) }).limit(1).toArray().catch(() => [])
      if (hit.length) {
        await markContest(domainId, docId)
        return
      }
    }
  }))

  ctx.on('contest/edit', safeHook(log, 'contest/edit', (payload: { domainId?: string; docId?: { toHexString(): string } }) => {
    if (!payload?.domainId || !payload.docId) return
    if (!allowed.has(payload.domainId)) return
    return markContest(payload.domainId, payload.docId.toHexString())
  }))

  /** 调用点与删除操作并行：先标记待核验删除，由刷新器确认后生成删除事实 */
  ctx.on('contest/del', safeHook(log, 'contest/del', (domainId: string, tid: { toHexString(): string }) => {
    if (!allowed.has(domainId)) return
    return markContest(domainId, tid.toHexString(), true)
  }))

  // 注意：不注册 contest/scoreboard —— 它是榜单生成/读取 hook，不是结赛通知（07 §2.2）。

  // ---- 事件体构造（仅资源引用 + 最小状态；不含代码/个人信息） ----

  const buildBody = (resource: Pick<ResourceDoc, 'kind' | 'domainId' | 'docId'>, eventKind: string, resourceRefs: Record<string, unknown>) =>
    (revision: number, snapshotHash: string, observedAt: string): HydroEventPayload => ({
      schemaVersion: 1,
      eventId: randomUUID(),
      instanceId: config.instanceId,
      domainId: resource.domainId,
      kind: eventKind,
      resource: resourceRefs,
      revision,
      snapshotHash,
      observedAt,
      sourceVersion: hydroVersion(),
    })

  // ---- 刷新器：串行读取最新源状态 → 源哈希检测变化 → 分配 bridge revision ----

  const refreshContest = async (resource: ResourceDoc, now: Date): Promise<void> => {
    const tid = new ObjectIdCtor(resource.docId)
    const tdoc = await ContestModel.get(resource.domainId, tid).catch((error: unknown) => {
      if (isNotFoundError(error)) return null
      throw error
    })
    if (tdoc) {
      if (resource.pendingDelete && (resource.deleteConfirmations || 0) < 2) {
        // 删除事件先到而删除未完成：延后确认
        await store.refreshFailed(resource, 'contest/del 已观察但比赛仍存在，等待删除完成', { now, confirmDelete: false })
        return
      }
      const statuses = await ContestModel.getMultiStatus(resource.domainId, { docId: tid, attend: { $gte: 1 } }).sort({ uid: 1 }).limit(5001).toArray()
      if (statuses.length > 5000) throw new Error('contest 状态核对超过 5000 条，须配置校方分页适配')
      // rev/名单/团队/开始结束时间纳入源哈希，周期扫描可发现缺失的报名和重判 hook。
      const snapshot = {
        ...contestSourceSnapshot(tdoc, now),
        participantStateHash: sourceHashOf({ states: statuses.map((status) => ({
          uid: status.uid, rev: status.rev ?? null, attend: status.attend ?? 0,
          startAt: status.startAt?.toISOString() ?? null, endAt: status.endAt?.toISOString() ?? null,
          members: status.members ?? [], unrank: !!status.unrank,
          accept: status.accept ?? null, score: status.score ?? null, time: status.time ?? null,
        })) }, sha256Hex),
      }
      await store.commitRefresh(resource, {
        sourceHash: sourceHashOf(snapshot, sha256Hex),
        sourceAvailable: true,
        snapshot,
      }, {
        now,
        buildBody: buildBody(resource, 'contest.meta.changed', { contestId: resource.docId }),
      })
      return
    }
    if (!resource.pendingDelete) {
      // 无删除事件的不可读：可能是域配置变化或临时故障，保留脏标记有限重试
      await store.refreshFailed(resource, `contest ${resource.docId} 读取不到且无删除事件`, { now })
      return
    }
    if ((resource.deleteConfirmations || 0) + 1 < 2) {
      await store.refreshFailed(resource, 'contest 不可读，删除待二次确认', { now, confirmDelete: true })
      return
    }
    const snapshot = deletedContestSnapshot(resource.domainId, resource.docId, (resource.deleteConfirmations || 0) + 1)
    await store.commitRefresh(resource, {
      sourceHash: sourceHashOf(snapshot, sha256Hex),
      sourceAvailable: false,
      snapshot,
    }, {
      now,
      buildBody: buildBody(resource, 'contest.deleted', { contestId: resource.docId, deleted: true }),
    })
  }

  const refreshRecord = async (resource: ResourceDoc, now: Date): Promise<void> => {
    const rid = new ObjectIdCtor(resource.docId)
    const rdoc = await RecordModel.get(resource.domainId, rid)
    if (rdoc) {
      const snapshot = recordSourceSnapshot(rdoc)
      await store.commitRefresh(resource, {
        sourceHash: sourceHashOf(snapshot, sha256Hex),
        sourceAvailable: true,
        snapshot,
      }, {
        now,
        buildBody: buildBody(resource, 'record.snapshot.available', {
          ...(rdoc.contest ? { contestId: rdoc.contest.toHexString() } : {}),
          recordId: resource.docId,
        }),
      })
      return
    }
    // 提交被删除（成绩撤销是重要事实）：生成删除事实，交主系统核对
    const snapshot = { kind: 'record-deleted', domainId: resource.domainId, recordId: resource.docId }
    await store.commitRefresh(resource, {
      sourceHash: sourceHashOf(snapshot, sha256Hex),
      sourceAvailable: false,
      snapshot,
    }, {
      now,
      buildBody: buildBody(resource, 'record.deleted', { recordId: resource.docId, deleted: true }),
    })
  }

  let refreshing = false
  const runRefreshRound = async (): Promise<void> => {
    if (refreshing) return
    refreshing = true
    try {
      const now = new Date()
      const claimed = await store.claimDirtyResources(now, config.refresh.batchSize)
      for (const resource of claimed) {
        const refresher = resource.kind === 'contest' ? refreshContest : refreshRecord
        try {
          await refresher(resource, new Date())
        } catch (error) {
          log.error(`club-bridge: 刷新资源 ${resource._id} 失败`, error)
          await store.refreshFailed(resource, error instanceof Error ? error.message : String(error)).catch(() => undefined)
        }
      }
    } catch (error) {
      log.error('club-bridge: 刷新轮失败', error)
    } finally {
      refreshing = false
    }
  }
  ctx.interval(() => { void runRefreshRound() }, Math.max(1_000, config.refresh.intervalMs))

  // ---- 周期核对：无 hook 的变化（名单、灵活时间、取消登记、赛制修改、重判）靠周期扫描补 ----
  const runSweep = async (): Promise<void> => {
    const now = new Date()
    const { beginAtStart, beginAtEnd } = sweepQuery(now, config.sweepLookbackDays)
    for (const domainId of config.allowedDomains) {
      try {
        const tdocs = await ContestModel.getMulti(domainId, { beginAt: { $gte: beginAtStart, $lte: beginAtEnd } }).limit(501).toArray()
        if (tdocs.length > 500) log.warn('club-bridge: 域 %s 核对窗口超过 500 场，需校方分页适配', domainId)
        for (const tdoc of tdocs.slice(0, 500)) await markContest(domainId, tdoc.docId.toHexString())
      } catch (error) {
        log.error(`club-bridge: 全量核对域 ${domainId} 失败`, error)
      }
    }
  }
  if (config.sweepIntervalMs > 0) ctx.interval(() => { void runSweep().catch(() => undefined) }, Math.max(60_000, config.sweepIntervalMs))
  void runSweep().catch((error) => log.error('club-bridge: 启动核对失败', error))

  // ---- 投递器：租约领取 → 签名投递 → 指数退避 → dead letter ----
  const stopDelivery = startDeliveryLoop({
    store,
    config,
    intervalMs: config.delivery.intervalMs,
    log,
  })
  ctx.on('dispose', stopDelivery)

  // ---- club-bridge 只读路由（机器鉴权 + 最小投影） ----
  registerReadRoutes(ctx, { config, nonces: nonceColl, hydroVersion: hydroVersion(), log })

  log.info(
    'club-bridge v%s 已启动：instance=%s domains=%s endpoint=%s hydro=%s',
    PLUGIN_VERSION, config.instanceId, config.allowedDomains.join(','), config.endpoint, hydroVersion(),
  )
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { name?: string; message?: string }
  if (typeof e.name === 'string' && e.name.includes('NotFound')) return true
  return typeof e.message === 'string' && /not found/i.test(e.message)
}
