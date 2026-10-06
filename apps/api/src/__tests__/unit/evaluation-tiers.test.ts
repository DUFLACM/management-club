import { describe, expect, it } from 'vitest'
import { percentile, tierCounts, tierScore } from '../../modules/evaluation/evaluation.service.js'

/** 综评折算口径测试（附录三·四「人数计算」、五「建议分值」、五(一)「百分位」） */

const RATIOS = { a: 0.1, b: 0.2 } as const

describe('附录三·四 各档人数', () => {
  it('A=max(1,round(0.1N))、B=round(0.2N)、C 为余量', () => {
    expect(tierCounts(30, RATIOS)).toEqual({ a: 3, b: 6, c: 21 })
    expect(tierCounts(70, RATIOS)).toEqual({ a: 7, b: 14, c: 49 })
  })

  it('人数很少时 A 档保底 1 人，且 A+B 不超过 N', () => {
    expect(tierCounts(1, RATIOS)).toEqual({ a: 1, b: 0, c: 0 })
    expect(tierCounts(2, RATIOS)).toEqual({ a: 1, b: 0, c: 1 })
    expect(tierCounts(3, RATIOS)).toEqual({ a: 1, b: 1, c: 1 })
    expect(tierCounts(0, RATIOS)).toEqual({ a: 0, b: 0, c: 0 })
  })

  it('各档人数之和恒等于 N 且非负', () => {
    for (let n = 1; n <= 300; n += 1) {
      const counts = tierCounts(n, RATIOS)
      expect(counts.a + counts.b + counts.c).toBe(n)
      expect(counts.c).toBeGreaterThanOrEqual(0)
      expect(counts.a).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('附录三·五 各档建议分值', () => {
  it('A 档统一 1.0', () => {
    expect(tierScore('A', 1, { b: 6, c: 21 })).toBe(1)
    expect(tierScore('A', 3, { b: 6, c: 21 })).toBe(1)
  })

  it('B 档在 1.0–0.5 之间按名次等差递减', () => {
    const counts = { b: 6, c: 21 }
    expect(tierScore('B', 1, counts)).toBe(1)
    expect(tierScore('B', 6, counts)).toBe(0.5)
    expect(tierScore('B', 2, counts)).toBe(0.9)
  })

  it('C 档在 0.5–0 之间按名次等差递减，末位为 0', () => {
    const counts = { b: 6, c: 5 }
    expect(tierScore('C', 1, counts)).toBe(0.5)
    expect(tierScore('C', 3, counts)).toBe(0.25)
    expect(tierScore('C', 5, counts)).toBe(0)
  })

  it('档内仅 1 人时取各档上界，不出现除零', () => {
    expect(tierScore('B', 1, { b: 1, c: 1 })).toBe(1)
    expect(tierScore('C', 1, { b: 1, c: 1 })).toBe(0.5)
  })
})

describe('附录三·五(一) 百分位折算 0–100', () => {
  it('最低分 0、最高分 100，并列同分', () => {
    const sorted = [0, 1, 1, 5]
    expect(percentile(0, sorted)).toBe(0)
    expect(percentile(5, sorted)).toBe(100)
    expect(percentile(1, sorted)).toBeCloseTo((1 / 3) * 100, 6)
  })

  it('全员同分时都得 0（无人严格低于本人）', () => {
    expect(percentile(3, [3, 3, 3])).toBe(0)
  })

  it('只有 1 人或没有人时不除零', () => {
    expect(percentile(7, [7])).toBe(100)
    expect(percentile(7, [])).toBe(0)
  })
})
