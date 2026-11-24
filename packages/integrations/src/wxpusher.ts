import { safeFetch, SafeFetchError } from './safe-fetch.js'

const WXPUSHER_API_BASE = 'https://wxpusher.zjiecode.com'
const WXPUSHER_ALLOWED_HOSTS = ['wxpusher.zjiecode.com'] as const
const WXPUSHER_QR_IMAGE_HOSTS = ['mp.weixin.qq.com', 'wxpusher.zjiecode.com'] as const

export class WxPusherError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(message)
  }
}

export interface WxPusherQrCodeResult {
  code: string
  extra: string
  url: string
  shortUrl: string
  expiresAt: Date
}

export interface WxPusherSendInput {
  appToken: string
  content: string
  summary?: string
  /** 1=文本 2=HTML 3=Markdown */
  contentType?: 1 | 2 | 3
  uids?: string[]
  topicIds?: number[]
  url?: string
  verifyPay?: boolean
}

export interface WxPusherSendRecord {
  uid?: string
  topicId?: number
  messageId?: number
  messageContentId?: number
  sendRecordId?: number
  code?: number
  status?: string
}

export interface WxPusherSendResult {
  records: WxPusherSendRecord[]
  acceptedCount: number
  failedCount: number
}

interface WxPusherEnvelope<T> {
  code?: number
  msg?: string
  data?: T
  success?: boolean
}

function parseEnvelope<T>(rawText: string, httpStatus: number): T {
  let parsed: WxPusherEnvelope<T>
  try {
    parsed = JSON.parse(rawText) as WxPusherEnvelope<T>
  } catch {
    throw new WxPusherError(`WxPusher 响应不是合法 JSON（HTTP ${httpStatus}）`, 'INVALID_JSON', httpStatus >= 500)
  }
  if (httpStatus >= 500) {
    throw new WxPusherError(parsed.msg || `WxPusher 服务暂时不可用（HTTP ${httpStatus}）`, 'UPSTREAM_5XX', true)
  }
  if (parsed.code !== 1000) {
    const code = parsed.code != null ? `WXPUSHER_${parsed.code}` : 'WXPUSHER_ERROR'
    // 1002/1003/1008 等常见限流或临时错误允许重试，参数/Token 错误不重试
    const retryable = parsed.code === 1002 || parsed.code === 1008 || httpStatus === 429
    throw new WxPusherError(parsed.msg || `WxPusher 请求失败（code=${parsed.code ?? 'unknown'}）`, code, retryable)
  }
  return parsed.data as T
}

/**
 * 创建带参数绑定二维码（POST /api/fun/create/qrcode）：
 * - extra 最长 64 字符，由调用方传入一次性随机绑定 token，禁止传明文 userId。
 * - validTime 单位秒，默认 900 秒（15 分钟）。
 */
export async function createWxPusherQrCode(input: {
  appToken: string
  extra: string
  validTime?: number
}): Promise<WxPusherQrCodeResult> {
  if (!input.appToken.trim()) throw new WxPusherError('未配置 WXPUSHER_APP_TOKEN', 'NOT_CONFIGURED', false)
  if (!input.extra || input.extra.length > 64) {
    throw new WxPusherError('extra 长度必须在 1–64 字符之间', 'INVALID_EXTRA', false)
  }
  const validTime = Math.min(Math.max(Math.round(input.validTime ?? 900), 60), 30 * 24 * 3600)
  try {
    const res = await safeFetch(`${WXPUSHER_API_BASE}/api/fun/create/qrcode`, {
      allowedHosts: WXPUSHER_ALLOWED_HOSTS,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appToken: input.appToken.trim(),
        extra: input.extra,
        validTime,
      }),
      timeoutMs: 12_000,
      maxBytes: 256 * 1024,
    })
    const data = parseEnvelope<{
      expires?: number
      code?: string
      shortUrl?: string
      link?: string
      extra?: string
      url?: string
    }>(res.text, res.status)
    const url = data?.url ?? ''
    const shortUrl = data?.shortUrl ?? data?.link ?? ''
    if (!url && !shortUrl) {
      throw new WxPusherError('WxPusher 未返回二维码地址', 'EMPTY_QR_RESPONSE', false)
    }
    const expiresAt = typeof data?.expires === 'number' && data.expires > Date.now()
      ? new Date(data.expires)
      : new Date(Date.now() + validTime * 1000)
    return {
      code: data?.code ?? '',
      extra: data?.extra ?? input.extra,
      url,
      shortUrl,
      expiresAt,
    }
  } catch (error) {
    if (error instanceof WxPusherError) throw error
    if (error instanceof SafeFetchError) {
      throw new WxPusherError(error.message, error.code, error.code === 'TIMEOUT' || error.code === 'NETWORK')
    }
    throw new WxPusherError(error instanceof Error ? error.message : 'WxPusher 调用失败', 'UNKNOWN', true)
  }
}

