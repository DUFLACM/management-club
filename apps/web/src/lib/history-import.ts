/**
 * 历史积分导入：Excel 模板定义与行解析（纯函数，便于单测）。
 * 模板列：学号 | 姓名 | 活动名称 | 活动日期 | 活动类型 | 参与分 | 加分项 | 加分 | 类别 | 平台 | 比赛场次 | 平台账号 | 计分月份 | 备注
 * - 普通行：活动名称、活动日期必填，服务端按「活动名称 + 活动日期」归组建归档活动存档；
 *   参与分留空时服务端按活动类型给默认参与分（参加即得）；
 * - 加分项：从固定选项里选（讲题 / 分享 / 题解 / 出题 / 工作人员 / 主持 / 其他），加分留空按标准分；
 * - 平台比赛行（填了平台）：比赛场次必填；积分留空时按「平台账号」从榜单抓成绩自动计分，
 *   活动名称 / 日期留空时取比赛元数据——这些在预览接口里补全，这里只做格式校验。
 */
import { ACTIVITY_TYPE_LABELS } from '@/lib/format';

export const HISTORY_TEMPLATE_HEADERS = [
  '学号', '姓名', '活动名称', '活动日期', '活动类型', '参与分', '加分项', '加分', '类别', '平台', '比赛场次', '平台账号', '计分月份', '备注',
] as const;

/** 模板里按文本存的列（学号、日期、场次、账号、月份），避免 Excel 吞前导零或自动转日期 / 数字 */
export const HISTORY_TEMPLATE_TEXT_COLUMNS = ['学号', '活动日期', '比赛场次', '平台账号', '计分月份'].map((name) =>
  (HISTORY_TEMPLATE_HEADERS as readonly string[]).indexOf(name),
);

/** 参加即得的默认参与分（与服务端 PARTICIPATION_DEFAULTS 一致，仅用于模板说明与预览提示） */
export const PARTICIPATION_DEFAULT_LABELS: Array<[string, string]> = [
  ['例会 / 训练 / 集训', '+2（必到活动准时到场）'],
  ['讲座 / 团建 / 服务', '+1.5（普通参会）'],
  ['周赛 / 月赛 / 自定义比赛（未填平台）', '+2（线下到场基础分 B）'],
];

/**
 * 加分项（与服务端 HISTORY_BONUS_ITEMS 一致）。讲题 / 分享按满意度 V = 1.0 取基础分；
 * amount 为 null 的须在「加分」列手填。
 */
export const HISTORY_BONUS_ITEMS: ReadonlyArray<{ code: string; label: string; amount: number | null; category: string; note: string }> = [
  { code: 'lecture_basic', label: '讲题·基础', amount: 4, category: '贡献', note: '基础档题目讲解' },
  { code: 'lecture_intermediate', label: '讲题·中档', amount: 6, category: '贡献', note: '中档题目讲解' },
  { code: 'lecture_advanced', label: '讲题·高档', amount: 8, category: '贡献', note: '高档题目讲解' },
  { code: 'sharing_club', label: '分享·社级', amount: 3, category: '贡献', note: '社内分享' },
  { code: 'sharing_college', label: '分享·院级', amount: 5, category: '贡献', note: '院级分享' },
  { code: 'sharing_school', label: '分享·校级', amount: 8, category: '贡献', note: '校级分享' },
  { code: 'solution_1', label: '题解·1题', amount: 2, category: '贡献', note: '2 分/题，同场上限 2 题' },
  { code: 'solution_2', label: '题解·2题', amount: 4, category: '贡献', note: '同场上限' },
  { code: 'problem_setting_1', label: '出题·1题', amount: 8, category: '贡献', note: '8 分/题，同场上限 2 题' },
  { code: 'problem_setting_2', label: '出题·2题', amount: 16, category: '贡献', note: '同场上限' },
  { code: 'staff', label: '工作人员', amount: 1, category: '服务', note: '在参与分基础上额外 +1' },
  { code: 'host', label: '主持', amount: 2, category: '服务', note: '在参与分基础上额外 +2' },
  { code: 'other', label: '其他加分', amount: null, category: '奖励', note: '须在「加分」列填写分值' },
];

