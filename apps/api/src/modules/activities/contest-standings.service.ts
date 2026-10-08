import { Injectable } from '@nestjs/common'

/**
 * 平台榜单抓取（参与者活动详情「比赛成绩」区）：
 * - 牛客：real-time-rank-data 公开接口（无需 token）；
 * - Codeforces：官方 API contest.standings（匿名 GET，不加 UA 与额外参数，否则 400）；
 * - AtCoder：standings/json 需登录态——尝试匿名，失败时优雅降级为外链
 *   （可用 ATCODER_SESSION 环境变量注入会话 Cookie 恢复抓取）。
 * - 结果按 (platform, contestId) 内存缓存 60 秒；并发去重，避免同一榜单重复外呼。
 */

export interface StandingsProblem {
  index: string
  name: string | null
  fullScore: number | null
  url: string | null
}

export interface StandingsCell {
  index: string
  score: number
  solved: boolean
  failedCount: number | null
}

export interface StandingsEntry {
  /** 稳定匹配键：牛客=数字 UID（与平台账号绑定一致），CF/AtCoder=handle */
  handle: string
  /** 展示名（牛客昵称等；无则为 null，展示回退 handle） */
  displayName: string | null
  rank: number | null
  score: number
  solvedCount: number
  cells: StandingsCell[]
}

export interface StandingsSnapshot {
  platform: string
  contestId: string
  available: true
  problems: StandingsProblem[]
  entries: StandingsEntry[]
  fetchedAt: string
  note: string | null
  /** 榜单接口附带的比赛元数据（仅部分平台提供，供历史导入预填名称与时间） */
  contest?: { name: string | null; startAt: string | null; endAt: string | null }
}

export interface StandingsFailure {
  platform: string
  contestId: string
  available: false
  reason: string
}

export type StandingsResult = StandingsSnapshot | StandingsFailure

export function contestExternalUrl(platform: string, contestId: string): string | null {
  if (platform === 'nowcoder') return `https://ac.nowcoder.com/acm/contest/${contestId}`
  if (platform === 'codeforces') return `https://codeforces.com/contest/${contestId}`
  if (platform === 'atcoder') return `https://atcoder.jp/contests/${contestId}`
  return null
}

const CACHE_TTL_MS = 60_000

type Json = Record<string, unknown>

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Json[]) : []
}

