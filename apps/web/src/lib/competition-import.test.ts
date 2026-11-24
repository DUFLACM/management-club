import { describe, expect, it } from 'vitest';
import {
  COMPETITION_TEAM_TEMPLATE_EXAMPLES,
  COMPETITION_TEMPLATE_EXAMPLES,
  COMPETITION_TEMPLATE_HEADERS,
  parseCompetitionExcelRows,
  parseCompetitionPasteText,
} from './competition-import';

describe('正式赛名单与成绩解析', () => {
  it('按中文表头解析学号/姓名二选一、队名、奖项、排名与积分', () => {
    const parsed = parseCompetitionExcelRows([
      {
        比赛名称: '2026 蓝桥杯省赛',
        比赛日期: '2026/4/18',
        学号: '202400001',
        姓名: '张三',
        '奖项/成绩': 'B组省一',
        排名: '12',
        积分: '+35',
        备注: 'C++ B 组',
      },
      {
        姓名: '李四',
        奖项: '省二',
      },
      {
        学号: '202400003',
        成绩: '参赛',
      },
    ]);

    expect(parsed.inferredTitle).toBe('2026 蓝桥杯省赛');
    expect(parsed.inferredDate).toBe('2026-04-18');
    expect(parsed.rows).toEqual([
      {
        row: 2,
        studentNo: '202400001',
        name: '张三',
        awardText: 'B组省一',
        rankText: '12',
        points: '35',
        note: 'C++ B 组',
      },
      {
        row: 3,
        studentNo: '',
        name: '李四',
        awardText: '省二',
      },
      {
        row: 4,
        studentNo: '202400003',
        name: '',
        awardText: '参赛',
      },
    ]);
  });

  it('校验必填学号/姓名、团队赛队名与非法积分', () => {
    const parsed = parseCompetitionExcelRows(
      [
        { 奖项: '金奖' },
        { 学号: 'bad no', 姓名: '王五', 队名: '大外一队', 积分: 'abc' },
        { 姓名: '赵六', 积分: '20' },
      ],
      { isTeam: true },
    );

    expect(parsed.rows[0]?.error).toContain('学号与姓名至少填写一项');
    expect(parsed.rows[0]?.error).toContain('团队赛须填写队名');
    expect(parsed.rows[1]?.error).toBe('学号格式不合法；积分需为数字');
    expect(parsed.rows[2]?.error).toBe('团队赛须填写队名');
  });

  it('粘贴文本自动识别带表头 Excel 粘贴内容与自由行文本', () => {
    const fromExcel = parseCompetitionPasteText('学号\t姓名\t奖项/成绩\t积分\n202400001\t张三\t金奖\t95\n\t李四\t银奖\t');
    expect(fromExcel.rows).toHaveLength(2);
    expect(fromExcel.rows[0]).toMatchObject({ studentNo: '202400001', name: '张三', awardText: '金奖', points: '95' });
    expect(fromExcel.rows[1]).toMatchObject({ studentNo: '', name: '李四', awardText: '银奖' });
    expect(fromExcel.rows[1]?.error).toBeUndefined();

    const freeform = parseCompetitionPasteText('202400001 张三 省一 35 备注内容\n李四 参赛\n王五');
    expect(freeform.rows).toEqual([
      { row: 1, studentNo: '202400001', name: '张三', awardText: '省一', points: '35', note: '备注内容' },
      { row: 2, studentNo: '', name: '李四', awardText: '参赛' },
      { row: 3, studentNo: '', name: '王五' },
    ]);

    const teamPaste = parseCompetitionPasteText('大外一队 202400001 银奖 70\n大外一队 李四 银奖 70', { isTeam: true });
    expect(teamPaste.rows).toEqual([
      { row: 1, teamName: '大外一队', studentNo: '202400001', name: '', awardText: '银奖', points: '70' },
      { row: 2, teamName: '大外一队', studentNo: '', name: '李四', awardText: '银奖', points: '70' },
    ]);
  });

  it('个人赛与团队赛模板示例行均通过本地校验', () => {
    const indRecords = COMPETITION_TEMPLATE_EXAMPLES.map((cells) =>
      Object.fromEntries(COMPETITION_TEMPLATE_HEADERS.map((h, i) => [h, cells[i] ?? ''])),
    );
    expect(parseCompetitionExcelRows(indRecords, { isTeam: false }).rows.filter((r) => r.error)).toEqual([]);

    const teamRecords = COMPETITION_TEAM_TEMPLATE_EXAMPLES.map((cells) =>
      Object.fromEntries(COMPETITION_TEMPLATE_HEADERS.map((h, i) => [h, cells[i] ?? ''])),
    );
    expect(parseCompetitionExcelRows(teamRecords, { isTeam: true }).rows.filter((r) => r.error)).toEqual([]);
  });
});
