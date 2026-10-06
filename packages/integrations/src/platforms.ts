import { loadEnvLike as loadEnv } from './safe-fetch.js'
import { safeFetch, PLATFORM_HOSTS, SafeFetchError } from './safe-fetch.js'
import type { PrismaClient } from '@acm/db'
import { createHash } from 'node:crypto'

function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * 三个公开平台适配器（05 方案；接口均经 2026-10-05 只读核验）：
 * - 牛客：用户参赛历史 JSON（唯一已核验入口；毫秒时间戳；code=0；pageInfo 翻页）
 * - Codeforces：官方 API（秒时间戳；普通赛 standings 只传 contestId；全局 ≥2s 限流）
 * - AtCoder：官方站点 history JSON（ISO+时段时间；ContestScreenName 归一化）
 * 目录能力：CF contest.list 官方 JSON；AtCoder /contests/ HTML；牛客仅按官方 URL/ID 导入。
 */

export interface NormalizedContestRecord {
  externalContestId: string
  name: string
  startTime: Date
  endTime: Date | null
  durationSeconds: number | null
  problemCount: number | null
  fullScore: number | null
  raw: Record<string, unknown>
}

export interface NormalizedParticipationRecord {
  externalContestId: string
  participationType: string
  startTime?: Date
  endTime?: Date | null
  durationSeconds?: number | null
  rank: number | null
  canShowRank: boolean
  score: number | null
  fullScore: number | null
  acceptedCount: number | null
  problemCount: number | null
  rating: number | null
  ratingChange: number | null
  ratingStatus: string | null
  signUpCount: number | null
  userCount: number | null
  raw: Record<string, unknown>
}

export class AdapterError extends Error {
  constructor(message: string, readonly code: string, readonly retryable: boolean) {
    super(message)
  }
}

/** 跨 Worker 共享出站限流（PostgreSQL 行锁短暂占用，不在 HTTP 事务中持有） */
export async function acquireRateSlot(db: PrismaClient, host: string): Promise<void> {
  const env = loadEnv()
  const minIntervalMs = env.OUTBOUND_MIN_INTERVAL_MS
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await db.$queryRaw<Array<{ next_allowed_at: Date }>>`
      UPDATE outbound_rate_limits SET next_allowed_at = GREATEST(now(), next_allowed_at) + (${minIntervalMs} || ' milliseconds')::interval
      WHERE host = ${host}
      RETURNING next_allowed_at - (${minIntervalMs} || ' milliseconds')::interval AS next_allowed_at`
    if (rows.length === 0) {
      await db.$executeRaw`
        INSERT INTO outbound_rate_limits (host, next_allowed_at) VALUES (${host}, now() + (${minIntervalMs} || ' milliseconds')::interval)
        ON CONFLICT (host) DO NOTHING`
      continue
    }
    const waitMs = rows[0].next_allowed_at.getTime() - Date.now()
    if (waitMs > 0 && waitMs < 60_000) await new Promise((r) => setTimeout(r, waitMs + 5))
    return
  }
  throw new AdapterError(`无法获得 ${host} 的出站限流槽`, 'RATE_SLOT', false)
}

async function fetchJson(db: PrismaClient, host: string, url: string, opts: { maxBytes?: number; expect?: string[] } = {}): Promise<unknown> {
  await acquireRateSlot(db, host)
  try {
    const res = await safeFetch(url, {
      allowedHosts: [host],
      expectContentTypes: opts.expect ?? ['application/json'],
      maxBytes: opts.maxBytes,
    })
    return JSON.parse(res.text)
  } catch (e) {
    if (e instanceof SafeFetchError) {
      throw new AdapterError(`${host} 请求失败: ${e.message}`, e.code, ['TIMEOUT', 'NETWORK', 'DNS_FAILURE'].includes(e.code))
    }
    throw e
  }
}

// ============================ 牛客 ============================

export interface NowcoderHistoryPage {
  records: NormalizedParticipationRecord[]
  pageCurrent: number
  pageCount: number
  elementCount: number
}

