import { randomBytes } from 'node:crypto'
import {
  canonicalPathAndQuery,
  hydroCanonical,
  hydroSign,
  hydroVerify,
  HYDRO_HEADER_NAMES,
  isAcceptableNonce,
  sha256Hex,
  timestampInRange,
  EMPTY_BODY_SHA256,
  type HydroCanonicalInput,
} from './contracts.js'

/**
 * HYDRO-BRIDGE-V1 HMAC 的两端封装（与主系统 packages/integrations/src/hydro-protocol.ts
 * 保持同一 canonical 实现，见 src/contracts.ts 顶部的双端同步说明）。
 */

export interface WebhookAuthHeaders {
  'X-Hydro-Key-Id': string
  'X-Hydro-Instance-Id': string
  'X-Hydro-Timestamp': string
  'X-Hydro-Nonce': string
  'X-Hydro-Signature': string
  'Content-Type': 'application/json; charset=utf-8'
}

/**
 * 生成一次投递的签名头。每次（含重试）生成新的 timestamp 与 nonce；
 * 签名覆盖原始 body 字节的 SHA-256，body 由调用方序列化一次后复用同一 Buffer。
 */
export function buildWebhookAuthHeaders(input: {
  keyId: string
  instanceId: string
  bodyBuffer: Buffer
  secret: string
  now?: Date
  nonce?: string
}): WebhookAuthHeaders {
  const timestamp = String(Math.floor((input.now ?? new Date()).getTime() / 1000))
  const nonce = input.nonce ?? newNonce()
  const canonical = hydroCanonical({
    direction: 'hydro-to-club',
    keyId: input.keyId,
    instanceId: input.instanceId,
    timestamp,
    nonce,
    method: 'POST',
    pathAndQuery: '/api/v1/integrations/hydro/events',
    bodySha256: sha256Hex(input.bodyBuffer),
  })
  return {
    'X-Hydro-Key-Id': input.keyId,
    'X-Hydro-Instance-Id': input.instanceId,
    'X-Hydro-Timestamp': timestamp,
    'X-Hydro-Nonce': nonce,
    'X-Hydro-Signature': hydroSign(canonical, input.secret),
    'Content-Type': 'application/json; charset=utf-8',
  }
}

/** 128 位随机 nonce，base64url 编码 */
export function newNonce(): string {
  return randomBytes(16).toString('base64url')
}

export type PullVerifyFailureCode =
  | 'METHOD_NOT_ALLOWED'
  | 'BODY_NOT_EMPTY'
  | 'SIG_HEADER_MISSING'
  | 'KEY_MISMATCH'
  | 'TIMESTAMP_OUT_OF_RANGE'
  | 'NONCE_WEAK'
  | 'NONCE_REPLAY'
  | 'QUERY_NOT_CANONICAL'
  | 'SIGNATURE_INVALID'

export interface PullVerifyDeps {
  keyId: string
  instanceId: string
  secret: string
  /** nonce 防重放：成功消费返回 true，重复/写入失败返回 false（键含 instanceId+keyId+nonce） */
  tryConsumeNonce: (nonceKey: string, expiresAt: Date) => Promise<boolean>
  now?: Date
  /** 时间窗（秒），默认 ±300，与主系统一致 */
  toleranceSec?: number
}

/**
 * club-to-hydro 机器 GET 请求验证（07 方案 5.2/7）：
 * 头齐全 → keyId/instanceId 匹配 → 时间窗 → query 唯一规范形式 → HMAC（恒定时间比较）
 * → nonce 防重放。GET body 为空字节，canonical 使用 sha256('')。
 * rawPath 必须是请求在线上的原始路径（含 /d/{domainId} 前缀，若使用）。
 */
export async function verifyMachineGetRequest(
  request: {
    method: string
    rawPath: string
    rawQuery?: string | null
    headers: Record<string, unknown>
    allowedQueryKeys: readonly string[]
  },
  deps: PullVerifyDeps,
): Promise<{ ok: true; canonical: string } | { ok: false; code: PullVerifyFailureCode; message: string }> {
  if (request.method.toUpperCase() !== 'GET') {
    return { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'club-bridge 只读接口仅接受 GET' }
  }
  if (request.headers['content-encoding'] || request.headers['transfer-encoding'] || (request.headers['content-length'] !== undefined && String(request.headers['content-length']) !== '0')) {
    return { ok: false, code: 'BODY_NOT_EMPTY', message: '签名 GET 仅接受空 body，拒绝压缩/流式请求' }
  }
  const header = (name: string): string => {
    const v = request.headers[name.toLowerCase()]
    if (Array.isArray(v)) return v.length === 1 ? String(v[0]) : ''
    return v === undefined || v === null ? '' : String(v)
  }
  const keyId = header(HYDRO_HEADER_NAMES.keyId)
  const instanceId = header(HYDRO_HEADER_NAMES.instanceId)
  const timestamp = header(HYDRO_HEADER_NAMES.timestamp)
  const nonce = header(HYDRO_HEADER_NAMES.nonce)
  const signature = header(HYDRO_HEADER_NAMES.signature)
  if (!keyId || !instanceId || !timestamp || !nonce || !signature) {
    return { ok: false, code: 'SIG_HEADER_MISSING', message: '缺少 X-Hydro-* 签名头' }
  }
  if (keyId !== deps.keyId || instanceId !== deps.instanceId) {
    return { ok: false, code: 'KEY_MISMATCH', message: 'keyId/instanceId 未登记' }
  }
  const now = deps.now ?? new Date()
  if (!timestampInRange(timestamp, now.getTime(), deps.toleranceSec ?? 300)) {
    return { ok: false, code: 'TIMESTAMP_OUT_OF_RANGE', message: '时间戳超出 ±300 秒窗口' }
  }
  if (!isAcceptableNonce(nonce)) {
    return { ok: false, code: 'NONCE_WEAK', message: 'nonce 至少 128 位随机值' }
  }
  const pathAndQuery = canonicalPathAndQuery(request.rawPath, request.rawQuery, request.allowedQueryKeys)
  if (pathAndQuery === null) {
    return { ok: false, code: 'QUERY_NOT_CANONICAL', message: 'query 不符合唯一规范形式（声明字段/排序/编码）' }
  }
  const canonicalInput: HydroCanonicalInput = {
    direction: 'club-to-hydro',
    keyId,
    instanceId,
    timestamp,
    nonce,
    method: 'GET',
    pathAndQuery,
    bodySha256: EMPTY_BODY_SHA256,
  }
  const canonical = hydroCanonical(canonicalInput)
  if (!hydroVerify(canonical, signature, deps.secret)) {
    return { ok: false, code: 'SIGNATURE_INVALID', message: '签名不匹配' }
  }
  const expiresAt = new Date(Math.max(now.getTime(), Number(timestamp) * 1000) + ((deps.toleranceSec ?? 300) * 2 + 60) * 1000)
  const consumed = await deps.tryConsumeNonce(`${instanceId}:${keyId}:${nonce}`, expiresAt)
  if (!consumed) {
    return { ok: false, code: 'NONCE_REPLAY', message: 'nonce 重放' }
  }
  return { ok: true, canonical }
}
