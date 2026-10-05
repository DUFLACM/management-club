import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  computeResults,
  isFrozen,
  projectContestMeta,
  projectParticipant,
  projectRecord,
  rankAcm,
  rankByScore,
  recordSourceSnapshot,
  contestSourceSnapshot,
  sourceHashOf,
  sweepQuery,
  RESULT_RULES,
  type HydroContestDoc,
  type HydroRecordDoc,
  type HydroStatusDoc,
} from '../src/adapters/hydro-v5.js'
import { sha256Hex, stableStringify } from '../src/contracts.js'

const here = dirname(fileURLToPath(import.meta.url))
const CONTEST_ID = { toHexString: () => '670100000000000000000001' }
const RECORD_ID = { toHexString: () => '670100000000000000000002' }

function tdoc(overrides: Partial<HydroContestDoc> = {}): HydroContestDoc {
  return {
    docId: CONTEST_ID,
    domainId: 'acm-club',
    title: '2026 秋季新生赛',
    rule: 'acm',
    beginAt: new Date('2026-10-01T08:00:00Z'),
    endAt: new Date('2026-10-01T13:00:00Z'),
    pids: [1000, 1001, 1002],
    attend: 87,
    lockAt: new Date('2026-10-01T12:00:00Z'),
    unlocked: true,
    ...overrides,
  }
}

describe('比赛最小投影', () => {
  const now = new Date('2026-10-05T11:00:00Z')
  const opts = { allowedContests: [] as string[], allowPrivate: false }

  it('题数=pids.length；封榜/解锁状态遵循比赛字段', () => {
    const meta = projectContestMeta(tdoc(), now, opts)
    expect(meta.problemCount).toBe(3)
    expect(meta.lock).toEqual({ lockAt: '2026-10-01T12:00:00.000Z', unlocked: true, isLocked: false })
    expect(meta.scoreboard).toEqual({ displayOnly: false, detailAvailable: true })
    expect(meta).not.toHaveProperty('content')
    expect(meta).not.toHaveProperty('privateFiles')
    expect(meta).not.toHaveProperty('_code')

    const frozen = projectContestMeta(tdoc({ unlocked: false }), now, opts)
    expect(frozen.frozen).toBe(true)
    expect(frozen.scoreboard).toEqual({ displayOnly: true, detailAvailable: false })

    const beforeLock = projectContestMeta(tdoc(), new Date('2026-10-01T09:00:00Z'), opts)
    expect(beforeLock.frozen).toBe(false)
  })

  it('受限赛（assign/口令）：默认不可导出，显式授权后可导出；口令值永不出现', () => {
    const restricted = tdoc({ assign: ['2026级'], _code: 'secret-pass' })
    expect(projectContestMeta(restricted, now, opts)).toMatchObject({ visibility: 'restricted', exportable: false })
    expect(projectContestMeta(restricted, now, { allowedContests: ['670100000000000000000001'], allowPrivate: false })).toMatchObject({ exportable: true })
    expect(projectContestMeta(restricted, now, { allowedContests: [], allowPrivate: true })).toMatchObject({ exportable: false })
    const serialized = JSON.stringify(projectContestMeta(restricted, now, opts))
    expect(serialized).not.toContain('secret-pass')
  })
})