/** 单页解析（fixtures/nowcoder-sample.json 契约；毫秒时间；fullScore=0 不作分母） */
export function parseNowcoderHistoryPage(body: unknown): NowcoderHistoryPage {
  const envelope = body as { code?: number; msg?: string; data?: { dataList?: unknown[]; pageInfo?: Record<string, number> } }
  if (envelope.code !== 0) {
    throw new AdapterError(`牛客业务错误 code=${envelope.code} msg=${envelope.msg ?? ''}`, 'BIZ_CODE', false)
  }
  const list = envelope.data?.dataList ?? []
  const pageInfo = envelope.data?.pageInfo ?? {}
  const records: NormalizedParticipationRecord[] = list.map((item) => {
    const r = item as Record<string, unknown>
    const ncStart = typeof r.startTime === 'number' ? new Date(r.startTime) : undefined // 毫秒
    const ncEnd = typeof r.endTime === 'number' ? new Date(r.endTime) : null
    return {
      externalContestId: String(r.contestId ?? ''),
      participationType: String(r.participationType ?? 'UNKNOWN'), // 未核验 type 数字枚举，不写死含义
      startTime: ncStart,
      endTime: ncEnd,
      durationSeconds: typeof r.contestDuration === 'number' ? Math.round(r.contestDuration / 1000) : null,
      rank: typeof r.rank === 'number' ? r.rank : null,
      canShowRank: r.canShowRank === true,
      score: typeof r.totalScore === 'number' ? r.totalScore : null,
      fullScore: typeof r.fullScore === 'number' && r.fullScore > 0 ? r.fullScore : null, // fullScore=0 → 未知（禁止除零）
      acceptedCount: typeof r.acceptedCount === 'number' ? r.acceptedCount : null,
      problemCount: typeof r.problemCount === 'number' ? r.problemCount : null,
      rating: typeof r.rating === 'number' ? r.rating : null,
      ratingChange: typeof r.changeValue === 'number' ? r.changeValue : null,
      ratingStatus: typeof r.ratingStatus === 'string' ? r.ratingStatus : null,
      signUpCount: typeof r.signUpCnt === 'number' ? r.signUpCnt : null, // 报名数 ≠ 有效排名人数
      userCount: typeof r.userCount === 'number' ? r.userCount : null,
      raw: r,
    }
  })
  return {
    records,
    pageCurrent: pageInfo.pageCurrent ?? 1,
    pageCount: pageInfo.pageCount ?? 1,
    elementCount: pageInfo.elementCount ?? records.length,
  }
}

/** 翻页拉取用户参赛历史（每页去重；最大 100 页保护；重叠页覆盖） */
export async function fetchNowcoderHistory(db: PrismaClient, uid: string): Promise<{ records: NormalizedParticipationRecord[]; truncated: boolean; snapshotUrl: string }> {
  const host = PLATFORM_HOSTS.nowcoder[0]
  const all = new Map<string, NormalizedParticipationRecord>()
  let truncated = false
  const firstUrl = nowcoderHistoryUrl(uid, 1)
  let page = 1
  let pageCount = 1
  do {
    const url = page === 1 ? firstUrl : nowcoderHistoryUrl(uid, page)
    const body = await fetchJson(db, host, url, { maxBytes: 1024 * 1024 })
    const parsed = parseNowcoderHistoryPage(body)
    if (parsed.pageCurrent !== page) throw new AdapterError(`pageCurrent(${parsed.pageCurrent}) 与请求页(${page})不一致`, 'PAGE_MISMATCH', true)
    pageCount = parsed.pageCount
    for (const rec of parsed.records) {
      const key = `${rec.externalContestId}:${rec.participationType}`
      all.set(key, rec)
    }
    page++
    if (page > 100) {
      truncated = true
      break
    }
  } while (page <= pageCount)
  return { records: [...all.values()], truncated, snapshotUrl: firstUrl }
}

function nowcoderHistoryUrl(uid: string, page: number): string {
  const params = new URLSearchParams({
    token: '',
    uid,
    page: String(page),
    onlyJoinedFilter: 'true',
    searchContestName: '',
    onlyRatingFilter: 'false',
    contestEndFilter: 'true',
  })
  return `https://${PLATFORM_HOSTS.nowcoder[0]}/acm-heavy/acm/contest/profile/contest-joined-history?${params.toString()}`
}