export function bonusLabel(code: string | null | undefined): string {
  return HISTORY_BONUS_ITEMS.find((item) => item.code === code)?.label ?? '—';
}

export const HISTORY_TEMPLATE_EXAMPLES: string[][] = [
  ['202400001', '张三', '第 5 次例会', '2025-03-08', '例会', '', '', '', '', '', '', '', '', '参与分留空 = 例会默认 +2'],
  ['202400001', '张三', '图论专题讲座', '2025-05-01', '讲座', '', '讲题·中档', '', '', '', '', '', '', '讲座参与 +1.5，讲题另加 +6'],
  ['202400002', '李四', '图论专题讲座', '2025-05-01', '讲座', '', '主持', '', '', '', '', '', '', '讲座参与 +1.5，主持另加 +2'],
  ['202400001', '张三', '2025 春季校赛', '2025-04-12', '自定义比赛', '12', '', '', '比赛', '', '', '', '', '校赛按名次手填参与分'],
  ['202400002', '李四', '', '', '', '', '', '', '', 'Codeforces', '2043', 'lisi_cf', '', '比赛分按榜单自动计算'],
  ['202400003', '王五', '', '', '周赛', '', '题解·1题', '', '', '牛客', 'https://ac.nowcoder.com/acm/contest/95323', '322412345', '', '比赛分按榜单 + 题解另加 +2'],
  ['202400003', '王五', '寒假集训优秀学员', '2025-02-20', '集训', '0', '其他加分', '5', '', '', '', '', '', '参与分填 0 = 只记加分'],
];

export const HISTORY_TEMPLATE_GUIDE: string[][] = [
  ['列名', '是否必填', '说明'],
  ['学号', '必填', '成员学号，须已在系统中注册（可先在「成员管理 → Excel 导入」建账号）'],
  ['姓名', '选填', '仅用于核对，不参与匹配'],
  ['活动名称', '普通行必填', '积分对应的活动或比赛名称；同名同日期的行归为同一个活动存档；平台比赛行留空则用比赛官方名称'],
  ['活动日期', '普通行必填', 'YYYY-MM-DD（也支持 2025/4/12、2025年4月12日）；平台比赛行留空则用比赛开始日期'],
  ['活动类型', '建议填写', '周赛 / 月赛 / 自定义比赛 / 讲座 / 训练 / 例会 / 团建 / 集训 / 服务；参与分留空时按它给默认参与分'],
  ['参与分', '选填', '留空 = 参加即得默认分（见下方）；平台比赛行留空 = 按榜单自动计算；填 0 = 只记加分；扣分填负数（如 -2）'],
  ['加分项', '选填', '从「加分项」工作表里选一项（如 讲题·中档、主持），在参与分之外另记一条流水；同一人多个加分项请写多行'],
  ['加分', '选填', '留空按加分项标准分；填了以表格为准；只填加分不选加分项 = 其他加分'],
  ['类别', '选填', '活动 / 比赛 / 服务 / 远程赛 / 贡献 / 奖励 / 期初积分 / 扣分；留空按活动类型推断（比赛类 → 比赛，服务 → 服务，其余 → 活动）。远程赛 / 贡献 / 奖励 / 期初积分 / 扣分没有默认分，须填参与分'],
  ['平台', '选填', '牛客 / Codeforces / AtCoder；填了即为平台比赛行，系统会抓取该场比赛榜单'],
  ['比赛场次', '平台比赛行必填', '比赛 ID 或比赛链接，如 Codeforces 2043、AtCoder abc380、牛客 95323'],
  ['平台账号', '平台比赛行建议填写', '该成员在此平台的账号：牛客填数字 ID，Codeforces / AtCoder 填用户名；积分留空时必填'],
  ['计分月份', '选填', 'YYYY-MM，留空取活动日期所在月份'],
  ['备注', '选填', '成员在流水与活动详情里能看到'],
  ['', '', ''],
  ...PARTICIPATION_DEFAULT_LABELS.map(([types, points]) => ['默认参与分', types, points]),
  ['', '', ''],
  ['自动计分', '', '同一场比赛的行算作一组：W = 2 + λ(4S + 6R) + X，社内名次 R 按本表中参加该场的成员排；榜上无提交的不自动计分'],
  ['注意', '', '同一成员在同一活动只记一次参与分（多写的行只记加分）；同一场平台比赛每人只记一条；整份文件重复导入不会重复计分'],
];

