import { describe, expect, it } from 'vitest'
import { computeContestW, hasValidSubmission } from '../../modules/scoring/contest-formula.js'

const base = {
  solvedCount: 3, score: 0, platformRank: 10, clubRank: 1, validCount: 4,
  totalProblems: 6, fullTotal: 0, totalEntries: 400, lambdaKey: 'B' as const, remote: false, cap: 20,
}

describe('平台赛 W 公式', () => {
  it('到场：W = 2 + λ(4S + 6R) + X', () => {
    // S = 0.5，R = 1（社内第一），X = 3（10/400 ≤ 5%）
    expect(computeContestW(base)).toEqual({ B: 2, lambda: 1, lambdaKey: 'B', S: 0.5, R: 1, X: 3, W: 13 })
  })

  it('远程减半且无基础分', () => {
    expect(computeContestW({ ...base, remote: true }).W).toBe(5.5)
  })

  it('有效参赛 < 3 人时名次分减半，仅 1 人记 0.5', () => {
    expect(computeContestW({ ...base, validCount: 2, clubRank: 1 }).R).toBe(0.5)
    expect(computeContestW({ ...base, validCount: 1, clubRank: 1 }).R).toBe(0.5)
  })

  it('分数制按得分 / 满分，结果受上限约束', () => {
    const result = computeContestW({ ...base, solvedCount: 0, score: 300, fullTotal: 600, lambdaKey: 'A', cap: 8 })
    expect(result.S).toBe(0.5)
    expect(result.W).toBe(8)
  })

  it('有效提交：通过、得分或失败提交任一即有效', () => {
    expect(hasValidSubmission({ solvedCount: 0, score: 0, platformRank: 1, cells: [{ solved: false, failedCount: 2 }] })).toBe(true)
    expect(hasValidSubmission({ solvedCount: 0, score: 0, platformRank: 1, cells: [{ solved: false, failedCount: 0 }] })).toBe(false)
  })
})
