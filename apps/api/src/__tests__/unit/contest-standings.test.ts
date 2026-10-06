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
