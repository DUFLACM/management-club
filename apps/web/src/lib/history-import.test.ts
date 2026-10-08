import { describe, expect, it } from 'vitest';
import { HISTORY_TEMPLATE_HEADERS, HISTORY_TEMPLATE_EXAMPLES, extractContestId, normalizeBonus, normalizeDate, normalizeMonth, parseHistoryRows } from './history-import';

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
    expect(row?.error).toBe('缺少学号；参与分需为数字；类别「未知」无法识别；活动名称至少 2 个字；活动日期格式无效');
  });

  it('平台比赛行：积分 / 名称 / 日期可留空，链接提取场次，类别默认比赛', () => {
    const rows = parseHistoryRows([
      { 学号: '202400002', 平台: 'CF', 比赛场次: 'https://codeforces.com/contest/2043', 平台账号: 'lisi_cf' },
      { 学号: '202400003', 平台: '牛客', 比赛场次: '95323' },
      { 学号: '202400004', 积分: '3', 平台账号: 'x', 活动名称: '周训练', 活动日期: '2025-01-01' },
      { 学号: '202400005', 平台: '洛谷', 比赛场次: '1' },
    ]);
    expect(rows[0]).toEqual({ row: 2, studentNo: '202400002', name: '', category: 'contest', platform: 'codeforces', contestId: '2043', handle: 'lisi_cf' });
    // 平台账号留空：由服务端取成员绑定账号，前端不再拦截
    expect(rows[1]?.error).toBeUndefined();
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

  it('参与分留空按活动类型推断类别，交给服务端给默认分；未填活动类型时提示', () => {
    const rows = parseHistoryRows([
      { 学号: '202400001', 活动名称: '第 5 次例会', 活动日期: '2025-03-08', 活动类型: '例会' },
      { 学号: '202400001', 活动名称: '春季校赛', 活动日期: '2025-04-12', 活动类型: '自定义比赛' },
      { 学号: '202400001', 活动名称: '迎新志愿', 活动日期: '2025-09-01', 活动类型: '服务' },
      { 学号: '202400001', 活动名称: '某次活动', 活动日期: '2025-09-02' },
    ]);
    expect(rows.map((r) => [r.category, r.activityType, r.amount, r.error])).toEqual([
      ['activity', 'meeting', undefined, undefined],
      ['contest', 'custom_contest', undefined, undefined],
      ['service', 'service', undefined, undefined],
      ['activity', undefined, undefined, '参与分留空时请填写活动类型（按类型给默认参与分）'],
    ]);
  });

  it('加分项按选项识别，加分留空交给服务端按标准分；只填加分视为其他加分', () => {
    const rows = parseHistoryRows([
      { 学号: '202400001', 活动名称: '图论讲座', 活动日期: '2025-05-01', 活动类型: '讲座', 加分项: '讲题（中档）' },
      { 学号: '202400002', 活动名称: '图论讲座', 活动日期: '2025-05-01', 活动类型: '讲座', 加分项: '主持', 加分: '+3' },
      { 学号: '202400003', 活动名称: '图论讲座', 活动日期: '2025-05-01', 活动类型: '讲座', 加分: '5' },
      { 学号: '202400004', 活动名称: '图论讲座', 活动日期: '2025-05-01', 活动类型: '讲座', 加分项: '其他加分' },
      { 学号: '202400005', 活动名称: '图论讲座', 活动日期: '2025-05-01', 活动类型: '讲座', 加分项: '跳舞' },
    ]);
    expect(rows.map((r) => [r.bonus, r.bonusAmount, r.error])).toEqual([
      ['lecture_intermediate', undefined, undefined],
      ['host', '3', undefined],
      ['other', '5', undefined],
      ['other', undefined, '加分项为「其他加分」时请填写加分'],
      [undefined, undefined, '加分项「跳舞」无法识别（见模板「加分项」工作表）'],
    ]);
    expect(normalizeBonus('讲题-高档')).toBe('lecture_advanced');
    expect(normalizeBonus('分享·校级')).toBe('sharing_school');
    expect(normalizeBonus('题解')).toBe('solution_1');
  });

  it('模板示例行都能通过本地校验', () => {
    const records = HISTORY_TEMPLATE_EXAMPLES.map((cells) => Object.fromEntries(HISTORY_TEMPLATE_HEADERS.map((h, i) => [h, cells[i] ?? ''])));
    expect(parseHistoryRows(records).filter((r) => r.error)).toEqual([]);
  });
});
