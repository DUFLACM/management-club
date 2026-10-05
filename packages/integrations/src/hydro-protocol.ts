import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Hydro Bridge 协议常量（07 方案 5）：API 与 Worker 共享的 canonical/签名实现。
 * 契约：HYDRO-BRIDGE-V1 + direction/keyId/instanceId/timestamp/nonce/METHOD/path/bodySha256，
 * 以单个 LF 连接、无末尾 LF；HMAC-SHA256 base64url；恒定时间比较。
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

/** webhook 事件负载 schema（与主系统 HydroService 一致；Worker fixture 测试共用） */
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

/** club-bridge 只读路由前缀（插件侧注册，主系统 pull 使用） */
export const CLUB_BRIDGE_ROUTES = {
  capabilities: '/club-bridge/v1/capabilities',
  contests: '/club-bridge/v1/contests',
  contest: (tid: string) => `/club-bridge/v1/contests/${tid}`,
  participants: (tid: string) => `/club-bridge/v1/contests/${tid}/participants`,
  records: (tid: string) => `/club-bridge/v1/contests/${tid}/records`,
  results: (tid: string) => `/club-bridge/v1/contests/${tid}/results`,
} as const