describe('参赛方与提交最小投影', () => {
  it('party：真实 OJ 登记/灵活起止/团队关系；无邮箱联系方式', () => {
    const p = projectParticipant({
      uid: 1001,
      attend: 1,
      startAt: new Date('2026-10-01T08:10:00Z'),
      endAt: new Date('2026-10-01T12:40:00Z'),
      unrank: false,
      members: [1001, 2002],
    } as HydroStatusDoc)
    expect(p).toEqual({
      uid: 1001,
      attend: true,
      startAt: '2026-10-01T08:10:00.000Z',
      endAt: '2026-10-01T12:40:00.000Z',
      unrank: false,
      teamMembers: [1001, 2002],
    })
    expect(JSON.stringify(p)).not.toContain('mail')
  })

  it('record：白名单字段；code/testCases/judgeTexts/compilerTexts 即使在源文档里也绝不输出', () => {
    const rdoc = {
      _id: RECORD_ID,
      domainId: 'acm-club',
      uid: 1001,
      pid: 1000,
      contest: CONTEST_ID,
      status: 1,
      score: 100,
      lang: 'cc.cc17',
      judgeAt: new Date('2026-10-01T09:00:00Z'),
      rejudged: true,
      // 以下字段存在于源文档，但必须被排除
      code: '#include <cstdio>\nint main(){return 0;}',
      testCases: [{ status: 1 }],
      judgeTexts: ['stdout mismatch'],
      compilerTexts: ['g++ ok'],
      files: {},
    } as unknown as HydroRecordDoc
    const projected = projectRecord(rdoc, { 1: 'Accepted' })
    expect(projected).toEqual({
      recordId: '670100000000000000000002',
      uid: 1001,
      contestId: '670100000000000000000001',
      pid: 1000,
      status: 1,
      statusText: 'Accepted',
      score: 100,
      lang: 'cc.cc17',
      judgeAt: '2026-10-01T09:00:00.000Z',
      rejudged: true,
    })
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain('code')
    expect(serialized).not.toContain('testCases')
    expect(serialized).not.toContain('judgeTexts')
    expect(serialized).not.toContain('compilerTexts')
  })
})

describe('结赛结果（ACM/OI/封榜/未知赛制）', () => {
  const ended = new Date('2026-10-05T11:00:00Z')

  it('ACM：accept 降序、罚时升序、并列同 rank、unrank 不参与排名（与 results fixture 结构一致）', () => {
    const tsdocs: HydroStatusDoc[] = [
      { uid: 1002, accept: 9, time: 640 },
      { uid: 1001, accept: 11, time: 723 },
      { uid: 1003, accept: 9, time: 640 },
      { uid: 1999, accept: 7, time: 500, unrank: true },
      { uid: 1004, accept: 4, time: 300 },
    ]
    const results = computeResults({ tdoc: tdoc(), tsdocs, now: ended })
    expect(results.status).toBe('final')
    expect(results.entryKind).toBe('acm')
    expect(results.entries).toEqual([
      { rank: 1, uid: 1001, accept: 11, time: 723, unrank: false, tied: false },
      { rank: 2, uid: 1002, accept: 9, time: 640, unrank: false, tied: false },
      { rank: 2, uid: 1003, accept: 9, time: 640, unrank: false, tied: true },
      { rank: 4, uid: 1004, accept: 4, time: 300, unrank: false, tied: false },
      { rank: null, uid: 1999, accept: 7, time: 500, unrank: true, tied: false },
    ])
    expect(results.integrity).toMatchObject({ participantCount: 5, rankedCount: 4, problemCount: 3, judgeComplete: null })
    // 与契约 fixture 的 entry 结构一致
    const fixtureResults = JSON.parse(readFileSync(resolve(here, 'fixtures/results.json'), 'utf8'))
    expect(Object.keys((results.entries as Record<string, unknown>[])[0]).sort()).toEqual(Object.keys(fixtureResults.results.entries[0]).sort())
  })

  it('OI/IOI：按总分排名', () => {
    const results = computeResults({
      tdoc: tdoc({ rule: 'ioi' }),
      tsdocs: [{ uid: 1, score: 300 }, { uid: 2, score: 300 }, { uid: 3, score: 100 }],
      now: ended,
    })
    expect(results.entryKind).toBe('score')
    expect(results.entries).toEqual([
      { rank: 1, uid: 1, score: 300, unrank: false, tied: false },
      { rank: 1, uid: 2, score: 300, unrank: false, tied: true },
      { rank: 3, uid: 3, score: 100, unrank: false, tied: false },
    ])
    expect(RESULT_RULES).toContain('ioi')
  })

  it('封榜期间：display ≠ detail，只输出 display 派生数据，rank=null，不产出最终名次', () => {
    const now = new Date('2026-10-01T12:30:00Z') // lockAt 12:00 已过，未解锁
    expect(isFrozen(tdoc({ unlocked: false }), now)).toBe(true)
    const tsdocs: HydroStatusDoc[] = [
      {
        uid: 1001,
        // detail 含封榜后的真实 AC —— 不得泄露
        detail: { 1000: { pid: 1000, status: 1, score: 100, time: 300 }, 1001: { pid: 1001, status: 1, score: 100, time: 400 } },
        display: { 1000: { pid: 1000, status: 1, score: 100, time: 300 }, 1001: { pid: 1001, status: 20, score: 0, npending: 1 } },
      },
    ]
    const results = computeResults({ tdoc: tdoc({ unlocked: false }), tsdocs, now })
    expect(results.status).toBe('frozen')
    expect(results.detailAvailable).toBe(false)
    expect(results.entryKind).toBe('display')
    const serialized = JSON.stringify(results)
    expect(serialized).not.toContain('"detail"')
    const entry = (results.entries as Array<{ uid: number; derived: { accept?: number }; problems: Record<string, { status?: number }> }>)[0]
    expect(entry.rank).toBeNull()
    expect(entry.derived.accept).toBe(1)
    expect(entry.problems['1001'].status).toBe(20)
    expect(results.integrity.note).toContain('display')
  })

  it('未结束：status=running 不产出结赛快照', () => {
    const now = new Date('2026-10-01T09:00:00Z')
    const results = computeResults({ tdoc: tdoc(), tsdocs: [{ uid: 1, accept: 1, time: 10 }], now })
    expect(results.status).toBe('running')
    expect(results.entries).toBeNull()
  })

  it('未知赛制：pending_review（rule 原样返回）', () => {
    const results = computeResults({ tdoc: tdoc({ rule: 'custom-x' }), tsdocs: [{ uid: 1, score: 1 }], now: ended })
    expect(results).toMatchObject({ rule: 'custom-x', status: 'pending_review' })
    expect(results.entries).toBeNull()
    expect(results.integrity.note).toContain('人工')
  })
})

