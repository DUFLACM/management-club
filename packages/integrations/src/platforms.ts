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

async function fetchJson(db: PrismaClient, host: string, url: string, opts: { maxBytes?: number; expect?: string[]; headers?: Record<string, string> } = {}): Promise<unknown> {
  await acquireRateSlot(db, host)
  try {
    const res = await safeFetch(url, {
      allowedHosts: [host],
      headers: opts.headers,
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

// ============================ VJudge ============================

export interface VjudgeProblemMeta {
  index: string
  name: string | null
}

export interface VjudgeContestMeta {
  contestId: string
  title: string
  startTime: Date | null
  endTime: Date | null
  durationSeconds: number | null
  problems: VjudgeProblemMeta[]
}

export interface VjudgeParsedEntry {
  handle: string
  displayName: string | null
  rank: number | null
  score: number
  solvedCount: number
  penaltySeconds: number
  cells: Array<{ index: string; score: number; solved: boolean; failedCount: number | null }>
}

export interface VjudgeParsedRank {
  contestId: string
  title: string | null
  startTime: Date | null
  endTime: Date | null
  durationSeconds: number | null
  isReplay: boolean
  problems: Array<{ index: string; name: string | null; fullScore: number | null; url: string | null }>
  entries: VjudgeParsedEntry[]
  upsolvingSkipped: number
  problemCountFromSubmissions: boolean
}

/** 构造 VJudge Cookie 请求头（公开赛留空；密码赛/校内 Group 赛在服务端配置 VJUDGE_COOKIE） */
export function vjudgeCookieHeader(rawCookie?: string): string | undefined {
  const value = (rawCookie ?? process.env.VJUDGE_COOKIE ?? '').trim()
  if (!value) return undefined
  return value.includes('=') ? value : `JSESSIONID=${value}`
}

/** 0 → A, 25 → Z, 26 → AA */
export function vjudgeProblemLabel(index: number): string {
  let n = index
  let label = ''
  do {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return label
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** 解析 VJudge 比赛页 HTML 中的 <textarea name="dataJson"> 静态 JSON（绝不 eval 页面脚本） */
export function parseVjudgeContestDataJson(html: string, fallbackContestId?: string): VjudgeContestMeta | null {
  const m = /<textarea[^>]*\bname=["']dataJson["'][^>]*>([\s\S]*?)<\/textarea>/i.exec(html)
  if (!m) return null
  try {
    const raw = JSON.parse(decodeHtmlEntities(m[1].trim())) as Record<string, unknown>
    const contestId = raw.id != null ? String(raw.id) : (fallbackContestId ?? '')
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : ''
    const beginMs = typeof raw.begin === 'number' && Number.isFinite(raw.begin) ? raw.begin : null
    const endMs = typeof raw.end === 'number' && Number.isFinite(raw.end)
      ? raw.end
      : beginMs != null && typeof raw.length === 'number' && Number.isFinite(raw.length)
        ? beginMs + raw.length
        : null
    const durationSeconds = beginMs != null && endMs != null && endMs > beginMs
      ? Math.round((endMs - beginMs) / 1000)
      : typeof raw.length === 'number' && raw.length > 0
        ? Math.round(raw.length / 1000)
        : null
    const rawProblems = Array.isArray(raw.problems) ? raw.problems : []
    const problems: VjudgeProblemMeta[] = rawProblems.map((item, i) => {
      const p = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
      const index = typeof p.num === 'string' && p.num.trim() ? p.num.trim() : vjudgeProblemLabel(i)
      const titlePart = typeof p.title === 'string' && p.title.trim() ? p.title.trim() : null
      const ojPart = typeof p.oj === 'string' && typeof p.probNum === 'string' ? `${p.oj}-${p.probNum}` : null
      return { index, name: titlePart ?? ojPart }
    })
    return {
      contestId,
      title: title || (contestId ? `VJudge Contest ${contestId}` : 'VJudge Contest'),
      startTime: beginMs != null ? new Date(beginMs) : null,
      endTime: endMs != null ? new Date(endMs) : null,
      durationSeconds,
      problems,
    }
  } catch {
    return null
  }
}

/**
 * 解析 VJudge 单场榜单 JSON（/contest/rank/single/{contestId}）：
 * - 过滤赛后补题（timeSeconds > length/1000 或 timeSeconds < 0），防止补题计入比赛成绩；
 * - 按提交时间升序聚合每题是否 AC 及 AC 前失败次数，计算标准 ICPC 罚时（秒）并按 (过题数 DESC, 罚时 ASC) 排定名次；
 * - 优先使用 dataJson 中的准确题目列表（避免 0 提交题目导致 S 分母偏小）。
 */
export function parseVjudgeRankSingle(
  body: unknown,
  contestId: string,
  metaProblems?: VjudgeProblemMeta[],
): VjudgeParsedRank {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AdapterError('VJudge 榜单返回格式无效', 'SHAPE_CHANGED', false)
  }
  const data = body as Record<string, unknown>
  const participantsRaw = data.participants
  const submissionsRaw = data.submissions
  if ((!participantsRaw || typeof participantsRaw !== 'object') && !Array.isArray(submissionsRaw)) {
    throw new AdapterError('VJudge 榜单缺少 participants 或 submissions 字段', 'SHAPE_CHANGED', false)
  }
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null
  const beginMs = typeof data.begin === 'number' && Number.isFinite(data.begin) ? data.begin : null
  const lengthMs = typeof data.length === 'number' && Number.isFinite(data.length) && data.length > 0 ? data.length : null
  const durationSeconds = lengthMs != null ? Math.floor(lengthMs / 1000) : null
  const startTime = beginMs != null ? new Date(beginMs) : null
  const endTime = beginMs != null && lengthMs != null ? new Date(beginMs + lengthMs) : null
  const isReplay = data.isReplay === true

  const participantMap = new Map<string, { handle: string; displayName: string | null }>()
  if (participantsRaw && typeof participantsRaw === 'object' && !Array.isArray(participantsRaw)) {
    for (const [uid, info] of Object.entries(participantsRaw as Record<string, unknown>)) {
      if (Array.isArray(info)) {
        const handle = typeof info[0] === 'string' ? info[0].trim() : ''
        const nick = typeof info[1] === 'string' && info[1].trim() ? info[1].trim() : null
        if (handle) participantMap.set(uid, { handle, displayName: nick })
      } else if (info && typeof info === 'object') {
        const obj = info as Record<string, unknown>
        const handle = String(obj.name ?? obj.username ?? '').trim()
        const nickRaw = obj.nick ?? obj.nickname
        const nick = typeof nickRaw === 'string' && nickRaw.trim() ? nickRaw.trim() : null
        if (handle) participantMap.set(uid, { handle, displayName: nick })
      }
    }
  }

  interface RawSub {
    uid: string
    problemIndex: number
    status: number
    timeSeconds: number
    order: number
  }
  const inContestSubs: RawSub[] = []
  let upsolvingSkipped = 0
  let maxProblemIndex = -1

  if (Array.isArray(submissionsRaw)) {
    submissionsRaw.forEach((item, order) => {
      if (!Array.isArray(item) || item.length < 4) return
      const uid = String(item[0] ?? '')
      const problemIndex = Number(item[1])
      const status = Number(item[2])
      const timeSeconds = Number(item[3])
      if (!uid || !Number.isInteger(problemIndex) || problemIndex < 0 || !Number.isFinite(timeSeconds)) return
      if (problemIndex > maxProblemIndex) maxProblemIndex = problemIndex
      if (timeSeconds < 0 || (durationSeconds != null && timeSeconds > durationSeconds)) {
        upsolvingSkipped++
        return
      }
      inContestSubs.push({ uid, problemIndex, status, timeSeconds, order })
    })
  }

  // 按提交时间升序处理，保证 AC 前后的失败提交顺序正确
  inContestSubs.sort((a, b) => a.timeSeconds - b.timeSeconds || a.order - b.order)

  const problemCountFromSubmissions = !metaProblems || metaProblems.length === 0
  const problemCount = Math.max(metaProblems?.length ?? 0, maxProblemIndex + 1)
  const problems = Array.from({ length: problemCount }, (_, i) => {
    const meta = metaProblems?.[i]
    const index = meta?.index ?? vjudgeProblemLabel(i)
    return {
      index,
      name: meta?.name ?? null,
      fullScore: null,
      url: `https://vjudge.net/contest/${encodeURIComponent(contestId)}#problem/${encodeURIComponent(index)}`,
    }
  })

  interface CellAgg {
    solved: boolean
    failedCount: number
    acTimeSeconds: number | null
  }
  const userStates = new Map<string, { cells: Map<number, CellAgg>; hasAttempt: boolean }>()
  for (const sub of inContestSubs) {
    let state = userStates.get(sub.uid)
    if (!state) {
      state = { cells: new Map(), hasAttempt: false }
      userStates.set(sub.uid, state)
    }
    let cell = state.cells.get(sub.problemIndex)
    if (!cell) {
      cell = { solved: false, failedCount: 0, acTimeSeconds: null }
      state.cells.set(sub.problemIndex, cell)
    }
    if (cell.solved) continue // 已 AC 后的重复提交不计罚时
    if (sub.status === 1) {
      cell.solved = true
      cell.acTimeSeconds = sub.timeSeconds
      state.hasAttempt = true
    } else if (sub.status === 0) {
      cell.failedCount += 1
      state.hasAttempt = true
    } else {
      // status=2（评测中）等仅计入尝试痕迹但不加罚时
      state.hasAttempt = true
    }
  }

  // 聚合全部赛内有提交的参赛者（纯赛后补题者不入比赛榜）
  const rawEntries: VjudgeParsedEntry[] = []
  for (const [uid, state] of userStates.entries()) {
    if (!state.hasAttempt) continue
    const participant = participantMap.get(uid)
    const handle = participant?.handle ?? uid
    let solvedCount = 0
    let penaltySeconds = 0
    const cells = problems.map((p, idx) => {
      const agg = state.cells.get(idx)
      const solved = agg?.solved === true
      const failedCount = agg ? agg.failedCount : 0
      if (solved && agg?.acTimeSeconds != null) {
        solvedCount += 1
        penaltySeconds += agg.acTimeSeconds + failedCount * 1200
      }
      return {
        index: p.index,
        score: solved ? 1 : 0,
        solved,
        failedCount: agg ? failedCount : null,
      }
    })
    rawEntries.push({
      handle,
      displayName: participant?.displayName ?? null,
      rank: null,
      score: solvedCount,
      solvedCount,
      penaltySeconds,
      cells,
    })
  }

  rawEntries.sort((a, b) =>
    b.solvedCount - a.solvedCount
    || a.penaltySeconds - b.penaltySeconds
    || a.handle.localeCompare(b.handle),
  )

  // 标准竞赛排名：过题数与罚时都相同时并列；0 题且无罚时时仍按榜尾次序或并列排定
  let prevRank = 0
  for (let i = 0; i < rawEntries.length; i++) {
    const cur = rawEntries[i]
    const prev = i > 0 ? rawEntries[i - 1] : null
    if (prev && cur.solvedCount === prev.solvedCount && cur.penaltySeconds === prev.penaltySeconds) {
      cur.rank = prevRank
    } else {
      prevRank = i + 1
      cur.rank = prevRank
    }
  }

  return {
    contestId,
    title,
    startTime,
    endTime,
    durationSeconds,
    isReplay,
    problems,
    entries: rawEntries,
    upsolvingSkipped,
    problemCountFromSubmissions,
  }
}

/** VJudge 比赛元数据导入：优先读取比赛页 HTML 的 dataJson，失败时降级读 rank/single JSON */
export async function fetchVjudgeContestMeta(
  db: PrismaClient,
  contestId: string,
): Promise<{ found: boolean; contest: NormalizedContestRecord | null; problems: VjudgeProblemMeta[] }> {
  const host = PLATFORM_HOSTS.vjudge[0]
  const cookie = vjudgeCookieHeader()
  const headers: Record<string, string> = cookie ? { Cookie: cookie } : {}

  await acquireRateSlot(db, host)
  const htmlRes = await safeFetch(`https://${host}/contest/${encodeURIComponent(contestId)}`, {
    allowedHosts: [host],
    headers,
    expectContentTypes: ['text/html'],
    maxBytes: 2 * 1024 * 1024,
  }).catch(() => null)

  if (htmlRes && htmlRes.status === 200) {
    const meta = parseVjudgeContestDataJson(htmlRes.text, contestId)
    if (meta && meta.startTime) {
      return {
        found: true,
        problems: meta.problems,
        contest: {
          externalContestId: contestId,
          name: meta.title,
          startTime: meta.startTime,
          endTime: meta.endTime,
          durationSeconds: meta.durationSeconds,
          problemCount: meta.problems.length || null,
          fullScore: null,
          raw: { source: 'vjudge_contest_page', problemCount: meta.problems.length },
        },
      }
    }
  }

  // 降级：直接读单场榜单 JSON 获取标题与起止时间
  const rankBody = await fetchJson(db, host, `https://${host}/contest/rank/single/${encodeURIComponent(contestId)}`, {
    headers,
    maxBytes: loadEnv().OUTBOUND_MAX_STANDINGS_BYTES,
  }).catch(() => null)
  if (!rankBody) return { found: false, contest: null, problems: [] }
  try {
    const parsed = parseVjudgeRankSingle(rankBody, contestId)
    if (!parsed.startTime) return { found: false, contest: null, problems: [] }
    return {
      found: true,
      problems: parsed.problems.map((p) => ({ index: p.index, name: p.name })),
      contest: {
        externalContestId: contestId,
        name: parsed.title ?? `VJudge Contest ${contestId}`,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        durationSeconds: parsed.durationSeconds,
        problemCount: parsed.problems.length || null,
        fullScore: null,
        raw: { source: 'vjudge_rank_single', isReplay: parsed.isReplay },
      },
    }
  } catch {
    return { found: false, contest: null, problems: [] }
  }
}