const HEADER_ALIASES: Record<string, keyof RawHistoryRow> = {
  学号: 'studentNo', studentno: 'studentNo', student_no: 'studentNo',
  姓名: 'name', name: 'name',
  参与分: 'amount', 积分: 'amount', 分数: 'amount', 分值: 'amount', amount: 'amount', points: 'amount',
  加分项: 'bonus', 额外加分项: 'bonus', bonus: 'bonus',
  加分: 'bonusAmount', 额外加分: 'bonusAmount', 加分分值: 'bonusAmount', bonusamount: 'bonusAmount',
  类别: 'category', 积分类别: 'category', category: 'category',
  活动名称: 'activityTitle', 活动: 'activityTitle', 比赛名称: 'activityTitle', activity: 'activityTitle', title: 'activityTitle',
  活动日期: 'activityDate', 日期: 'activityDate', 比赛日期: 'activityDate', date: 'activityDate',
  平台: 'platform', 比赛平台: 'platform', platform: 'platform',
  比赛场次: 'contestId', 场次: 'contestId', 比赛id: 'contestId', 比赛ID: 'contestId', 比赛链接: 'contestId', contestid: 'contestId', contest: 'contestId',
  平台账号: 'handle', 账号: 'handle', 用户名: 'handle', handle: 'handle', uid: 'handle',
  活动类型: 'activityType', activitytype: 'activityType',
  计分月份: 'scoreMonth', 月份: 'scoreMonth', month: 'scoreMonth', scoremonth: 'scoreMonth',
  备注: 'note', 说明: 'note', note: 'note',
};

export const HISTORY_CATEGORY_LABELS: Record<string, string> = {
  contest: '比赛',
  remote_contest: '远程赛',
  activity: '活动',
  contribution: '贡献',
  service: '服务',
  award: '奖励',
  initial: '期初积分',
  penalty: '扣分',
};

const CATEGORY_ALIASES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(HISTORY_CATEGORY_LABELS).map(([code, label]) => [label, code])),
  ...Object.fromEntries(Object.keys(HISTORY_CATEGORY_LABELS).map((code) => [code, code])),
  竞赛: 'contest', 远程比赛: 'remote_contest', 讲题: 'contribution', 奖项: 'award', 初始积分: 'initial', 期初: 'initial', 罚分: 'penalty',
};

const ACTIVITY_TYPE_ALIASES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(ACTIVITY_TYPE_LABELS).map(([code, label]) => [label, code])),
  ...Object.fromEntries(Object.keys(ACTIVITY_TYPE_LABELS).map((code) => [code, code])),
  比赛: 'custom_contest', 会议: 'meeting', 聚会: 'gathering', 讲题: 'lecture',
};

const PLATFORM_ALIASES: Record<string, string> = {
  牛客: 'nowcoder', 牛客网: 'nowcoder', nowcoder: 'nowcoder', nc: 'nowcoder',
  codeforces: 'codeforces', cf: 'codeforces',
  atcoder: 'atcoder', at: 'atcoder', abc: 'atcoder',
};

/** 加分项别名：去掉空白、点号、括号、横杠后匹配（讲题·中档 / 讲题（中档）/ 讲题-中档 / 讲题中档） */
function bonusKey(value: string): string {
  return value.toLowerCase().replace(/[\s·.．、\-_—()（）]/g, '');
}
const BONUS_ALIASES: Record<string, string> = {
  ...Object.fromEntries(HISTORY_BONUS_ITEMS.flatMap((item) => [[bonusKey(item.label), item.code], [bonusKey(item.code), item.code]])),
  题解: 'solution_1', 出题: 'problem_setting_1', 命题: 'problem_setting_1', 命题1题: 'problem_setting_1', 命题2题: 'problem_setting_2',
  工作人员: 'staff', 志愿者: 'staff', 主持人: 'host', 其他: 'other', 其它: 'other', 其它加分: 'other',
};

