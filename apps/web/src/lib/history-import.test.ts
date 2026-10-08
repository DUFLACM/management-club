import { describe, expect, it } from 'vitest';
import { extractContestId, normalizeDate, normalizeMonth, parseHistoryRows } from './history-import';

describe('历史积分 Excel 解析', () => {
  it('按中文表头解析并规范化类别、日期、活动类型', () => {
    const rows = parseHistoryRows([
      { 学号: '202400001', 姓名: '张三', 积分: '12', 类别: '比赛', 活动名称: '2025 春季校赛', 活动日期: '2025/4/12', 活动类型: '自定义比赛', 计分月份: '', 备注: '一等奖' },
    ]);
    expect(rows).toEqual([
      {
        row: 2, studentNo: '202400001', name: '张三', amount: '12', category: 'contest',
        activityTitle: '2025 春季校赛', activityDate: '2025-04-12', activityType: 'custom_contest', note: '一等奖',
      },
    ]);
  });

  it('类别留空按活动；扣分可为负；跳过全空行但行号保持 Excel 行号', () => {
    const rows = parseHistoryRows([
      { 学号: '', 积分: '', 活动名称: '' },
      { 学号: '202400002', 积分: '-2', 类别: '扣分', 活动名称: '例会缺席', 活动日期: '2025年3月1日', 计分月份: '2025-03-01' },
      { 学号: '202400003', 积分: '1', 活动名称: '周训练', 活动日期: '2025-03-02' },
    ]);
    expect(rows.map((r) => [r.row, r.category, r.amount, r.scoreMonth, r.error])).toEqual([
      [3, 'penalty', '-2', '2025-03', undefined],
      [4, 'activity', '1', undefined, undefined],
    ]);
  });

  it('逐项列出行内错误', () => {
    const [row] = parseHistoryRows([{ 学号: '', 积分: 'abc', 类别: '未知', 活动名称: 'A', 活动日期: '2025-02-30' }]);
    expect(row?.error).toBe('缺少学号；积分需为数字；类别「未知」无法识别；活动名称至少 2 个字；活动日期格式无效');
  });

  it('平台比赛行：积分 / 名称 / 日期可留空，链接提取场次，类别默认比赛', () => {
    const rows = parseHistoryRows([
      { 学号: '202400002', 平台: 'CF', 比赛场次: 'https://codeforces.com/contest/2043', 平台账号: 'lisi_cf' },
      { 学号: '202400003', 平台: '牛客', 比赛场次: '95323' },
      { 学号: '202400004', 积分: '3', 平台账号: 'x', 活动名称: '周训练', 活动日期: '2025-01-01' },
      { 学号: '202400005', 平台: '洛谷', 比赛场次: '1' },
    ]);
    expect(rows[0]).toEqual({ row: 2, studentNo: '202400002', name: '', category: 'contest', platform: 'codeforces', contestId: '2043', handle: 'lisi_cf' });
    expect(rows[1]?.error).toBe('积分留空时须填写平台账号');
    expect(rows[2]?.error).toBe('填写了比赛场次 / 平台账号时请同时填写平台');
    expect(rows[3]?.error).toContain('平台「洛谷」无法识别');
  });

  it('日期与月份规范化', () => {
    expect(normalizeDate('2025.4.5')).toBe('2025-04-05');
    expect(normalizeDate('2025-13-01')).toBeNull();
    expect(normalizeMonth('2025年4月')).toBe('2025-04');
    expect(normalizeMonth('2025/4')).toBe('2025-04');
  });

  it('从比赛链接提取 ID', () => {
    expect(extractContestId('nowcoder', 'https://ac.nowcoder.com/acm/contest/95323')).toBe('95323');
    expect(extractContestId('codeforces', 'https://codeforces.com/contest/2043/standings')).toBe('2043');
    expect(extractContestId('atcoder', 'https://atcoder.jp/contests/abc380/tasks')).toBe('abc380');
    expect(extractContestId('codeforces', ' 2043 ')).toBe('2043');
  });
});
