/**
 * 正式赛报名名单与人员成绩导入：Excel / CSV / 粘贴文本解析（纯函数，便于单测）。
 * - 支持学号或姓名二选一（或同时填写互相核对）；
 * - 支持个人赛与团队赛（按「队名」分组）；
 * - 支持手填积分，或留空由服务端按赛事档位 + 奖项自动计算附录二标准分，或 0 分仅登记名单。
 */
import { normalizeDate } from '@/lib/history-import';

export const COMPETITION_TEMPLATE_HEADERS = [
  '学号',
  '姓名',
  '队名',
  '奖项/成绩',
  '排名',
  '积分',
  '备注',
] as const;

/** 按文本格式存储的列，避免 Excel 吞掉前导零或把 12/300 转成日期 */
export const COMPETITION_TEMPLATE_TEXT_COLUMNS = ['学号', '排名'].map((name) =>
  (COMPETITION_TEMPLATE_HEADERS as readonly string[]).indexOf(name),
);

export const COMPETITION_TEMPLATE_EXAMPLES: string[][] = [
  ['202400001', '张三', '', '金奖', '5', '', '选定档位后积分留空自动算分'],
  ['', '李四', '', '银奖', '18', '70', '只填姓名也可导入；同名会列出供手动选择'],
  ['202400003', '', '', '参赛', '86', '', '只填学号也可匹配系统账号'],
  ['202400004', '王五', '', '打星', '', '0', '0 分或未填：仅登记参赛名单不入账'],
];

export const COMPETITION_TEAM_TEMPLATE_EXAMPLES: string[][] = [
  ['202400001', '张三', '大外一队', '银奖', '18', '', '同队名成员自动编入同一小队'],
  ['', '李四', '大外一队', '银奖', '18', '', '只填姓名也可匹配账号'],
  ['202400003', '王五', '大外一队', '银奖', '18', '', ''],
  ['202400004', '赵六', '大外二队', '铜奖', '42', '55', '填写积分则以表格分值为准'],
];

export const COMPETITION_TEMPLATE_GUIDE: string[][] = [
  ['列名', '是否必填', '说明'],
  ['学号', '与姓名二选一', '成员校园学号；与姓名至少填一项。同时填写时会核对学号与系统实名是否一致'],
  ['姓名', '与学号二选一', '成员真实姓名；仅填姓名时系统自动匹配账号，若存在重名会在预览区集中列出供手动选择'],
  ['队名', '团队赛必填', '勾选「团队赛」时必填，相同队名的成员会自动编为同一队伍并写入团队赛名单；个人赛选填'],
  ['奖项/成绩', '选填', '如 金奖 / 银奖 / 铜奖 / 优胜奖 / 参赛 / 打星 / 省一 / 国二 / A组省一 等；若上方选择了积分档位且积分列留空，系统按附录二自动算分'],
  ['排名', '选填', '比赛名次，如 12 或 12/300，会同步展示在成员档案与赛事名单中'],
  ['积分', '选填', '填写该成员本场比赛的应得总分。例如省级 ACM 赛已记参赛分 20 分，银奖应得 70 分，填写 70 即可补 50 分。留空时按所选档位和奖项算分，无法算分时仅登记名单。'],
  ['备注', '选填', '补充说明（如组别、赛站、证书编号等），成员在积分流水与正式赛记录中可见'],
];

interface RawCompetitionRow {
  studentNo: string;
  name: string;
  teamName: string;
  awardText: string;
  rankText: string;
  points: string;
  note: string;
  eventTitle: string;
  eventDate: string;
}

const HEADER_ALIASES: Record<string, keyof RawCompetitionRow> = {
  学号: 'studentNo',
  校园编号: 'studentNo',
  studentno: 'studentNo',
  student_no: 'studentNo',
  id: 'studentNo',

  姓名: 'name',
  真实姓名: 'name',
  队员姓名: 'name',
  选手姓名: 'name',
  成员: 'name',
  name: 'name',
  realname: 'name',

  队名: 'teamName',
  队伍: 'teamName',
  队伍名称: 'teamName',
  小队: 'teamName',
  团队名称: 'teamName',
  team: 'teamName',
  teamname: 'teamName',
  team_name: 'teamName',

  '奖项/成绩': 'awardText',
  奖项: 'awardText',
  成绩: 'awardText',
  获奖情况: 'awardText',
  获奖等级: 'awardText',
  获奖: 'awardText',
  结果: 'awardText',
  award: 'awardText',
  medal: 'awardText',
  result: 'awardText',

  排名: 'rankText',
  名次: 'rankText',
  位次: 'rankText',
  rank: 'rankText',

  积分: 'points',
  分数: 'points',
  分值: 'points',
  归档积分: 'points',
  奖励积分: 'points',
  points: 'points',
  score: 'points',
  amount: 'points',

  备注: 'note',
  说明: 'note',
  note: 'note',
  remark: 'note',

  比赛名称: 'eventTitle',
  赛事名称: 'eventTitle',
  比赛: 'eventTitle',
  title: 'eventTitle',

  比赛日期: 'eventDate',
  赛事日期: 'eventDate',
  日期: 'eventDate',
  date: 'eventDate',
};