export interface NowcoderRatingPoint {
  contestId: string
  contestName: string | null
  /** 赛后 rating；changeValue 为本次变化（old = rating - changeValue，牛客初始 1000） */
  rating: number
  changeValue: number | null
  rank: number | null
  occurredAt: Date
}

/** 牛客 rating 历史解析（rating-history?uid= 契约：毫秒时间；按时间升序返回） */
export function parseNowcoderRatingHistory(body: unknown): NowcoderRatingPoint[] {
  const envelope = body as { code?: number; msg?: string; data?: unknown[] }
  if (envelope.code !== 0) {
    throw new AdapterError(`牛客业务错误 code=${envelope.code} msg=${envelope.msg ?? ''}`, 'BIZ_CODE', false)
  }
  return (envelope.data ?? [])
    .map((item) => {
      const r = item as Record<string, unknown>
      return {
        contestId: String(r.contestId ?? ''),
        contestName: typeof r.contestName === 'string' ? r.contestName : null,
        rating: typeof r.rating === 'number' ? r.rating : null,
        changeValue: typeof r.changeValue === 'number' ? r.changeValue : null,
        rank: typeof r.rank === 'number' ? r.rank : null,
        occurredAt: typeof r.time === 'number' ? new Date(r.time) : null, // 毫秒
      }
    })
    .filter((p): p is NowcoderRatingPoint => p.contestId !== '' && p.rating != null && p.occurredAt != null)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
}

/** 拉取牛客 rating 历史（公开接口，无需 token；uid 为牛客数字 UID） */
export async function fetchNowcoderRatingHistory(db: PrismaClient, uid: string): Promise<NowcoderRatingPoint[]> {
  const host = PLATFORM_HOSTS.nowcoder[0]
  const url = `https://${host}/acm/contest/rating-history?token=&uid=${encodeURIComponent(uid)}`
  const body = await fetchJson(db, host, url, { maxBytes: 512 * 1024 })
  return parseNowcoderRatingHistory(body)
}

/** 牛客比赛详情导入：读取官方比赛页 HTML 的 window.pageInfo 静态字面量（绝不 eval 页面脚本） */
export async function fetchNowcoderContestMeta(db: PrismaClient, contestId: string): Promise<{ found: boolean; contest: NormalizedContestRecord | null }> {
  const host = PLATFORM_HOSTS.nowcoder[0]
  await acquireRateSlot(db, host)
  const res = await safeFetch(`https://${host}/acm/contest/${encodeURIComponent(contestId)}`, {
    allowedHosts: [host],
    expectContentTypes: ['text/html'],
    maxBytes: 2 * 1024 * 1024,
  }).catch(() => null)
  if (!res || res.status !== 200 || res.text.includes('页面找不到了')) {
    return { found: false, contest: null } // 软 404 → 人工补全
  }
  // 仅提取可安全识别的 JSON 字面量
  const m = /window\.pageInfo\s*=\s*(\{[\s\S]*?\});/.exec(res.text)
  if (!m) return { found: false, contest: null }
  try {
    const info = JSON.parse(m[1]) as Record<string, unknown>
    const startTime = typeof info.startTime === 'number' ? new Date(info.startTime) : null // 毫秒
    const endTime = typeof info.endTime === 'number' ? new Date(info.endTime) : null
    if (!startTime) return { found: false, contest: null }
    return {
      found: true,
      contest: {
        externalContestId: contestId,
        name: String(info.contestName ?? `牛客比赛 ${contestId}`),
        startTime,
        endTime,
        durationSeconds: endTime ? Math.round((endTime.getTime() - startTime.getTime()) / 1000) : null,
        problemCount: null, // 详情页无 problemCount，保持未知待人工补全
        fullScore: null,
        raw: { source: 'nowcoder_contest_page', pageInfoKeys: Object.keys(info) },
      },
    }
  } catch {
    return { found: false, contest: null }
  }
}

// ============================ Codeforces ============================

export interface CfEnvelope<T> {
  status: 'OK' | 'FAILED'
  result?: T
  comment?: string
}