export function normalizeBonus(value: string): string | null {
  return BONUS_ALIASES[bonusKey(value)] ?? null;
}

const CONTEST_TYPES = new Set(['weekly_contest', 'monthly_contest', 'custom_contest']);

interface RawHistoryRow {
  studentNo: string;
  name: string;
  amount: string;
  category: string;
  activityTitle: string;
  activityDate: string;
  platform: string;
  contestId: string;
  handle: string;
  activityType: string;
  scoreMonth: string;
  note: string;
  bonus: string;
  bonusAmount: string;
}

export interface HistoryImportRow {
  /** Excel 行号（表头为第 1 行） */
  row: number;
  studentNo: string;
  name: string;
  /** 参与分；留空时预览按活动类型默认分 / 平台榜单补全 */
  amount?: string;
  /** 加分项代码（HISTORY_BONUS_ITEMS） */
  bonus?: string;
  /** 加分；留空时预览按加分项标准分补全 */
  bonusAmount?: string;
  category: string;
  activityTitle?: string;
  activityDate?: string;
  platform?: string;
  contestId?: string;
  handle?: string;
  activityType?: string;
  scoreMonth?: string;
  note?: string;
  error?: string;
}

function pad(value: string | number): string {
  return String(value).padStart(2, '0');
}

/** 规范化日期：2025-04-12 / 2025/4/12 / 2025.4.12 / 2025年4月12日 → 2025-04-12 */
export function normalizeDate(value: string): string | null {
  const match = value.trim().match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:[\sT].*)?$/);
  if (!match) return null;
  const [, y = '', m, d] = match;
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(Number(y), month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null;
  return `${y}-${pad(month)}-${pad(day)}`;
}