export interface ParsedCompetitionRow {
  /** 行号（Excel 数据从第 2 行起；粘贴文本从第 1 行起） */
  row: number;
  studentNo: string;
  name: string;
  teamName?: string;
  awardText?: string;
  rankText?: string;
  points?: string;
  note?: string;
  error?: string;
}

export interface ParsedCompetitionSheet {
  rows: ParsedCompetitionRow[];
  inferredTitle: string | null;
  inferredDate: string | null;
}

function normalizeHeaderKey(key: string): keyof RawCompetitionRow | undefined {
  const trimmed = key.trim();
  return HEADER_ALIASES[trimmed] ?? HEADER_ALIASES[trimmed.toLowerCase().replace(/\s+/g, '')];
}

function validateRow(row: ParsedCompetitionRow, isTeam: boolean): ParsedCompetitionRow {
  const errors: string[] = [];
  if (!row.studentNo && !row.name) {
    errors.push('学号与姓名至少填写一项');
  } else if (row.studentNo && !/^[A-Za-z0-9._-]{1,64}$/.test(row.studentNo)) {
    errors.push('学号格式不合法');
  }
  if (row.name.length > 64) errors.push('姓名过长（≤64 字）');
  if (isTeam && !row.teamName) errors.push('团队赛须填写队名');
  if (row.teamName && row.teamName.length > 80) errors.push('队名过长（≤80 字）');
  if (row.awardText && row.awardText.length > 120) errors.push('奖项/成绩过长（≤120 字）');
  if (row.rankText && row.rankText.length > 64) errors.push('排名过长（≤64 字）');
  if (row.points != null && !/^-?\d+(\.\d+)?$/.test(row.points)) errors.push('积分需为数字');
  if (row.note && row.note.length > 300) errors.push('备注过长（≤300 字）');
  if (errors.length > 0) return { ...row, error: errors.join('；') };
  return row;
}

/** 解析 Excel / CSV 对象数组（sheet_to_json 结果） */
export function parseCompetitionExcelRows(
  records: Array<Record<string, unknown>>,
  options: { isTeam?: boolean } = {},
): ParsedCompetitionSheet {
  const isTeam = options.isTeam ?? false;
  const rows: ParsedCompetitionRow[] = [];
  let inferredTitle: string | null = null;
  let inferredDate: string | null = null;

  records.forEach((record, index) => {
    const raw: RawCompetitionRow = {
      studentNo: '',
      name: '',
      teamName: '',
      awardText: '',
      rankText: '',
      points: '',
      note: '',
      eventTitle: '',
      eventDate: '',
    };
    for (const [key, value] of Object.entries(record)) {
      const field = normalizeHeaderKey(key);
      if (field) raw[field] = String(value ?? '').trim();
    }
    if (Object.values(raw).every((value) => value === '')) return;

    if (!inferredTitle && raw.eventTitle.length >= 2) inferredTitle = raw.eventTitle;
    if (!inferredDate && raw.eventDate) {
      const d = normalizeDate(raw.eventDate);
      if (d) inferredDate = d;
    }

    const parsed: ParsedCompetitionRow = {
      row: index + 2,
      studentNo: raw.studentNo,
      name: raw.name,
      ...(raw.teamName ? { teamName: raw.teamName } : {}),
      ...(raw.awardText ? { awardText: raw.awardText } : {}),
      ...(raw.rankText ? { rankText: raw.rankText } : {}),
      ...(raw.points ? { points: raw.points.replace(/^\+/, '') } : {}),
      ...(raw.note ? { note: raw.note } : {}),
    };
    rows.push(validateRow(parsed, isTeam));
  });

  return { rows, inferredTitle, inferredDate };
}

function looksLikeStudentNo(token: string): boolean {
  return /^[A-Za-z]?\d{5,20}$/.test(token);
}

function looksLikeNumber(token: string): boolean {
  return /^[+-]?\d+(\.\d+)?$/.test(token);
}

