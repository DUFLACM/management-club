import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Hydro Bridge 协议常量（07 方案 5）。
 *
 * ⚠️ 双端同步契约：本文件与主系统 packages/integrations/src/hydro-protocol.ts 的
 * hydroCanonical/hydroSign/hydroVerify 是同一实现的有意复制（插件作为独立 npm 包
 * 不跨包 import 主系统代码）。任何一端修改 canonical 布局、哈希或编码时必须同步
 * 另一端，并用 tests/ 下的 fixture 交叉验证（tests 直接 import 主系统源文件做
 * hydroVerify 断言）。
 *
 * 契约：HYDRO-BRIDGE-V1 + direction/keyId/instanceId/timestamp/nonce/METHOD/path/bodySha256，
 * 各行 UTF-8 字节以单个 LF 连接、无末尾 LF；HMAC-SHA256 输出 base64url；比较恒定时间。
 */

export interface HydroCanonicalInput {
  direction: 'hydro-to-club' | 'club-to-hydro'
  keyId: string
  instanceId: string
  timestamp: string
  nonce: string
  method: string
  pathAndQuery: string
  bodySha256: string
}

export function hydroCanonical(input: HydroCanonicalInput): string {
  return ['HYDRO-BRIDGE-V1', input.direction, input.keyId, input.instanceId, input.timestamp, input.nonce, input.method.toUpperCase(), input.pathAndQuery, input.bodySha256].join('\n')
}

export function hydroSign(canonical: string, secret: string): string {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('base64url')
}

export function hydroVerify(canonical: string, signature: string, secret: string): boolean {
  const expected = hydroSign(canonical, secret)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** webhook 事件负载 schema（与主系统 HydroService.receiveWebhook 的 zod schema 一致） */
export interface HydroEventPayload {
  schemaVersion: 1
  eventId: string
  instanceId: string
  domainId: string
  kind: string
  resource: Record<string, unknown>
  revision: number
  snapshotHash?: string
  observedAt: string
  sourceVersion?: string
}

/** 主系统 webhook 端点（固定路径，POST，不接受 query） */
export const WEBHOOK_PATH = '/api/v1/integrations/hydro/events'

/** club-bridge 只读路由前缀（与 packages/integrations/src/hydro-protocol.ts 的 CLUB_BRIDGE_ROUTES 保持一致） */
export const CLUB_BRIDGE_ROUTES = {
  capabilities: '/club-bridge/v1/capabilities',
  contests: '/club-bridge/v1/contests',
  contest: (tid: string) => `/club-bridge/v1/contests/${tid}`,
  participants: (tid: string) => `/club-bridge/v1/contests/${tid}/participants`,
  records: (tid: string) => `/club-bridge/v1/contests/${tid}/records`,
  results: (tid: string) => `/club-bridge/v1/contests/${tid}/results`,
} as const

/** 签名头名称（小写；HTTP/1.1 与 HTTP/2 下读取统一用小写） */
export const HYDRO_HEADER_NAMES = {
  keyId: 'x-hydro-key-id',
  instanceId: 'x-hydro-instance-id',
  timestamp: 'x-hydro-timestamp',
  nonce: 'x-hydro-nonce',
  signature: 'x-hydro-signature',
} as const

/** GET 空 body 的 SHA-256（e3b0c442...b7852b855，RFC 8017 空串哈希） */
export const EMPTY_BODY_SHA256 = sha256Hex('')

/** 原始字节的 SHA-256 小写 hex */
export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 稳定 JSON 序列化：对象键按 UTF-16 码元升序排序、无空白；用于源快照哈希与分页快照哈希 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((i) => stableStringify(i)).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`
}

/**
 * RFC 3986 percent-encoding：仅 A-Za-z0-9-._~ 不转义，其余全部 %XX（大写 hex）。
 * encodeURIComponent 不转义 !'()*，需补齐；GET pull 的 query 唯一形式要求两端一致。
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * 校验原始 query string 是否为唯一规范形式，并返回 canonical pathAndQuery。
 * 规则（07 方案 5.2）：仅允许声明字段、拒绝重复键、按键排序、严格 RFC 3986 编码、k=v 形式。
 * 返回 null 表示不符合唯一形式（拒绝请求），不做任何归一化后放行。
 */
export function canonicalPathAndQuery(
  path: string,
  rawQuery: string | undefined | null,
  allowedKeys: readonly string[],
): string | null {
  if (!path || !path.startsWith('/') || path.includes('#')) return null
  if (rawQuery === undefined || rawQuery === null || rawQuery === '') return path
  const allowed = new Set(allowedKeys)
  const parts = rawQuery.split('&')
  const seen = new Set<string>()
  let lastKey = ''
  for (const part of parts) {
    if (part === '') return null
    const eq = part.indexOf('=')
    if (eq <= 0) return null // 缺 '=' 或空键
    const key = part.slice(0, eq)
    const value = part.slice(eq + 1)
    if (!isCanonicalEncoded(key) || !isCanonicalEncoded(value)) return null
    if (seen.has(key)) return null
    if (!allowed.has(key)) return null
    if (key < lastKey) return null // 必须已按键升序排列
    seen.add(key)
    lastKey = key
  }
  return `${path}?${rawQuery}`
}

/** 判断 s 是否已是严格 RFC 3986 编码形式（decode→re-encode 结果与原串一致） */
function isCanonicalEncoded(s: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(s)
  } catch {
    return false
  }
  return percentEncode(decoded) === s
}

/** unix 秒时间戳是否在窗口内（默认 ±300 秒，与主系统一致） */
export function timestampInRange(timestamp: string, nowMs = Date.now(), toleranceSec = 300): boolean {
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || !/^\d+$/.test(timestamp)) return false
  return Math.abs(nowMs / 1000 - ts) <= toleranceSec
}

/** nonce 至少 128 位随机值（base64url/hex 至少 16/32 字符，拒绝弱值） */
export function isAcceptableNonce(nonce: string): boolean {
  return typeof nonce === 'string' && nonce.length >= 22 && /^[A-Za-z0-9\-_]+$/.test(nonce)
}
