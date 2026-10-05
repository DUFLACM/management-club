import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { loadEnv } from '../../config/env.js'

/**
 * 受控出站 HTTP（平台适配器专用）：
 * - 仅允许显式白名单主机；HTTPS；端口固定。
 * - 禁止跟随重定向（或逐跳校验）；解析 DNS 后拒绝环回/私网/链路本地/保留地址与云元数据目标（防 SSRF/DNS rebinding）。
 * - 超时、解压后响应大小限制、内容类型校验。
 * - 配合 PostgreSQL outbound_rate_limits 表实现跨 Worker 共享限流（调用方 ensureRateLimit）。
 */

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
  /^192\.0\0\./,
  /^198\.1[89]\./,
]
const CLOUD_METADATA = [/^169\.254\.169\.254$/, /^fd00:ec2::254$/]

export class SafeFetchError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7))
    return false
  }
  if (CLOUD_METADATA.some((re) => re.test(ip))) return true
  return PRIVATE_V4.some((re) => re.test(ip))
}

export interface SafeFetchOptions {
  /** 主机白名单（适配器固定主机；Hydro 允许已登记主机） */
  allowedHosts: readonly string[]
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxBytes?: number
  /** 预期内容类型（子串匹配） */
  expectContentTypes?: string[]
  /** 受控配置固定公网解析；保留原始主机的 SNI 与 TLS 证书校验。不得来自浏览器输入。 */
  connectAddress?: string
}

export interface SafeFetchResult {
  status: number
  contentType: string
  bytes: Uint8Array
  text: string
  elapsedMs: number
}

export async function safeFetch(url: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const env = loadEnv()
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') throw new SafeFetchError('仅允许 HTTPS 出站', 'SCHEME_NOT_ALLOWED')
  if (!opts.allowedHosts.includes(parsed.hostname)) {
    throw new SafeFetchError(`出站主机不在白名单: ${parsed.hostname}`, 'HOST_NOT_ALLOWED')
  }
  if (parsed.port && parsed.port !== '443') throw new SafeFetchError('仅允许 443 端口', 'PORT_NOT_ALLOWED')

  // DNS 解析后拒绝私网/保留地址（防 DNS rebinding；解析与实际请求间隔内仍由网络策略兜底）
  try {
    if (opts.connectAddress && !isIP(opts.connectAddress)) throw new SafeFetchError('固定解析必须为合法 IP 地址', 'INVALID_CONNECT_ADDRESS')
    const records = opts.connectAddress ? [{ address: opts.connectAddress }] : await lookup(parsed.hostname, { all: true })
    for (const r of records) {
      if (isPrivateAddress(r.address)) {
        throw new SafeFetchError('解析到禁止访问的地址', 'PRIVATE_ADDRESS')
      }
    }
  } catch (e) {
    if (e instanceof SafeFetchError) throw e
    throw new SafeFetchError('DNS 解析失败', 'DNS_FAILURE')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? env.OUTBOUND_TIMEOUT_MS)
  const started = Date.now()
  try {
    if (opts.connectAddress) {
      const result = await requestPinnedHttps(parsed, opts, controller.signal, opts.maxBytes ?? env.OUTBOUND_MAX_JSON_BYTES)
      return { ...result, elapsedMs: Date.now() - started }
    }
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: { 'user-agent': 'dlufl-acm-club-sync/0.1 (+club.example.edu)', accept: 'application/json, text/html;q=0.9', ...opts.headers },
      body: opts.body,
      redirect: 'manual', // 不跟随重定向
      signal: controller.signal,
    })
    if (res.status >= 300 && res.status < 400) {
      throw new SafeFetchError(`重定向被拒绝（${res.status}）`, 'REDIRECT_BLOCKED')
    }
    const contentType = res.headers.get('content-type') ?? ''
    if (opts.expectContentTypes && !opts.expectContentTypes.some((t) => contentType.includes(t))) {
      throw new SafeFetchError(`内容类型不符: ${contentType}`, 'CONTENT_TYPE')
    }
    const declaredLength = Number(res.headers.get('content-length') ?? '0')
    const maxBytes = opts.maxBytes ?? env.OUTBOUND_MAX_JSON_BYTES
    if (declaredLength && declaredLength > maxBytes) {
      throw new SafeFetchError(`响应超过大小限制（${declaredLength} > ${maxBytes}）`, 'RESPONSE_TOO_LARGE')
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > maxBytes) {
      throw new SafeFetchError(`响应解压后超过大小限制（${buf.byteLength}）`, 'RESPONSE_TOO_LARGE')
    }
    return {
      status: res.status,
      contentType,
      bytes: buf,
      text: new TextDecoder('utf-8').decode(buf),
      elapsedMs: Date.now() - started,
    }
  } catch (e) {
    if (e instanceof SafeFetchError) throw e
    if ((e as Error).name === 'AbortError') throw new SafeFetchError('出站请求超时', 'TIMEOUT')
    throw new SafeFetchError(`出站请求失败: ${(e as Error).message}`, 'NETWORK')
  } finally {
    clearTimeout(timeout)
  }
}