export async function fetchCfApi<T>(db: PrismaClient, method: string, params: Record<string, string>): Promise<T> {
  const host = PLATFORM_HOSTS.codeforces[0]
  const qs = new URLSearchParams(params)
  const url = `https://${host}/api/${method}?${qs.toString()}`
  const body = (await fetchJson(db, host, url)) as CfEnvelope<T>
  if (body.status !== 'OK') {
    // HTTP 200 也必须检查业务状态（官方 FAILED → comment）
    throw new AdapterError(`CF API FAILED: ${body.comment ?? ''}`, 'CF_FAILED', false)
  }
  return body.result as T
}

export interface CfContest {
  id: number
  name: string
  startTimeSeconds: number
  durationSeconds: number
  phase: string
}

export async function fetchCfContestList(db: PrismaClient): Promise<CfContest[]> {
  return fetchCfApi<CfContest[]>(db, 'contest.list', { gym: 'false' })
}

export interface CfStandings {
  contest: { id: number; name: string; durationSeconds: number }
  problems: Array<{ index: string; name: string; points?: number }>
  rows: Array<{
    rank: number | null
    party: { members: Array<{ handle: string }>; participantType: string; teamId?: number; teamName?: string }
    points: number
    penalty: number
    problemResults: Array<{ points: number; verdict?: string }>
  }>
}

/**
 * 普通公开赛整榜：**只传 contestId**（2026-10-05 核验：附 handles/from/count 或 lang 为 HTTP 400 FAILED；
 * 普通赛仅允许匿名 GET）。整榜一次抓取后本地筛选成员；响应上限 16MiB。
 */
export async function fetchCfStandings(db: PrismaClient, contestId: string): Promise<CfStandings> {
  const host = PLATFORM_HOSTS.codeforces[0]
  const url = `https://${host}/api/contest.standings?contestId=${encodeURIComponent(contestId)}`
  await acquireRateSlot(db, host)
  try {
    const res = await safeFetch(url, {
      allowedHosts: [host],
      expectContentTypes: ['application/json'],
      maxBytes: loadEnv().OUTBOUND_MAX_STANDINGS_BYTES,
    })
    const body = JSON.parse(res.text) as CfEnvelope<CfStandings>
    if (body.status !== 'OK') throw new AdapterError(`CF standings FAILED: ${body.comment ?? ''}`, 'CF_FAILED', false)
    return body.result as CfStandings
  } catch (e) {
    if (e instanceof SafeFetchError) throw new AdapterError(`CF standings: ${e.message}`, e.code, e.code === 'TIMEOUT')
    throw e
  }
}

export interface CfUserInfo {
  handle: string
  rating?: number
  maxRating?: number
  rank?: string
}

export async function fetchCfUserInfo(db: PrismaClient, handle: string): Promise<CfUserInfo> {
  const list = await fetchCfApi<CfUserInfo[]>(db, 'user.info', { handles: handle, checkActive: 'false' })
  return list[0]
}

export interface CfRatingChange {
  contestId: number
  contestName: string
  handle: string
  rank: number
  ratingUpdateTimeSeconds: number
  oldRating: number
  newRating: number
}

export async function fetchCfRatingHistory(db: PrismaClient, handle: string): Promise<CfRatingChange[]> {
  return fetchCfApi<CfRatingChange[]>(db, 'user.rating', { handle })
}

export interface CfSubmission {
  id: number
  creationTimeSeconds: number // 秒，不能复用牛客毫秒转换
  contestId?: number
  problem?: { contestId?: number; index: string; name: string }
  verdict?: string
  author: { members: Array<{ handle: string }>; participantType: string }
  testset?: string
}

export async function fetchCfSubmissions(db: PrismaClient, handle: string, from = 1, count = 1000): Promise<CfSubmission[]> {
  return fetchCfApi<CfSubmission[]>(db, 'user.status', { handle: handle, from: String(from), count: String(count) })
}

// ============================ AtCoder ============================

export interface AtCoderHistoryEntry {
  Place: number
  OldRating: number
  NewRating: number
  Performance: number
  IsRated: boolean
  ContestScreenName: string
  ContestName: string
  StartTime?: string
  EndTime: string // 原偏移 ISO（通常 +09:00 JST）
}

