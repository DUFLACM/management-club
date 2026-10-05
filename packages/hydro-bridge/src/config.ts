import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WEBHOOK_PATH } from './contracts.js'

/**
 * bridge 配置：环境变量 HYDROOJ_CLUB_* 优先，其次 addon 配置文件
 * （HYDROOJ_CLUB_CONFIG 指定路径，默认 ~/.hydro/club-bridge.json）。
 * secret 只在本进程与 Hydro 配置存储中出现，不得写入日志。
 */

export interface BridgeConfig {
  /** 校方登记的稳定实例 UUID（同一集群所有副本一致） */
  instanceId: string
  /** 主系统固定基址（webhook 固定发往 {endpoint}/api/v1/integrations/hydro/events） */
  endpoint: string
  /** 推送方向 keyId（与主系统 secret_reference 登记 pushKeyId 一致） */
  pushKeyId: string
  /** 推送方向 HMAC secret（≥32 字节随机） */
  pushSecret: string
  /** 回拉方向 keyId（主系统 Worker pull 签名用） */
  pullKeyId: string
  /** 回拉方向 HMAC secret（与推送分开） */
  pullSecret: string
  /** 允许同步的 Hydro 域（domainId 列表） */
  allowedDomains: string[]
  /** 专用只读 Hydro 服务账号 uid；HMAC 身份不授予此账号之外的权限。 */
  serviceAccountUid: number
  /** 允许导出的受限比赛（docId hex 列表；受限赛不在列表内则只返回存在性标记） */
  allowedContests: string[]
  /** 是否允许导出受限（assign/口令）比赛内容 */
  allowPrivateContests: boolean
  delivery: {
    /** 投递器轮询间隔（毫秒） */
    intervalMs: number
    /** 单轮最多领取条数 */
    batchSize: number
    /** 并发 HTTP 投递上限 */
    concurrency: number
    /** 单次请求超时（毫秒） */
    timeoutMs: number
  }
  refresh: {
    /** 脏资源刷新轮询间隔（毫秒） */
    intervalMs: number
    /** 单轮最多刷新资源数 */
    batchSize: number
  }
  /** 全量核对：启动与周期扫描时回看的比赛时间窗口（天） */
  sweepLookbackDays: number
  /** 周期全量标记间隔（毫秒，0 关闭） */
  sweepIntervalMs: number
}

export interface ConfigIssues {
  errors: string[]
  warnings: string[]
}

export const DEFAULT_ENDPOINT = 'https://club.example.edu.cn'

function readFileConfig(file: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return {}
  } catch {
    return {}
  }
}

function str(source: Record<string, unknown>, key: string, envKey: string): string | undefined {
  const fromEnv = process.env[envKey]
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  const v = source[key]
  if (typeof v === 'string' && v !== '') return v
  return undefined
}