/**
 * 解析粘贴文本：
 * - 若首行像表头（包含「学号」「姓名」等列名），自动按表头列解析（方便直接从 Excel/WPS 复制粘贴）；
 * - 否则按行解析：
 *   - 个人赛：`学号或姓名 [姓名] [奖项/成绩] [积分] [备注]`
 *   - 团队赛：`队名 学号或姓名 [姓名] [奖项/成绩] [积分] [备注]`
 */
export function parseCompetitionPasteText(
  text: string,
  options: { isTeam?: boolean } = {},
): ParsedCompetitionSheet {
  const isTeam = options.isTeam ?? false;
  const rawLines = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  if (rawLines.length === 0) return { rows: [], inferredTitle: null, inferredDate: null };

  // 检测首行是否为表头（Tab 或逗号分隔，且至少命中 1 个表头别名；注意保留前导 Tab 避免首列留空错位）
  const firstLine = rawLines[0]!;
  const hasTab = rawLines.some((line) => line.includes('\t'));
  const splitDelimited = (line: string) =>
    hasTab ? line.split('\t').map((cell) => cell.trim()) : line.trim().split(/[,，;；]+/).map((cell) => cell.trim());

  const headerCells = hasTab || /[,，;；]/.test(firstLine)
    ? splitDelimited(firstLine)
    : firstLine.trim().split(/\s+/).filter(Boolean);
  const recognizedHeaders = headerCells.filter((cell) => normalizeHeaderKey(cell) != null);
  if (recognizedHeaders.length >= 2 || (recognizedHeaders.length === 1 && headerCells.length === 1)) {
    const records: Array<Record<string, unknown>> = [];
    for (let i = 1; i < rawLines.length; i++) {
      const cells = hasTab || /[,，;；]/.test(rawLines[i]!)
        ? splitDelimited(rawLines[i]!)
        : rawLines[i]!.trim().split(/\s+/).filter(Boolean);
      const record: Record<string, unknown> = {};
      headerCells.forEach((header, idx) => {
        if (header) record[header] = cells[idx] ?? '';
      });
      records.push(record);
    }
    return parseCompetitionExcelRows(records, { isTeam });
  }

  const rows: ParsedCompetitionRow[] = rawLines.map((line, index) => {
    const parts = line.includes('\t')
      ? line.split('\t').map((p) => p.trim()).filter(Boolean)
      : line.trim().split(/[,，;；]+|\s+/).map((p) => p.trim()).filter(Boolean);

    let cursor = 0;
    let teamName: string | undefined;
    if (isTeam) {
      teamName = parts[cursor++] || undefined;
    }

    let studentNo = '';
    let name = '';
    const firstId = parts[cursor++] ?? '';
    if (looksLikeStudentNo(firstId)) {
      studentNo = firstId;
      // 如果紧随其后的不是数字也不是常见奖项关键字，则视为「学号 + 姓名」
      const next = parts[cursor];
      if (next && !looksLikeNumber(next) && !/(金奖|银奖|铜奖|优胜|一等|二等|三等|特等|参赛|打星|省一|省二|省三|国一|国二|国三|国优|第\d+名|gold|silver|bronze)/i.test(next)) {
        name = next;
        cursor++;
      }
    } else {
      name = firstId;
      const next = parts[cursor];
      if (next && looksLikeStudentNo(next)) {
        studentNo = next;
        cursor++;
      }
    }

    const rest = parts.slice(cursor);
    let awardText: string | undefined;
    let points: string | undefined;
    let note: string | undefined;

    if (rest.length === 1) {
      if (looksLikeNumber(rest[0]!)) points = rest[0]!.replace(/^\+/, '');
      else awardText = rest[0];
    } else if (rest.length >= 2) {
      if (looksLikeNumber(rest[0]!)) {
        points = rest[0]!.replace(/^\+/, '');
        note = rest.slice(1).join(' ');
      } else {
        awardText = rest[0];
        if (looksLikeNumber(rest[1]!)) {
          points = rest[1]!.replace(/^\+/, '');
          note = rest.slice(2).join(' ') || undefined;
        } else {
          note = rest.slice(1).join(' ');
        }
      }
    }

    const parsed: ParsedCompetitionRow = {
      row: index + 1,
      studentNo,
      name,
      ...(teamName ? { teamName } : {}),
      ...(awardText ? { awardText } : {}),
      ...(points ? { points } : {}),
      ...(note ? { note } : {}),
    };
    return validateRow(parsed, isTeam);
  });

  return { rows, inferredTitle: null, inferredDate: null };
}