describe('事件源快照与源哈希', () => {
  it('contest/record 快照仅含最小事实；删除事实含确认次数', () => {
    const contest = contestSourceSnapshot(tdoc(), new Date('2026-10-05T11:00:00Z'))
    expect(contest).toMatchObject({ kind: 'contest', docId: '670100000000000000000001', pids: [1000, 1001, 1002] })
    expect(Object.keys(contest).sort()).toEqual(['attend', 'beginAt', 'docId', 'domainId', 'endAt', 'kind', 'locked', 'pids', 'rated', 'rule', 'title', 'unlocked'])
    const record = recordSourceSnapshot({
      _id: RECORD_ID,
      domainId: 'acm-club',
      uid: 1001,
      pid: 1000,
      contest: CONTEST_ID,
      status: 2,
      score: 0,
      lang: 'py',
      judgeAt: new Date('2026-10-01T09:00:00Z'),
      rejudged: false,
      code: 'print(1)',
    } as unknown as HydroRecordDoc)
    expect(record).not.toHaveProperty('code')
    expect(record).toMatchObject({ kind: 'record', status: 2, uid: 1001 })
  })

  it('源哈希稳定：键序无关；内容变化则变化（重判 AC→WA 产生新修订）', () => {
    const a = sourceHashOf({ x: 1, y: { b: 2, a: 3 } }, sha256Hex)
    const b = sourceHashOf({ y: { a: 3, b: 2 }, x: 1 }, sha256Hex)
    expect(a).toBe(b)
    const c = sourceHashOf({ x: 1, y: { b: 2, a: 4 } }, sha256Hex)
    expect(a).not.toBe(c)
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('ACM/OI 分数语义不混淆：快照保留原始语义字段', () => {
    const oi = contestSourceSnapshot(tdoc({ rule: 'oi' }), new Date())
    expect(oi.rule).toBe('oi')
    expect(oi).not.toHaveProperty('score')
  })
})

describe('rankAcm/rankByScore 纯函数', () => {
  it('空/单元素', () => {
    expect(rankAcm([])).toEqual([])
    expect(rankByScore([{ uid: 7, score: 10 }])).toEqual([{ rank: 1, uid: 7, score: 10, unrank: false, tied: false }])
  })

  it('sweep 窗口：过去 lookback 天至未来 7 天', () => {
    const now = new Date('2026-10-05T00:00:00Z')
    const q = sweepQuery(now, 180)
    expect(q.beginAtEnd.getTime() - now.getTime()).toBe(7 * 24 * 3600_000)
    expect(now.getTime() - q.beginAtStart.getTime()).toBe(180 * 24 * 3600_000)
  })
})