/** 固定已校验的公网 IP，HTTPS hostname 与证书验证始终使用配置域名。 */
async function requestPinnedHttps(url: URL, opts: SafeFetchOptions, signal: AbortSignal, maxBytes: number): Promise<Omit<SafeFetchResult, 'elapsedMs'>> {
  const address = opts.connectAddress!
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: opts.method ?? 'GET',
      headers: { 'user-agent': 'dlufl-acm-club-sync/0.1', accept: 'application/xml, application/json, text/html;q=0.9', ...opts.headers },
      family: isIP(address),
      lookup: (_hostname, _options, callback) => callback(null, address, isIP(address)),
      servername: url.hostname,
      rejectUnauthorized: true,
      signal,
    }, (response) => {
      const status = response.statusCode ?? 500
      const contentType = response.headers['content-type'] ?? ''
      if (status >= 300 && status < 400) {
        request.destroy(new SafeFetchError(`重定向被拒绝（${status}）`, 'REDIRECT_BLOCKED'))
        return
      }
      if (opts.expectContentTypes && !opts.expectContentTypes.some((type) => contentType.includes(type))) {
        request.destroy(new SafeFetchError(`内容类型不符: ${contentType}`, 'CONTENT_TYPE'))
        return
      }
      if (Number(response.headers['content-length'] ?? 0) > maxBytes) {
        request.destroy(new SafeFetchError('响应超过大小限制', 'RESPONSE_TOO_LARGE'))
        return
      }
      const chunks: Buffer[] = []
      let bytesRead = 0
      response.on('data', (chunk: Buffer) => {
        bytesRead += chunk.length
        if (bytesRead > maxBytes) request.destroy(new SafeFetchError('响应超过大小限制', 'RESPONSE_TOO_LARGE'))
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        try {
          let bytes: Buffer = Buffer.concat(chunks)
          const encoding = response.headers['content-encoding']
          if (encoding === 'gzip') bytes = gunzipSync(bytes, { maxOutputLength: maxBytes })
          else if (encoding === 'deflate') bytes = inflateSync(bytes, { maxOutputLength: maxBytes })
          else if (encoding === 'br') bytes = brotliDecompressSync(bytes, { maxOutputLength: maxBytes })
          else if (encoding && encoding !== 'identity') throw new SafeFetchError('响应压缩格式不受支持', 'CONTENT_ENCODING')
          if (bytes.length > maxBytes) throw new SafeFetchError('响应解压后超过大小限制', 'RESPONSE_TOO_LARGE')
          resolve({ status, contentType, bytes, text: bytes.toString('utf8') })
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('error', reject)
    request.end(opts.body)
  })
}

/** 平台固定主机白名单（05 方案 8；Hydro 主机单独由 connector 配置） */
export const PLATFORM_HOSTS = {
  nowcoder: ['ac.nowcoder.com'],
  codeforces: ['codeforces.com'],
  atcoder: ['atcoder.jp'],
  atcoderProblems: ['kenkoooo.com'],
} as const
