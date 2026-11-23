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

describe('VJudge 单场榜单适配', () => {
  afterEach(() => {
    delete process.env.VJUDGE_COOKIE
  })

  it('拉取 rank/single + 比赛页 dataJson：准确题数、过滤赛后补题、计算 ICPC 排名并支持 VJUDGE_COOKIE', async () => {
    process.env.VJUDGE_COOKIE = 'test-session-token'
    const dataJson = JSON.stringify({
      id: 654321,
      title: '社团周赛 VJudge #12',
      begin: 1730000000000,
      end: 1730007200000,
      problems: [
        { num: 'A', title: 'Watermelon', oj: 'CodeForces', probNum: '4A' },
        { num: 'B', title: 'Shortest Path', oj: 'CodeForces', probNum: '20C' },
        { num: 'C', title: 'Hard DP', oj: 'AtCoder', probNum: 'abc300_g' },
      ],
    })
    const html = `<html><body><textarea style="display:none" name="dataJson">${dataJson.replace(/"/g, '&quot;')}</textarea></body></html>`
    const rankPayload = {
      id: 654321,
      title: '社团周赛 VJudge #12',
      begin: 1730000000000,
      length: 7200000, // 2h = 7200s
      isReplay: false,
      participants: {
        101: ['team_alpha', 'Alpha 队'],
        102: ['bob_vj', 'Bob'],
        103: ['charlie_wa', 'Charlie'],
        104: ['upsolver_only', '赛后补题'],
      },
      submissions: [
        [101, 0, 0, 300], // team_alpha A WA at 5m
        [101, 0, 1, 600], // team_alpha A AC at 10m (penalty = 600 + 1200 = 1800)
        [101, 1, 1, 2400], // team_alpha B AC at 40m (total penalty = 4200)
        [102, 0, 1, 900], // bob_vj A AC at 15m (penalty = 900)
        [102, 1, 1, 2100], // bob_vj B AC at 35m (total penalty = 3000 -> ranks ahead of team_alpha!)
        [103, 0, 0, 1000], // charlie_wa A WA only -> 0 solved, valid submission
        [104, 0, 1, 9000], // upsolver_only AC after 7200s -> filtered out!
        [101, 2, 1, 8500], // team_alpha C AC after 7200s -> filtered out!
      ],
    }

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/rank/single/')) return jsonResponse(rankPayload)
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'text/html; charset=utf-8']]),
        text: async () => html,
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await new ContestStandingsService().fetch('vjudge', '654321')
    if (!result.available) throw new Error(`应当可用，实际原因: ${result.reason}`)

    // 验证传递了 VJUDGE_COOKIE
    const [, init] = fetchMock.mock.calls[0]
    expect((init as { headers?: Record<string, string> }).headers?.Cookie).toBe('JSESSIONID=test-session-token')

    // 题目数来自 dataJson（含无人赛内通过的 C 题）
    expect(result.problems).toEqual([
      { index: 'A', name: 'Watermelon', fullScore: null, url: 'https://vjudge.net/contest/654321#problem/A' },
      { index: 'B', name: 'Shortest Path', fullScore: null, url: 'https://vjudge.net/contest/654321#problem/B' },
      { index: 'C', name: 'Hard DP', fullScore: null, url: 'https://vjudge.net/contest/654321#problem/C' },
    ])
    expect(result.contest).toEqual({
      name: '社团周赛 VJudge #12',
      startAt: new Date(1730000000000).toISOString(),
      endAt: new Date(1730007200000).toISOString(),
    })

    // 赛后纯补题者被排除，总人数 = 3
    expect(result.totalEntries).toBe(3)
    expect(result.entries.map((e: { handle: string; rank: number; solvedCount: number }) => [e.handle, e.rank, e.solvedCount])).toEqual([
      ['bob_vj', 1, 2],
      ['team_alpha', 2, 2],
      ['charlie_wa', 3, 0],
    ])
    // team_alpha 的赛后补题 C 题不计为通过
    const alpha = result.entries.find((e: { handle: string }) => e.handle === 'team_alpha')
    expect(alpha.cells).toEqual([
      { index: 'A', score: 1, solved: true, failedCount: 1 },
      { index: 'B', score: 1, solved: true, failedCount: 0 },
      { index: 'C', score: 0, solved: false, failedCount: null },
    ])
    // charlie_wa 保留失败记录，供 hasValidSubmission 判定有效参赛
    const charlie = result.entries.find((e: { handle: string }) => e.handle === 'charlie_wa')
    expect(charlie.cells[0]).toEqual({ index: 'A', score: 0, solved: false, failedCount: 1 })
    expect(result.note).toContain('过滤 2 条赛外/补题提交')
  })

  it('密码赛/权限受限（403）时优雅降级并提示配置 VJUDGE_COOKIE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, headers: new Map(), json: async () => null, text: async () => '' }))
    const result = await new ContestStandingsService().fetch('vjudge', '999999')
    expect(result.available).toBe(false)
    if (!result.available) expect(result.reason).toContain('VJUDGE_COOKIE')
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
