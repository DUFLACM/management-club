/**
 * 展示格式化：日期（Asia/Shanghai）、数字（tabular-nums 由样式类承载）、
 * 领域文案映射（活动类型/身份/报名状态/出勤认定等）。
 * 全部原生 Intl，不引入日期库。
 */

const TZ = 'Asia/Shanghai';

const dateTimeFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TZ,
  month: '2-digit',
  day: '2-digit',
});

const timeFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const weekdayFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TZ,
  weekday: 'short',
});

function toDate(value: string | Date | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 2026-10-05 21:46 */
export function formatDateTime(value: string | Date | null | undefined): string {
  const date = toDate(value);
  return date ? dateTimeFmt.format(date) : '待公布';
}

/** 10-05 */
export function formatMonthDay(value: string | Date | null | undefined): string {
  const date = toDate(value);
  return date ? dateFmt.format(date) : '待公布';
}

/** 21:46 */
export function formatTime(value: string | Date | null | undefined): string {
  const date = toDate(value);
  return date ? timeFmt.format(date) : '待公布';
}

/** 周三 */
export function formatWeekday(value: string | Date | null | undefined): string {
  const date = toDate(value);
  return date ? weekdayFmt.format(date) : '';
}

/** 10-05 21:46（同日活动省略日期重复） */
export function formatStartEnd(
  start: string | Date | null | undefined,
  end: string | Date | null | undefined,
): string {
  const s = toDate(start);
  const e = toDate(end);
  if (!s || !e) return '待公布';
  const sameDay =
    dateTimeFmt.format(s).slice(0, 10) === dateTimeFmt.format(e).slice(0, 10);
  return sameDay
    ? `${dateTimeFmt.format(s)} – ${timeFmt.format(e)}`
    : `${dateTimeFmt.format(s)} – ${dateTimeFmt.format(e)}`;
}

/** '2026-10' → '10月'（跨年时带年份） */
export function monthLabel(month: string): string {
  const currentYear = new Date().getFullYear();
  const [year, mm] = month.split('-');
  const yearNum = Number(year);
  if (!Number.isFinite(yearNum)) return month;
  return yearNum === currentYear ? `${Number(mm)}月` : `${year}年${Number(mm)}月`;
}

/** 数字一位小数（用于 E/M 读数）；null → '—' */
export function formatDecimal(value: number | string | null | undefined): string {
  if (value == null) return '—';
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  return num.toFixed(1);
}

/** 带符号分值：'+24' / '-4' / '0' */
export function formatSignedAmount(
  value: number | string | null | undefined,
): string {
  if (value == null) return '—';
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  const rounded = Math.round(num * 10) / 10;
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

/** 完整地点：楼栋 + 房间；缺失字段显示「待公布」。 */
export function formatVenue(venue: {
  name?: string | null;
  building?: string | null;
  room?: string | null;
} | null | undefined): string {
  if (!venue) return '待公布';
  const parts = [venue.building, venue.room].filter(Boolean);
  const detail = parts.length > 0 ? parts.join(' ') : venue.name ?? '';
  return detail.trim() === '' ? '待公布' : detail;
}

// ---------------- 领域文案 ----------------

export const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  weekly_contest: '周赛',
  monthly_contest: '月赛',
  custom_contest: '自定义比赛',
  lecture: '讲座',
  training: '训练',
  meeting: '例会',
  gathering: '团建',
  camp: '集训',
  service: '服务',
};

export function activityTypeLabel(type: string | null | undefined): string {
  if (!type) return '活动';
  return ACTIVITY_TYPE_LABELS[type] ?? type;
}

export const MEMBERSHIP_LABELS: Record<string, string> = {
  formal: '正式成员',
  provisional: '预备成员',
  observing: '考察成员',
  applicant: '申请中',
  rejected_input: '已驳回',
  withdrawn: '已退出',
  honorary_retired: '荣誉退役',
  unknown: '未知',
};

export function membershipLabel(status: string | null | undefined): string {
  if (!status) return '未知';
  return MEMBERSHIP_LABELS[status] ?? status;
}

/** 报名状态 → StatusBadge registration 已注册文案。 */
export const REGISTRATION_BADGE: Record<string, string> = {
  enrolled: '已报名',
  waitlisted: '候补中',
  pending_approval: '待审核',
  cancelled: '已取消',
  rejected: '资格未通过',
  required_list: '必到名单',
};

export function registrationBadge(status: string | null | undefined): string {
  if (!status) return '未报名';
  return REGISTRATION_BADGE[status] ?? status;
}

/** 出勤认定 → StatusBadge attendance 文案。 */
export const ATTENDANCE_RESULT_BADGE: Record<string, string> = {
  pending: '待认定',
  pending_review: '待人工复核',
  ontime: '准时',
  late: '迟到',
  early_leave: '早退',
  late_and_early: '迟到且早退',
  absent: '缺席',
  leave_approved: '请假已批准',
  remote_approved: '远程已批准',
  corrected: '已更正',
};

export function attendanceResultBadge(status: string | null | undefined): string | null {
  if (!status) return null;
  return ATTENDANCE_RESULT_BADGE[status] ?? status;
}

/** 积分流水状态 → StatusBadge points 文案。 */
export function ledgerStatusBadge(status: string | null | undefined): string {
  if (!status) return '—';
  if (status === 'approved') return '已记分';
  if (status === 'reversed') return '已冲正';
  return status;
}

/** 平台绑定状态 → StatusBadge sync 文案。 */
export const PLATFORM_ACCOUNT_BADGE: Record<string, string> = {
  pending_review: '待持有核验',
  verified: '已核验',
  revoked: '已解绑',
};

export function platformAccountBadge(status: string | null | undefined): string {
  if (!status) return '未绑定';
  return PLATFORM_ACCOUNT_BADGE[status] ?? status;
}

export const PLATFORM_LABELS: Record<string, string> = {
  nowcoder: '牛客',
  codeforces: 'Codeforces',
  atcoder: 'AtCoder',
  hydro: 'Hydro',
};

export function platformLabel(platform: string | null | undefined): string {
  if (!platform) return '未知平台';
  return PLATFORM_LABELS[platform] ?? platform;
}

/** 平台比赛外链（社外报名提示用）。 */
export function platformContestUrl(
  platform: string | null | undefined,
  contestId: string | null | undefined,
): string | null {
  if (!platform || !contestId) return null;
  if (platform === 'codeforces')
    return `https://codeforces.com/contest/${contestId}`;
  if (platform === 'atcoder') return `https://atcoder.jp/contests/${contestId}`;
  if (platform === 'nowcoder')
    return `https://ac.nowcoder.com/acm/contest/${contestId}`;
  return null;
}

/** 贡献申报类别。 */
export const CLAIM_CATEGORIES: ReadonlyArray<{
  value: string;
  title: string;
  description: string;
}> = [
  { value: 'contribution_lecture', title: '讲题', description: '例会/训练中的题目讲解' },
  { value: 'solution', title: '题解', description: '正式发布的题解文章' },
  { value: 'problem_setting', title: '出题', description: '为社内赛/集训出题' },
  { value: 'service', title: '服务', description: '场地、组织、设备等服务工作' },
];

/** 签到策略文案。 */
export function policyLabel(policy: string): string {
  const labels: Record<string, string> = {
    GEO_ONLY: '仅定位签到',
    QR_ONLY: '仅扫描活动码',
    GEO_OR_QR: '定位或活动码（任选其一）',
    GEO_AND_QR: '定位 + 活动码（双证据）',
  };
  return labels[policy] ?? policy;
}

/** 距截止的剩余时间（用于候补确认等提示），返回 null 表示已过期/无截止。 */
export function relativeDeadline(
  deadline: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!deadline) return null;
  const target = new Date(deadline);
  if (Number.isNaN(target.getTime())) return null;
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0) return '已截止';
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟后截止`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时后截止`;
  return `${Math.round(hours / 24)} 天后截止`;
}

/** 当前月份（Asia/Shanghai）'YYYY-MM'。 */
export function currentMonthKey(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
  });
  return fmt.format(new Date());
}

/** ISO 本地日期时间值（datetime-local 输入 → '2026-10-05T21:00'） */
export function toLocalInputValue(value: string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** datetime-local 值 → ISO（按 Asia/Shanghai 偏移换算为 UTC）。 */
export function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  // Asia/Shanghai 固定 +08:00（无夏令时）
  const utc = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 8, Number(mi)),
  );
  return Number.isNaN(utc.getTime()) ? null : utc.toISOString();
}
