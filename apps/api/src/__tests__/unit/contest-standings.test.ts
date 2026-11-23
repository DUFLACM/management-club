import { afterEach, describe, expect, it, vi } from 'vitest'

const { ContestStandingsService } = require('../../../dist/modules/activities/contest-standings.service.js')

/** 平台榜单适配器：用固定 JSON 验证归一化、降级与缓存（不真实外呼） */
afterEach(() => {
  vi.unstubAllGlobals()
})

const jsonResponse = (payload: unknown, status = 200, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Map(Object.entries({ 'content-type': 'application/json', ...headers })),
  json: async () => payload,
})

describe('牛客实时榜单适配', () => {
  it('problemData/scoreList 归一化为题目与逐题成绩，accepted 判通过', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      code: 0, msg: 'OK',
      data: {
        problemData: [
          { name: 'A', score: 50, problemId: 323211 },
          { name: 'B', score: 100, problemId: 323213 },
        ],
        rankData: [
          { ranking: 1, userName: 'club-a', totalScore: 150, scoreList: [
            { problemId: 323211, score: 50, accepted: true, failedCount: 0 },
            { problemId: 323213, score: 100, accepted: true, failedCount: 1 }] },
          { ranking: 40, userName: 'club-b', totalScore: 50, scoreList: [
            { problemId: 323211, score: 50, accepted: true, failedCount: 2 },
            { problemId: 323213, score: 0, accepted: false, failedCount: 3 }] },
        ],
      },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const service = new ContestStandingsService()
    const result = await service.fetch('nowcoder', '140235')
    if (!result.available) throw new Error('应当可用')
    expect(result.problems).toEqual([
      { index: 'A', name: 'A', fullScore: 50, url: 'https://ac.nowcoder.com/acm/contest/140235/A' },
      { index: 'B', name: 'B', fullScore: 100, url: 'https://ac.nowcoder.com/acm/contest/140235/B' },
    ])
    expect(result.entries).toEqual([
      { handle: 'club-a', displayName: 'club-a', rank: 1, score: 150, solvedCount: 2, cells: [
        { index: 'A', score: 50, solved: true, failedCount: 0 },
        { index: 'B', score: 100, solved: true, failedCount: 1 }] },
      { handle: 'club-b', displayName: 'club-b', rank: 40, score: 50, solvedCount: 1, cells: [
        { index: 'A', score: 50, solved: true, failedCount: 2 },
        { index: 'B', score: 0, solved: false, failedCount: 3 }] },
    ])
    // 60 秒缓存：第二次调用不再外呼
    await service.fetch('nowcoder', '140235')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('按 basicInfo.pageCount 翻完全部页：拼接全榜、ranking=0 记无名次、跨页重复 uid 去重', async () => {
    const problemData = [{ name: 'A', score: 100, problemId: 1 }]
    const row = (uid: number, ranking: number, accepted: boolean, failedCount = 0) => ({
      uid, ranking, userName: `u${uid}`, totalScore: accepted ? 100 : 0,
      scoreList: [{ problemId: 1, score: accepted ? 100 : 0, accepted, failedCount }],
    })
    const pages: Record<string, unknown[]> = {
      1: Array.from({ length: 50 }, (_, i) => row(1000 + i, i + 1, true)),
      2: [row(1049, 50, true), ...Array.from({ length: 49 }, (_, i) => row(2000 + i, 51 + i, true))],
      3: [row(3000, 0, false, 2), row(3001, 0, false)],
    }
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const page = new URL(url).searchParams.get('page') ?? '1'
      return jsonResponse({
        code: 0, msg: 'OK',
        data: { problemData, rankData: pages[page] ?? [], basicInfo: { pageCount: 3, pageSize: 50, pageCurrent: Number(page), rankCount: 101 } },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await new ContestStandingsService().fetch('nowcoder', '140235')
    if (!result.available) throw new Error('应当可用')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.map(([url]) => new URL(url as string).searchParams.get('page')).sort()).toEqual(['1', '2', '3'])
    // 50 + 49（u1049 在第 2 页重复，去重）+ 2
    expect(result.entries).toHaveLength(101)
    expect(result.entries.filter((e: { handle: string }) => e.handle === '1049')).toHaveLength(1)
    // 原第 50 名之后的成员也能匹配到（此前只抓第 1 页会丢失）
    expect(result.entries.find((e: { handle: string }) => e.handle === '2048')).toMatchObject({ rank: 99, solvedCount: 1 })
    // 榜尾未过题行：ranking=0 → rank null，不能被当作第 1 名参与 X 百分位
    expect(result.entries.find((e: { handle: string }) => e.handle === '3000')).toMatchObject({ rank: null, solvedCount: 0 })
    expect(result.note).toContain('共 3 页')
  })

  it('任一页抓取失败（重试后仍失败）整体返回不可用，不输出残缺榜单', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const page = new URL(url).searchParams.get('page')
      if (page === '2') return jsonResponse({}, 503)
      return jsonResponse({ code: 0, data: { problemData: [{ name: 'A', problemId: 1 }], rankData: [{ uid: 1, ranking: 1, scoreList: [] }], basicInfo: { pageCount: 2 } } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await new ContestStandingsService().fetch('nowcoder', '140235')
    expect(result.available).toBe(false)
    // 第 1 页 + 第 2 页两次尝试
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('预览限制翻页数：只抓指定页，但总人数取接口 rankCount，避免 X 百分位偏低', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const page = new URL(url).searchParams.get('page') ?? '1'
      return jsonResponse({
        code: 0, msg: 'OK',
        data: {
          problemData: [{ name: 'A', score: 100, problemId: 1 }],
          rankData: [{ uid: Number(page), ranking: Number(page), scoreList: [] }],
          basicInfo: { pageCount: 3, pageSize: 50, pageCurrent: Number(page), rankCount: 5000 },
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await new ContestStandingsService().fetch('nowcoder', '140236', { maxPages: 2 })
    if (!result.available) throw new Error('应当可用')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([url]) => new URL(url as string).searchParams.get('page')).sort()).toEqual(['1', '2'])
    expect(result.totalEntries).toBe(5000)
    expect(result.note).toContain('仅抓取前 2 页')
  })

  it('单场比赛超时会中止并返回可读原因，而不是让请求挂到网关 504', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await new ContestStandingsService().fetch('nowcoder', '140237', { timeoutMs: 1_000 })
    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toContain('超过 1 秒')
  })

  it('空榜单（比赛 ID 无效）返回不可用而非报错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ code: 0, data: { problemData: [], rankData: [] } })))
    const result = await new ContestStandingsService().fetch('nowcoder', '0')
    expect(result.available).toBe(false)
  })
})

describe('Codeforces 官方 API 适配', () => {
  it('匿名 GET（无 UA/额外参数），party.members 映射 handle，points>0 判通过', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      status: 'OK',
      result: {
        contest: { id: 1, phase: 'FINISHED' },
        problems: [
          { index: 'A', name: 'Theatre Square' },
          { index: 'B', name: 'Spreadsheet' },
        ],
        rows: [
          { rank: 3, points: 2, party: { members: [{ handle: 'tourist' }] }, problemResults: [
            { points: 1, rejectedAttemptCount: 0 }, { points: 1, rejectedAttemptCount: 2 }] },
          { rank: 900, points: 0, party: { members: [{ handle: 'club-b' }] }, problemResults: [
            { points: 0, rejectedAttemptCount: 4 }, { points: 0, rejectedAttemptCount: 0 }] },
        ],
      },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await new ContestStandingsService().fetch('codeforces', '1')
    if (!result.available) throw new Error('应当可用')
    expect(result.problems[0]).toMatchObject({ index: 'A', url: 'https://codeforces.com/contest/1/problem/A' })
    expect(result.entries[0]).toMatchObject({ handle: 'tourist', solvedCount: 2, score: 2 })
    expect(result.entries[1]).toMatchObject({ handle: 'club-b', solvedCount: 0 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://codeforces.com/api/contest.standings?contestId=1')
    expect(Object.keys((init as { headers?: Record<string, string> }).headers ?? {})).not.toContain('User-Agent')
    expect(result.note).toContain('最终')
  })
})

describe('AtCoder 降级与未知平台', () => {
  it('standings/json 重定向到登录（302）时降级为外链提示，不抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 302, headers: new Map(), json: async () => null }))
    const result = await new ContestStandingsService().fetch('atcoder', 'abc400')
    expect(result.available).toBe(false)
    if (!result.available) expect(result.reason).toContain('登录')
  })

  it('外呼异常同样降级为不可用；未支持平台直接说明', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const failed = await new ContestStandingsService().fetch('nowcoder', '140235')
    expect(failed.available).toBe(false)
    const unsupported = await new ContestStandingsService().fetch('hydro', '99')
    expect(unsupported.available).toBe(false)
    if (!unsupported.available) expect(unsupported.reason).toContain('暂不支持')
  })
})
