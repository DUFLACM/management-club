import type { LucideIcon } from 'lucide-react';
import {
  CalendarXIcon,
  CheckCircle2Icon,
  CircleIcon,
  ClipboardCheckIcon,
  ClockIcon,
  CloudOffIcon,
  FileClockIcon,
  FileMinusIcon,
  FileTextIcon,
  HistoryIcon,
  HourglassIcon,
  InfoIcon,
  Link2OffIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  LockIcon,
  MinusCircleIcon,
  QrCodeIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  ShieldXIcon,
  SnowflakeIcon,
  TimerIcon,
  UserMinusIcon,
  XCircleIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * StatusBadge：领域状态显式映射（docs/scheme/06 §9.2）。
 * 禁止根据“字符串里有成功”猜色：每个状态在下方映射表中注册
 * 文案、语气与图标；未注册值回退为中性样式并原样显示。
 *
 * 外观：文字 + 12–14px 状态图标、浅底（--xxx-subtle 底 + --xxx-foreground 文字）、
 * 6px 圆角、水平 padding 8px。标签不可被当按钮。
 */

export type StatusKind =
  | 'registration'
  | 'attendance'
  | 'participation'
  | 'points'
  | 'sync'
  | 'disclosure'
  | 'venue-cert'
  | 'venue-ops';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'destructive';

interface StatusEntry {
  tone: Tone;
  icon: LucideIcon;
  /** 附加语义标记：已冲正=历史，已冻结=锁定 */
  marker?: 'history' | 'locked';
}

/**
 * tone → 样式（浅底 + 深字）。neutral 使用 muted 底；destructive 浅底文字用
 * var(--destructive)（destructive-foreground 是实心按钮白字，不适用于浅底）。
 */
const toneClass: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  info: 'bg-info-subtle text-info-foreground',
  success: 'bg-success-subtle text-success-foreground',
  warning: 'bg-warning-subtle text-warning-foreground',
  destructive: 'bg-destructive-subtle text-destructive',
};

const STATUS_MAP: Record<StatusKind, Record<string, StatusEntry>> = {
  registration: {
    未报名: { tone: 'neutral', icon: MinusCircleIcon },
    待审核: { tone: 'warning', icon: HourglassIcon },
    已报名: { tone: 'info', icon: CheckCircle2Icon },
    候补中: { tone: 'warning', icon: ClockIcon },
    已取消: { tone: 'neutral', icon: CalendarXIcon },
    资格未通过: { tone: 'destructive', icon: XCircleIcon },
    必到名单: { tone: 'info', icon: ListChecksIcon },
  },
  attendance: {
    未签到: { tone: 'neutral', icon: MinusCircleIcon },
    签到已记录: { tone: 'success', icon: CheckCircle2Icon },
    二维码签到已记录: { tone: 'success', icon: QrCodeIcon },
    签退已记录: { tone: 'success', icon: CheckCircle2Icon },
    待签退: { tone: 'info', icon: TimerIcon },
    仅出勤: { tone: 'neutral', icon: UserMinusIcon },
    远程已批准: { tone: 'info', icon: ShieldCheckIcon },
    待人工复核: { tone: 'warning', icon: FileClockIcon },
    待认定: { tone: 'neutral', icon: HourglassIcon },
    准时: { tone: 'success', icon: CheckCircle2Icon },
    迟到: { tone: 'warning', icon: ClockIcon },
    早退: { tone: 'warning', icon: TimerIcon },
    迟到且早退: { tone: 'warning', icon: TimerIcon },
    缺席: { tone: 'destructive', icon: XCircleIcon },
    请假已批准: { tone: 'info', icon: FileMinusIcon },
    已更正: { tone: 'info', icon: HistoryIcon },
  },
  participation: {
    有效参赛待核验: { tone: 'warning', icon: ClipboardCheckIcon },
    积分待审核: { tone: 'warning', icon: HourglassIcon },
    已记分: { tone: 'success', icon: CheckCircle2Icon },
    已冲正: { tone: 'neutral', icon: HistoryIcon, marker: 'history' },
    仅出勤: { tone: 'neutral', icon: UserMinusIcon },
  },
  points: {
    有效参赛待核验: { tone: 'warning', icon: ClipboardCheckIcon },
    积分待审核: { tone: 'warning', icon: HourglassIcon },
    已记分: { tone: 'success', icon: CheckCircle2Icon },
    已冲正: { tone: 'neutral', icon: HistoryIcon, marker: 'history' },
    仅出勤: { tone: 'neutral', icon: UserMinusIcon },
  },
  sync: {
    未绑定: { tone: 'neutral', icon: Link2OffIcon },
    待持有核验: { tone: 'warning', icon: ShieldCheckIcon },
    排队中: { tone: 'info', icon: ListChecksIcon },
    更新中: { tone: 'info', icon: LoaderCircleIcon },
    更新失败: { tone: 'destructive', icon: CloudOffIcon },
    已同步: { tone: 'success', icon: RefreshCwIcon },
    已核验: { tone: 'success', icon: ShieldCheckIcon },
    已解绑: { tone: 'neutral', icon: Link2OffIcon },
    成功: { tone: 'success', icon: CheckCircle2Icon },
    失败: { tone: 'destructive', icon: XCircleIcon },
  },
  disclosure: {
    公示中: { tone: 'info', icon: InfoIcon },
    已结束: { tone: 'neutral', icon: FileMinusIcon },
    当前有效榜: { tone: 'neutral', icon: FileTextIcon },
    已冻结: { tone: 'info', icon: LockIcon, marker: 'locked' },
    待冻结: { tone: 'warning', icon: ClockIcon },
  },
  'venue-cert': {
    草稿: { tone: 'neutral', icon: FileTextIcon },
    待认证: { tone: 'warning', icon: HourglassIcon },
    已认证: { tone: 'success', icon: ShieldCheckIcon },
    已驳回: { tone: 'destructive', icon: ShieldXIcon },
    已撤销: { tone: 'neutral', icon: FileMinusIcon },
    已过期: { tone: 'warning', icon: ClockIcon },
  },
  'venue-ops': {
    运行中: { tone: 'success', icon: CheckCircle2Icon },
    已停用: { tone: 'warning', icon: MinusCircleIcon },
    已归档: { tone: 'neutral', icon: FileMinusIcon },
  },
};

/** 附加标记的补充图标（已冻结=雪花/锁定；已冲正=历史）。 */
const markerIcon: Record<NonNullable<StatusEntry['marker']>, LucideIcon> = {
  history: HistoryIcon,
  locked: SnowflakeIcon,
};

const FALLBACK_ENTRY: StatusEntry = { tone: 'neutral', icon: CircleIcon };

export interface StatusBadgeProps {
  kind: StatusKind;
  value: string;
  className?: string;
}

export function StatusBadge({ kind, value, className }: StatusBadgeProps) {
  const entry = STATUS_MAP[kind][value] ?? FALLBACK_ENTRY;
  const Icon = entry.icon;
  const Marker = entry.marker ? markerIcon[entry.marker] : null;

  return (
    <span
      data-slot="status-badge"
      data-tone={entry.tone}
      className={cn(
        'inline-flex w-fit items-center gap-1.5 rounded-sm px-2 py-0.5 text-xs leading-[18px] font-medium whitespace-nowrap',
        toneClass[entry.tone],
        className,
      )}
    >
      <Icon className="size-3 shrink-0" strokeWidth={2} aria-hidden="true" />
      <span>{value}</span>
      {Marker && (
        <Marker
          className="size-3 shrink-0 opacity-80"
          strokeWidth={2}
          aria-hidden="true"
        />
      )}
    </span>
  );
}