function num(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

@Injectable()
export class ContestStandingsService {
  private readonly cache = new Map<string, { expiresAt: number; inflight?: Promise<StandingsResult>; result?: StandingsResult }>()

  async fetch(platform: string, contestId: string): Promise<StandingsResult> {
    const key = `${platform}:${contestId}`
    const cached = this.cache.get(key)
    const now = Date.now()
    if (cached?.result && cached.expiresAt > now) return cached.result
    if (cached?.inflight) return cached.inflight
    const entry = { expiresAt: now + CACHE_TTL_MS, inflight: undefined as Promise<StandingsResult> | undefined, result: undefined as StandingsResult | undefined }
    entry.inflight = (async () => {
      let result: StandingsResult
      try {
        if (platform === 'nowcoder') result = await this.fetchNowcoder(contestId)
        else if (platform === 'codeforces') result = await this.fetchCodeforces(contestId)
        else if (platform === 'atcoder') result = await this.fetchAtcoder(contestId)
        else result = { platform, contestId, available: false, reason: '该平台暂不支持榜单抓取，请通过外链前往查看' }
      } catch {
        result = { platform, contestId, available: false, reason: '平台榜单暂时无法访问（网络或接口限制），请稍后重试或通过外链前往' }
      }
      entry.result = result
      entry.inflight = undefined
      return result
    })()
    this.cache.set(key, entry)
    return entry.inflight
  }

  /** 牛客 real-time-rank-data：比赛期间实时，结束后为最终榜 */
  private async fetchNowcoder(contestId: string): Promise<StandingsResult> {
    const url = `https://ac.nowcoder.com/acm-heavy/acm/contest/real-time-rank-data?token=&id=${encodeURIComponent(contestId)}&rankScope=ALL&limit=0`
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) club-activities/1.0', Accept: 'application/json' } })
    if (!response.ok) throw new Error(`nowcoder ${response.status}`)
    const body = (await response.json()) as Json
    const data = (body.data ?? {}) as Json
    const problemData = asArray(data.problemData)
    const rankData = asArray(data.rankData)
    if (problemData.length === 0 && rankData.length === 0) {
      return { platform: 'nowcoder', contestId, available: false, reason: '未找到该牛客比赛的榜单（请确认比赛 ID）' }
    }
    const problems: StandingsProblem[] = problemData.map((p, i) => ({
      index: str(p.name) ?? String(i + 1),
      name: str(p.name) ?? String(i + 1),
      fullScore: num(p.score),
      url: /^[A-Za-z]{1,2}$/.test(String(p.name ?? '')) ? `https://ac.nowcoder.com/acm/contest/${contestId}/${p.name}` : null,
    }))
    const problemIndexById = new Map(problemData.map((p, i) => [String(p.problemId), str(p.name) ?? String(i + 1)]))
    const entries: StandingsEntry[] = rankData.map((row) => {
      const scoreList = asArray(row.scoreList)
      const cells: StandingsCell[] = scoreList.map((cell) => {
        const index = problemIndexById.get(String(cell.problemId)) ?? '?'
        const score = num(cell.score) ?? 0
        return { index, score, solved: cell.accepted === true, failedCount: num(cell.failedCount) }
      })
      return {
        handle: row.uid != null ? String(row.uid) : (str(row.userName) ?? ''),
        displayName: str(row.userName) ?? null,
        rank: num(row.ranking),
        score: num(row.totalScore) ?? cells.reduce((sum, c) => sum + c.score, 0),
        solvedCount: cells.filter((c) => c.solved).length,
        cells,
      }
    }).filter((e) => e.handle !== '')
    return { platform: 'nowcoder', contestId, available: true, problems, entries, fetchedAt: new Date().toISOString(), note: '数据来自牛客实时榜单接口；比赛结束后为最终成绩。' }
  }

  /** Codeforces 官方 API：必须匿名 GET（不带 UA / from / count 等额外参数，否则拒绝） */
  private async fetchCodeforces(contestId: string): Promise<StandingsResult> {
    const response = await fetch(`https://codeforces.com/api/contest.standings?contestId=${encodeURIComponent(contestId)}`, { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`codeforces ${response.status}`)
    const body = (await response.json()) as Json
    if (body.status !== 'OK') throw new Error(`codeforces ${str(body.comment) ?? 'FAILED'}`)
    const result = (body.result ?? {}) as Json
    const problemRows = asArray(result.problems)
    const rankRows = asArray(result.rows)
    const contestInfo = (result.contest ?? {}) as Json
    const contestPhase = str(contestInfo.phase)
    const startSeconds = num(contestInfo.startTimeSeconds)
    const durationSeconds = num(contestInfo.durationSeconds)
    const problems: StandingsProblem[] = problemRows.map((p) => ({
      index: str(p.index) ?? '?',
      name: str(p.name),
      fullScore: null,
      url: str(p.index) ? `https://codeforces.com/contest/${contestId}/problem/${p.index}` : null,
    }))
    const entries: StandingsEntry[] = rankRows.map((row) => {
      const party = (row.party ?? {}) as Json
      const members = asArray(party.members)
      const handle = members.map((m) => str(m.handle)).filter(Boolean).join(', ')
      const cells = asArray(row.problemResults).map((cell, i) => {
        const score = num(cell.points) ?? 0
        return { index: problems[i]?.index ?? String(i + 1), score, solved: score > 0, failedCount: num(cell.rejectedAttemptCount) }
      })
      return {
        handle,
        displayName: null,
        rank: num(row.rank),
        score: num(row.points) ?? cells.reduce((sum, c) => sum + c.score, 0),
        solvedCount: cells.filter((c) => c.solved).length,
        cells,
      }
    }).filter((e) => e.handle !== '')
    return {
      platform: 'codeforces', contestId, available: true, problems, entries, fetchedAt: new Date().toISOString(),
      contest: {
        name: str(contestInfo.name),
        startAt: startSeconds != null ? new Date(startSeconds * 1000).toISOString() : null,
        endAt: startSeconds != null && durationSeconds != null ? new Date((startSeconds + durationSeconds) * 1000).toISOString() : null,
      },
      note: contestPhase === 'FINISHED' ? '数据来自 Codeforces 官方 API，为最终榜单。' : '比赛仍在进行/待复核，榜单为当前实时快照（每分钟自动刷新）。',
    }
  }

  /** AtCoder：standings/json 需登录态；未配置会话 Cookie 时通常 302 → 降级外链 */
  private async fetchAtcoder(contestId: string): Promise<StandingsResult> {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) club-activities/1.0',
      Accept: 'application/json',
    }
    const session = process.env.ATCODER_SESSION
    if (session) headers.Cookie = session.startsWith('REVEL_SESSION') ? session : `REVEL_SESSION=${session}`
    const response = await fetch(`https://atcoder.jp/contests/${encodeURIComponent(contestId)}/standings/json`, { headers, redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      return { platform: 'atcoder', contestId, available: false, reason: 'AtCoder 榜单接口需要登录态，暂无法抓取；请点击外链前往官方榜单查看' }
    }
    if (!response.ok) throw new Error(`atcoder ${response.status}`)
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) {
      return { platform: 'atcoder', contestId, available: false, reason: 'AtCoder 榜单接口需要登录态，暂无法抓取；请点击外链前往官方榜单查看' }
    }
    const body = (await response.json()) as Json
    const taskInfo = asArray(body.TaskInfo)
    const standings = asArray(body.StandingsData)
    const problems: StandingsProblem[] = taskInfo.map((t) => ({
      index: str(t.TaskName) ?? str(t.Assignment) ?? '?',
      name: str(t.ProblemName) ?? str(t.TaskName),
      fullScore: num(t.Score),
      url: str(t.Assignment) ? `https://atcoder.jp/contests/${contestId}/tasks/${t.Assignment}` : null,
    }))
    const indexByAssignment = new Map(taskInfo.map((t) => [String(t.Assignment), str(t.TaskName) ?? str(t.Assignment) ?? '?']))
    const entries: StandingsEntry[] = standings.map((row) => {
      const cells = asArray(row.Assignments).map((cell) => {
        const index = indexByAssignment.get(String(cell.Task)) ?? str(cell.Task) ?? '?'
        const score = num(cell.Score) ?? 0
        return { index, score, solved: cell.Status === 'AC' || score > 0, failedCount: null }
      })
      const total = (row.TotalResult ?? {}) as Json
      return {
        handle: str(row.UserScreenName) ?? '',
        displayName: str(row.UserScreenName) ?? null,
        rank: num(row.Rank),
        score: num(total.Score) ?? cells.reduce((sum, c) => sum + c.score, 0),
        solvedCount: cells.filter((c) => c.solved).length,
        cells,
      }
    }).filter((e) => e.handle !== '')
    return { platform: 'atcoder', contestId, available: true, problems, entries, fetchedAt: new Date().toISOString(), note: '数据来自 AtCoder 官方榜单。' }
  }
}