/** 归一化 ContestScreenName：`agc004.contest.atcoder.jp` → `agc004`；保留原始值；不把源字段当出站 URL */
export function normalizeAtCoderContestId(contestScreenName: string): string {
  const cleaned = contestScreenName.trim().toLowerCase()
  const m = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.contest\.atcoder\.jp$/.exec(cleaned)
  if (m) return m[1]
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cleaned)) return cleaned
  return contestScreenName // 其他格式保留原值待人工映射
}

export async function fetchAtCoderHistory(db: PrismaClient, userId: string): Promise<{ entries: AtCoderHistoryEntry[]; snapshotUrl: string }> {
  const host = PLATFORM_HOSTS.atcoder[0]
  const url = `https://${host}/users/${encodeURIComponent(userId)}/history/json`
  const body = await fetchJson(db, host, url, { maxBytes: 4 * 1024 * 1024 })
  if (!Array.isArray(body)) throw new AdapterError('AtCoder history 返回非数组', 'SHAPE_CHANGED', false)
  return { entries: body as AtCoderHistoryEntry[], snapshotUrl: url }
}

/** AtCoder 比赛目录：解析官方 /contests/ HTML 的 upcoming/recent 表格（尽力而为；失败转人工） */
export async function fetchAtCoderContestCalendar(db: PrismaClient): Promise<Array<{ externalContestId: string; name: string; startTime: Date | null; kind: 'algorithm' | 'heuristic' | 'unknown' }>> {
  const host = PLATFORM_HOSTS.atcoder[0]
  await acquireRateSlot(db, host)
  const res = await safeFetch(`https://${host}/contests/`, {
    allowedHosts: [host],
    expectContentTypes: ['text/html'],
    maxBytes: 1024 * 1024,
  }).catch(() => null)
  if (!res) return []
  const contests: Array<{ externalContestId: string; name: string; startTime: Date | null; kind: 'algorithm' | 'heuristic' | 'unknown' }> = []
  // 提取 <a href="/contests/xxx"> 链接与相邻文本；只做保守解析，模式变化返回空表（转人工导入）
  const re = /<a href="\/contests\/([a-z0-9-]+)"[^>]*>([^<]{1,120})<\/a>/g
  const ids = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(res.text)) !== null) {
    const id = m[1]
    if (id === 'archive' || ids.has(id)) continue
    ids.add(id)
    const kind = /^(abc|arc|agc|ahc)/.test(id) ? (id.startsWith('ahc') ? 'heuristic' : 'algorithm') : 'unknown'
    contests.push({ externalContestId: id, name: m[2].trim(), startTime: null, kind })
  }
  return contests
}

export function atCoderEntryToParticipation(entry: AtCoderHistoryEntry): NormalizedParticipationRecord {
  // JST(+09:00) 原偏移解析后统一存 UTC；IsRated=false 与 rating 缺失分别处理
  const endMs = Date.parse(entry.EndTime)
  const acEnd = Number.isNaN(Date.parse(entry.EndTime)) ? null : new Date(entry.EndTime)
  return {
    externalContestId: normalizeAtCoderContestId(entry.ContestScreenName),
    participationType: entry.IsRated ? 'OFFICIAL_RATED' : 'OFFICIAL_UNRATED',
    endTime: acEnd,
    rank: Number.isFinite(entry.Place) ? entry.Place : null,
    canShowRank: true,
    score: null,
    fullScore: null,
    acceptedCount: null,
    problemCount: null,
    rating: Number.isFinite(entry.NewRating) ? entry.NewRating : null,
    ratingChange: Number.isFinite(entry.OldRating) && Number.isFinite(entry.NewRating) ? entry.NewRating - entry.OldRating : null,
    ratingStatus: entry.IsRated ? 'FINISHED' : null,
    signUpCount: null,
    userCount: null,
    raw: { ...entry, normalizedEndTimeMs: Number.isNaN(endMs) ? null : endMs, originalContestScreenName: entry.ContestScreenName },
  }
}

export function sourceSnapshotInput(platform: string, url: string, text: string, adapterVersion: string) {
  return { platform, sourceUrl: url, adapterVersion, contentType: 'application/json', contentHash: sha256Hex(text), byteSize: text.length }
}