/**
 * 将微信官方二维码图片拉取为 data URL，兼容站内严格 CSP（img-src 'self' data:）。
 * 失败时返回 null，调用方可回退为基于 shortUrl 本地生成二维码。
 */
export async function fetchWxPusherQrImageDataUrl(imageUrl: string): Promise<string | null> {
  if (!imageUrl) return null
  try {
    const parsed = new URL(imageUrl)
    if (parsed.protocol !== 'https:' || !WXPUSHER_QR_IMAGE_HOSTS.includes(parsed.hostname as (typeof WXPUSHER_QR_IMAGE_HOSTS)[number])) {
      return null
    }
    const res = await safeFetch(imageUrl, {
      allowedHosts: WXPUSHER_QR_IMAGE_HOSTS,
      method: 'GET',
      headers: { accept: 'image/png, image/jpeg, image/webp, image/*;q=0.8' },
      timeoutMs: 10_000,
      maxBytes: 512 * 1024,
      expectContentTypes: ['image/'],
    })
    if (res.status !== 200 || res.bytes.byteLength === 0) return null
    const mime = res.contentType.split(';')[0]?.trim() || 'image/jpeg'
    return `data:${mime};base64,${Buffer.from(res.bytes).toString('base64')}`
  } catch {
    return null
  }
}

/**
 * 发送 WxPusher 消息（POST /api/send/message）：
 * - 单次请求最多支持 2000 个 uids 或 5 个 topicIds；
 * - summary 最长 100 字符，url 最长 400 字符。
 */
export async function sendWxPusherMessage(input: WxPusherSendInput): Promise<WxPusherSendResult> {
  if (!input.appToken.trim()) throw new WxPusherError('未配置 WXPUSHER_APP_TOKEN', 'NOT_CONFIGURED', false)
  const uids = (input.uids ?? []).map((u) => u.trim()).filter(Boolean)
  const topicIds = (input.topicIds ?? []).filter((id) => Number.isInteger(id) && id > 0)
  if (uids.length === 0 && topicIds.length === 0) {
    return { records: [], acceptedCount: 0, failedCount: 0 }
  }
  const body: Record<string, unknown> = {
    appToken: input.appToken.trim(),
    content: input.content.slice(0, 35_000),
    contentType: input.contentType ?? 3,
    verifyPay: input.verifyPay ?? false,
  }
  if (input.summary?.trim()) body.summary = input.summary.trim().slice(0, 100)
  if (uids.length > 0) body.uids = uids
  if (topicIds.length > 0) body.topicIds = topicIds
  if (input.url?.trim() && input.url.trim().length <= 400) {
    body.url = input.url.trim()
  }

  try {
    const res = await safeFetch(`${WXPUSHER_API_BASE}/api/send/message`, {
      allowedHosts: WXPUSHER_ALLOWED_HOSTS,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 12_000,
      maxBytes: 512 * 1024,
    })
    const data = parseEnvelope<WxPusherSendRecord[]>(res.text, res.status)
    const records = Array.isArray(data) ? data : []
    let acceptedCount = 0
    let failedCount = 0
    for (const rec of records) {
      if (rec.code === 1000) acceptedCount++
      else failedCount++
    }
    return { records, acceptedCount, failedCount }
  } catch (error) {
    if (error instanceof WxPusherError) throw error
    if (error instanceof SafeFetchError) {
      throw new WxPusherError(error.message, error.code, error.code === 'TIMEOUT' || error.code === 'NETWORK')
    }
    throw new WxPusherError(error instanceof Error ? error.message : 'WxPusher 发送失败', 'UNKNOWN', true)
  }
}
