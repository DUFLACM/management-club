import { webhookUrl, type BridgeConfig } from './config.js'
import { buildWebhookAuthHeaders } from './signature.js'
import { classifyDeliveryFailure, computeBackoffMs, type OutboxDoc, type OutboxStore } from './outbox.js'

/**
 * 短时签名投递器（07 方案 5/6）：
 * - 只在 outbox 已持久化后发起网请求；Mongo 原子租约领取（多进程只投一份）；
 * - 一次重试生成新的 timestamp/nonce，保留 eventId 与原始 body 字节
 *   （bodyText 存储后不再改动，签名与发送使用同一串字节）；
 * - 网络超时/429/5xx 指数退避重试（5s/30s/2m/10m，最大 30min，带抖动）；
 *   签名配置错误、域未授权等 4xx 进入 dead letter；
 * - 10s 超时、有限并发；远端长时间不可用时积压只影响同步，不影响判题。
 */

export type FetchLike = (url: string, init: {
  method: 'POST'
  headers: Record<string, string>
  body: Buffer
  signal: AbortSignal
  redirect: 'error'
}) => Promise<{ status: number }>

export interface DeliveryLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export interface DeliveryDeps {
  store: OutboxStore
  config: BridgeConfig
  fetchImpl?: FetchLike
  now?: () => Date
  rng?: () => number
  log?: DeliveryLogger
}

/** 单条事件的一次投递尝试。返回远端 HTTP 状态码；网络错误/超时返回 null。 */
export async function deliverOnce(
  doc: OutboxDoc,
  config: BridgeConfig,
  options: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<{ httpStatus: number | null; error: string | null }> {
  const url = webhookUrl(config)
  const bodyBuffer = Buffer.from(doc.bodyText, 'utf8')
  const headers = buildWebhookAuthHeaders({
    keyId: config.pushKeyId,
    instanceId: config.instanceId,
    bodyBuffer,
    secret: config.pushSecret,
    now: options.now,
  })
  const fetchImpl = options.fetchImpl ?? ((u, i) => fetch(u, i))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.delivery.timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: headers as unknown as Record<string, string>,
      body: bodyBuffer,
      signal: controller.signal,
      redirect: 'error',
    })
    return { httpStatus: res.status, error: null }
  } catch (error) {
    return { httpStatus: null, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** 一轮投递：领取到期事件，有限并发投递并按分类落库 */
export async function runDeliveryRound(deps: DeliveryDeps): Promise<number> {
  const { store, config } = deps
  const log = deps.log ?? console
  const now = deps.now ?? (() => new Date())
  const rng = deps.rng ?? Math.random
  const due = await store.claimDue(now(), config.delivery.batchSize)
  if (!due.length) return 0
  let delivered = 0
  const queue = [...due]
  const workers = Array.from({ length: Math.max(1, Math.min(config.delivery.concurrency, queue.length)) }, async () => {
    for (;;) {
      const doc = queue.shift()
      if (!doc) return
      const outcome = await deliverOnce(doc, config, { fetchImpl: deps.fetchImpl, now: now() })
      if (outcome.httpStatus !== null && outcome.httpStatus >= 200 && outcome.httpStatus < 300) {
        if (await store.markDelivered(doc, now())) delivered++
        continue
      }
      const classification = classifyDeliveryFailure(outcome.httpStatus)
      const errorText = outcome.httpStatus !== null
        ? `HTTP ${outcome.httpStatus}`
        : `network error: ${outcome.error ?? 'unknown'}`
      if (classification === 'retry') {
        const delay = computeBackoffMs(doc.attempts + 1, rng)
        await store.markRetry(doc, errorText, delay, now())
      } else {
        log.warn('club-bridge: 事件进入 dead letter（eventId=%s, %s）', doc.eventId, errorText)
        await store.markDead(doc, errorText, now())
      }
    }
  })
  await Promise.all(workers)
  return delivered
}

/**
 * 启动周期投递器（返回停止函数）。由 apply() 用 ctx.interval 挂载，
 * 单轮互斥（进行中则跳过），避免慢远端导致轮次堆积。
 */
export function startDeliveryLoop(deps: DeliveryDeps & { intervalMs: number }): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    runDeliveryRound(deps).catch((error) => {
      ;(deps.log ?? console).error('club-bridge: 投递轮失败', error)
    }).finally(() => {
      running = false
    })
  }, Math.max(1_000, deps.intervalMs))
  timer.unref?.()
  return () => clearInterval(timer)
}