function num(source: Record<string, unknown>, key: string, envKey: string): number | undefined {
  const fromEnv = process.env[envKey]
  if (fromEnv !== undefined && fromEnv !== '' && Number.isFinite(Number(fromEnv))) return Number(fromEnv)
  const v = source[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return undefined
}

function bool(source: Record<string, unknown>, key: string, envKey: string): boolean | undefined {
  const fromEnv = process.env[envKey]
  if (fromEnv !== undefined) return fromEnv === '1' || fromEnv.toLowerCase() === 'true'
  const v = source[key]
  if (typeof v === 'boolean') return v
  return undefined
}

function list(source: Record<string, unknown>, key: string, envKey: string): string[] | undefined {
  if (!process.env[envKey] && Array.isArray(source[key])) {
    return Array.from(new Set((source[key] as unknown[]).filter((value): value is string => typeof value === 'string' && value.trim() !== '').map((value) => value.trim())))
  }
  const raw = str(source, key, envKey)
  if (raw === undefined) return undefined
  const items = raw.split(',').map((i) => i.trim()).filter(Boolean)
  return items.length ? Array.from(new Set(items)) : undefined
}

/** 读取配置（环境变量 > 配置文件 > 默认值）。不抛异常，问题通过 validate 汇报。 */
export function loadConfig(): { config: BridgeConfig; issues: ConfigIssues } {
  const file = process.env.HYDROOJ_CLUB_CONFIG || path.resolve(os.homedir(), '.hydro', 'club-bridge.json')
  const source = readFileConfig(file)
  const sourceDelivery = (source.delivery && typeof source.delivery === 'object' ? source.delivery : {}) as Record<string, unknown>
  const sourceRefresh = (source.refresh && typeof source.refresh === 'object' ? source.refresh : {}) as Record<string, unknown>

  const instanceId = str(source, 'instanceId', 'HYDROOJ_CLUB_INSTANCE_ID') ?? ''
  const endpoint = (str(source, 'endpoint', 'HYDROOJ_CLUB_ENDPOINT') ?? DEFAULT_ENDPOINT).replace(/\/+$/, '')
  const pushSecret = str(source, 'pushSecret', 'HYDROOJ_CLUB_PUSH_SECRET') ?? ''
  const pullSecret = str(source, 'pullSecret', 'HYDROOJ_CLUB_PULL_SECRET') ?? ''

  const config: BridgeConfig = {
    instanceId,
    endpoint,
    pushKeyId: str(source, 'pushKeyId', 'HYDROOJ_CLUB_PUSH_KEY_ID') ?? `hydro:${instanceId}`,
    pushSecret,
    pullKeyId: str(source, 'pullKeyId', 'HYDROOJ_CLUB_PULL_KEY_ID') ?? `hydro-pull:${instanceId}`,
    pullSecret,
    allowedDomains: list(source, 'allowedDomains', 'HYDROOJ_CLUB_ALLOWED_DOMAINS') ?? [],
    serviceAccountUid: num(source, 'serviceAccountUid', 'HYDROOJ_CLUB_SERVICE_ACCOUNT_UID') ?? 0,
    allowedContests: list(source, 'allowedContests', 'HYDROOJ_CLUB_ALLOWED_CONTESTS') ?? [],
    allowPrivateContests: bool(source, 'allowPrivateContests', 'HYDROOJ_CLUB_ALLOW_PRIVATE_CONTESTS') ?? false,
    delivery: {
      intervalMs: num(sourceDelivery, 'intervalMs', 'HYDROOJ_CLUB_DELIVERY_INTERVAL_MS') ?? 5_000,
      batchSize: num(sourceDelivery, 'batchSize', 'HYDROOJ_CLUB_DELIVERY_BATCH_SIZE') ?? 20,
      concurrency: num(sourceDelivery, 'concurrency', 'HYDROOJ_CLUB_DELIVERY_CONCURRENCY') ?? 4,
      timeoutMs: num(sourceDelivery, 'timeoutMs', 'HYDROOJ_CLUB_DELIVERY_TIMEOUT_MS') ?? 10_000,
    },
    refresh: {
      intervalMs: num(sourceRefresh, 'intervalMs', 'HYDROOJ_CLUB_REFRESH_INTERVAL_MS') ?? 15_000,
      batchSize: num(sourceRefresh, 'batchSize', 'HYDROOJ_CLUB_REFRESH_BATCH_SIZE') ?? 50,
    },
    sweepLookbackDays: num(source, 'sweepLookbackDays', 'HYDROOJ_CLUB_SWEEP_LOOKBACK_DAYS') ?? 180,
    sweepIntervalMs: num(source, 'sweepIntervalMs', 'HYDROOJ_CLUB_SWEEP_INTERVAL_MS') ?? 6 * 3600_000,
  }
  return { config, issues: validateConfig(config) }
}

/** 配置校验：errors 非空时插件停用（只告警，不影响 Hydro 运行） */
export function validateConfig(config: BridgeConfig): ConfigIssues {
  const errors: string[] = []
  const warnings: string[] = []
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(config.instanceId)) {
    errors.push('instanceId 未配置或不是合法 UUID（HYDROOJ_CLUB_INSTANCE_ID）')
  }
  try {
    const endpoint = new URL(config.endpoint)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname)) throw new Error('origin required')
  } catch { errors.push('endpoint 必须是无路径/query/凭据的 http(s) origin（HYDROOJ_CLUB_ENDPOINT）') }
  if (config.endpoint.replace(/^https?:\/\//, '').startsWith('club.example.edu.cn')) {
    warnings.push('endpoint 仍为占位默认值 club.example.edu.cn，需替换为主系统真实域名')
  }
  if (/^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/.test(config.endpoint)) {
    warnings.push('endpoint 指向回环地址：仅限本机联调，生产必须为固定主系统域名')
  }
  if (Buffer.byteLength(config.pushSecret, 'utf8') < 32) errors.push('pushSecret 至少 32 字节随机值（HYDROOJ_CLUB_PUSH_SECRET）')
  if (Buffer.byteLength(config.pullSecret, 'utf8') < 32) errors.push('pullSecret 至少 32 字节随机值（HYDROOJ_CLUB_PULL_SECRET）')
  if (![config.pushKeyId, config.pullKeyId].every((key) => typeof key === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(key))) errors.push('pushKeyId/pullKeyId 必须是单行标识符')
  if (config.pushSecret === config.pullSecret) warnings.push('pushSecret 与 pullSecret 相同：07 方案要求两个方向使用不同 secret')
  if (config.allowedDomains.length === 0) errors.push('allowedDomains 未配置（HYDROOJ_CLUB_ALLOWED_DOMAINS，逗号分隔）')
  if (!Number.isSafeInteger(config.serviceAccountUid) || config.serviceAccountUid <= 0) errors.push('serviceAccountUid 必须是已登记的 Hydro 服务账号 uid（HYDROOJ_CLUB_SERVICE_ACCOUNT_UID）')
  for (const [name, value, max] of [
    ['delivery.batchSize', config.delivery.batchSize, 100], ['delivery.concurrency', config.delivery.concurrency, 10],
    ['refresh.batchSize', config.refresh.batchSize, 200], ['sweepLookbackDays', config.sweepLookbackDays, 3660],
  ] as const) if (!Number.isSafeInteger(value) || value < 1 || value > max) errors.push(`${name} 必须是 1~${max} 整数`)
  if (config.delivery.timeoutMs > 10_000 || config.delivery.timeoutMs < 1_000) errors.push('delivery.timeoutMs 必须在 1s~10s，保证批内排队不超出 60s 租约')
  if (config.delivery.batchSize > config.delivery.concurrency * 5) errors.push('delivery.batchSize 不得超过 concurrency × 5，避免领取事件在排队时过期')
  if (config.delivery.timeoutMs < 1_000 || config.delivery.timeoutMs > 60_000) warnings.push('delivery.timeoutMs 建议在 1s~60s（默认 10s）')
  if (config.delivery.intervalMs < 1_000) warnings.push('delivery.intervalMs 过小（<1s）会放大请求，已按 07 方案限速建议保持 ≥1s')
  return { errors, warnings }
}

/** webhook 完整 URL（固定路径，不依提交内容变化） */
export function webhookUrl(config: BridgeConfig): string {
  return `${config.endpoint}${WEBHOOK_PATH}`
}