/** 规范化月份：2025-04 / 2025/4 / 2025年4月；Excel 把月份存成日期时取其年月 */
export function normalizeMonth(value: string): string | null {
  const text = value.trim();
  const asDate = normalizeDate(text);
  if (asDate) return asDate.slice(0, 7);
  const match = text.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*月?$/);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1] ?? ''}-${pad(month)}`;
}

export function normalizePlatform(value: string): string | null {
  return PLATFORM_ALIASES[value.trim().toLowerCase()] ?? PLATFORM_ALIASES[value.trim()] ?? null;
}

/** 平台比赛链接 → 比赛 ID（直接填 ID 时原样返回） */
export function extractContestId(platform: string, input: string): string {
  const text = input.trim();
  const patterns: Record<string, RegExp> = {
    nowcoder: /nowcoder\.com\/acm\/contest\/(\d+)/,
    codeforces: /codeforces\.com\/(?:contest|gym)\/(\d+)/,
    atcoder: /atcoder\.jp\/contests\/([A-Za-z0-9_-]+)/,
  };
  const match = patterns[platform]?.exec(text);
  return match?.[1] ?? text;
}

/**
 * 解析表格行（sheet_to_json 的对象数组，表头为键）。
 * 全空行跳过；行号按 Excel 计（数据从第 2 行起）。
 */
export function parseHistoryRows(records: Array<Record<string, unknown>>): HistoryImportRow[] {
  const rows: HistoryImportRow[] = [];
  records.forEach((record, index) => {
    const raw: RawHistoryRow = {
      studentNo: '', name: '', amount: '', category: '', activityTitle: '', activityDate: '',
      platform: '', contestId: '', handle: '', activityType: '', scoreMonth: '', note: '', bonus: '', bonusAmount: '',
    };
    for (const [key, value] of Object.entries(record)) {
      const field = HEADER_ALIASES[key.trim()] ?? HEADER_ALIASES[key.trim().toLowerCase().replace(/\s+/g, '')];
      if (field) raw[field] = String(value ?? '').trim();
    }
    if (Object.values(raw).every((value) => value === '')) return;

    const errors: string[] = [];
    const platform = raw.platform ? normalizePlatform(raw.platform) : null;
    if (raw.platform && !platform) errors.push(`平台「${raw.platform}」无法识别（牛客 / Codeforces / AtCoder）`);
    const isContest = platform != null;

    let activityType: string | undefined;
    if (raw.activityType) {
      activityType = ACTIVITY_TYPE_ALIASES[raw.activityType] ?? ACTIVITY_TYPE_ALIASES[raw.activityType.toLowerCase()];
      if (!activityType) errors.push(`活动类型「${raw.activityType}」无法识别`);
    }
    const row: HistoryImportRow = {
      row: index + 2,
      studentNo: raw.studentNo,
      name: raw.name,
      category: raw.category
        ? CATEGORY_ALIASES[raw.category] ?? CATEGORY_ALIASES[raw.category.toLowerCase()] ?? ''
        : isContest || (activityType && CONTEST_TYPES.has(activityType)) ? 'contest' : activityType === 'service' ? 'service' : 'activity',
      note: raw.note || undefined,
    };
    if (activityType) row.activityType = activityType;
    if (raw.amount) row.amount = raw.amount.replace(/^\+/, '');
    if (raw.bonus) {
      const bonus = normalizeBonus(raw.bonus);
      if (bonus) row.bonus = bonus;
      else errors.push(`加分项「${raw.bonus}」无法识别（见模板「加分项」工作表）`);
    }
    if (raw.bonusAmount) {
      row.bonusAmount = raw.bonusAmount.replace(/^\+/, '');
      if (!raw.bonus) row.bonus = 'other';
    }
    if (raw.activityTitle) row.activityTitle = raw.activityTitle;
    if (platform) {
      row.platform = platform;
      if (raw.contestId) row.contestId = extractContestId(platform, raw.contestId);
      if (raw.handle) row.handle = raw.handle;
    }

    if (!/^[A-Za-z0-9._-]{1,64}$/.test(row.studentNo)) errors.push(row.studentNo ? '学号格式不合法' : '缺少学号');
    if (row.amount != null && !/^-?\d+(\.\d+)?$/.test(row.amount)) errors.push('参与分需为数字');
    if (row.bonusAmount != null && !/^-?\d+(\.\d+)?$/.test(row.bonusAmount)) errors.push('加分需为数字');
    if (row.bonus === 'other' && row.bonusAmount == null) errors.push('加分项为「其他加分」时请填写加分');
    if (!row.category) errors.push(`类别「${raw.category}」无法识别`);
    if (row.activityTitle && row.activityTitle.length < 2) errors.push('活动名称至少 2 个字');
    else if (row.activityTitle && row.activityTitle.length > 120) errors.push('活动名称过长（≤120 字）');
    else if (!row.activityTitle && !isContest) errors.push('缺少活动名称');
    if (raw.activityDate) {
      const date = normalizeDate(raw.activityDate);
      if (date) row.activityDate = date;
      else errors.push('活动日期格式无效');
    } else if (!isContest) errors.push('缺少活动日期');
    if (isContest) {
      if (!row.contestId) errors.push('填写了平台就必须填写比赛场次');
      else if (row.contestId.length > 64) errors.push('比赛场次过长');
      if (row.amount == null && !row.handle) errors.push('参与分留空时须填写平台账号（按榜单计分）');
    } else if (raw.contestId || raw.handle) {
      errors.push('填写了比赛场次 / 平台账号时请同时填写平台');
    } else if (row.amount == null && !raw.activityType && !raw.category) {
      errors.push('参与分留空时请填写活动类型（按类型给默认参与分）');
    }
    if (raw.scoreMonth) {
      const month = normalizeMonth(raw.scoreMonth);
      if (month) row.scoreMonth = month;
      else errors.push('计分月份格式无效');
    }
    if (row.note && row.note.length > 300) errors.push('备注过长（≤300 字）');
    if (errors.length > 0) row.error = errors.join('；');
    rows.push(row);
  });
  return rows;
}
