/**
 * 活动月度日历视图 + iCalendar (.ics) 导出与订阅弹窗。
 * - 桌面端展示 7 列周一至周日网格，每日最多展示 3 条彩色事件条并标出报名/必到状态；
 * - 移动端提供紧凑网格 + 选中日期的议程卡片，点击活动直接打开详情。
 */
import { useMemo, useState } from 'react';
import {
  CalendarIcon,
  CalendarPlusIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { activityTypeLabel, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { StatusBadge } from '@/components/club/StatusBadge';
import { ErrorState } from '@/components/club/ErrorState';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

interface CalendarActivityItem {
  id: string;
  title: string;
  type: string;
  platform: string | null;
  startAt: string;
  endAt: string;
  venue: { name: string; building: string | null; room: string | null } | null;
  myRegistration: string | null;
  required: boolean;
}

interface CalendarResponse {
  month: string;
  items: CalendarActivityItem[];
}

interface CalendarSubscriptionLinks {
  allUrl: string;
  mineUrl: string;
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function shanghaiParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const shifted = new Date(date.getTime() + 8 * 3600_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function dayKeyOf(iso: string): string {
  const p = shanghaiParts(new Date(iso));
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function hhmmOf(iso: string): string {
  const p = shanghaiParts(new Date(iso));
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function currentMonthShanghai(): string {
  const p = shanghaiParts(new Date());
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

function shiftMonth(month: string, delta: number): string {
  const [y = 2026, m = 1] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function buildMonthGrid(month: string): Array<{ key: string; day: number; inMonth: boolean }> {
  const [year = 2026, mon = 1] = month.split('-').map(Number);
  const firstDay = new Date(Date.UTC(year, mon - 1, 1));
  const firstWeekday = (firstDay.getUTCDay() + 6) % 7; // 周一 = 0
  const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const prevMonthDays = new Date(Date.UTC(year, mon - 1, 0)).getUTCDate();

  const cells: Array<{ key: string; day: number; inMonth: boolean }> = [];
  const prevMonth = shiftMonth(month, -1);
  const nextMonth = shiftMonth(month, 1);

  for (let i = firstWeekday - 1; i >= 0; i -= 1) {
    const d = prevMonthDays - i;
    cells.push({ key: `${prevMonth}-${String(d).padStart(2, '0')}`, day: d, inMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push({ key: `${month}-${String(d).padStart(2, '0')}`, day: d, inMonth: true });
  }
  let nextDay = 1;
  while (cells.length % 7 !== 0) {
    cells.push({ key: `${nextMonth}-${String(nextDay).padStart(2, '0')}`, day: nextDay, inMonth: false });
    nextDay += 1;
  }
  return cells;
}

function eventChipTone(type: string): string {
  if (type === 'weekly_contest' || type === 'monthly_contest' || type === 'custom_contest') {
    return 'bg-primary/12 text-primary hover:bg-primary/20';
  }
  if (type === 'lecture' || type === 'training') {
    return 'bg-info-subtle text-info-foreground hover:bg-info-subtle/80';
  }
  return 'bg-muted text-foreground hover:bg-muted/80';
}

export function ActivityCalendarView({
  principalId,
  onSelectActivity,
}: {
  principalId: string;
  onSelectActivity: (activityId: string) => void;
}) {
  const todayKey = dayKeyOf(new Date().toISOString());
  const [month, setMonth] = useState<string>(() => currentMonthShanghai());
  const [selectedDay, setSelectedDay] = useState<string>(todayKey);

  const query = usePrivateQuery<CalendarResponse, ApiError>(
    principalId,
    ['activities', 'calendar', month],
    async () => (await api.get<CalendarResponse>(`/activities/calendar?month=${month}`)).data,
  );

  const cells = useMemo(() => buildMonthGrid(month), [month]);
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarActivityItem[]>();
    for (const item of query.data?.items ?? []) {
      const k = dayKeyOf(item.startAt);
      const list = map.get(k) ?? [];
      list.push(item);
      map.set(k, list);
    }
    return map;
  }, [query.data]);

  const [year, mon] = month.split('-');
  const selectedEvents = byDay.get(selectedDay) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="上个月"
                onClick={() => setMonth((prev) => shiftMonth(prev, -1))}
              >
                <ChevronLeftIcon className="size-4" aria-hidden="true" />
              </Button>
              <h2 className="min-w-28 text-center text-base font-semibold text-foreground tabular-nums">
                {year} 年 {Number(mon)} 月
              </h2>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="下个月"
                onClick={() => setMonth((prev) => shiftMonth(prev, 1))}
              >
                <ChevronRightIcon className="size-4" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMonth(currentMonthShanghai());
                  setSelectedDay(todayKey);
                }}
              >
                今天
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-primary" aria-hidden="true" /> 比赛
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-info-foreground" aria-hidden="true" /> 讲座 / 训练
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-muted-foreground" aria-hidden="true" /> 其他活动
              </span>
            </div>
          </div>

          {query.isPending ? (
            <Skeleton className="h-96 rounded-xl" />
          ) : query.isError ? (
            <ErrorState description={query.error.message} onRetry={() => void query.refetch()} />
          ) : (
            <>
              <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-border bg-border">
                {WEEKDAYS.map((wd) => (
                  <div
                    key={wd}
                    className="bg-muted/50 py-2 text-center text-xs font-medium text-muted-foreground"
                  >
                    周{wd}
                  </div>
                ))}
                {cells.map((cell) => {
                  const events = byDay.get(cell.key) ?? [];
                  const isToday = cell.key === todayKey;
                  const isSelected = cell.key === selectedDay;
                  return (
                    <div
                      key={cell.key}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedDay(cell.key)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedDay(cell.key);
                        }
                      }}
                      className={cn(
                        'flex min-h-16 flex-col gap-1 bg-card p-1.5 text-left transition-colors sm:min-h-24 sm:p-2',
                        !cell.inMonth && 'bg-muted/20 text-muted-foreground/60',
                        isSelected && 'ring-2 ring-inset ring-primary/60',
                        'hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span
                          className={cn(
                            'flex size-6 items-center justify-center rounded-full text-xs tabular-nums',
                            isToday && 'bg-primary font-semibold text-primary-foreground',
                            !isToday && cell.inMonth && 'font-medium text-foreground',
                          )}
                        >
                          {cell.day}
                        </span>
                        {events.length > 0 && (
                          <span className="text-[10px] text-muted-foreground tabular-nums sm:hidden">
                            {events.length} 场
                          </span>
                        )}
                      </div>
                      <div className="hidden flex-col gap-1 sm:flex">
                        {events.slice(0, 3).map((ev) => (
                          <button
                            key={ev.id}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectActivity(ev.id);
                            }}
                            title={`${hhmmOf(ev.startAt)} ${ev.title}`}
                            className={cn(
                              'truncate rounded-md px-1.5 py-0.5 text-left text-[11px] leading-4 font-medium transition-colors',
                              eventChipTone(ev.type),
                            )}
                          >
                            <span className="mr-1 opacity-75 tabular-nums">{hhmmOf(ev.startAt)}</span>
                            {ev.title}
                          </button>
                        ))}
                        {events.length > 3 && (
                          <span className="px-1 text-[10px] text-muted-foreground">
                            还有 {events.length - 3} 场…
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 选中日期的活动清单（移动端主要浏览区 / 桌面端完整详情预览） */}
              <div className="rounded-xl border border-border bg-muted/20 p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground tabular-nums">
                    <CalendarIcon className="size-4 text-primary" aria-hidden="true" />
                    {selectedDay} 活动安排
                  </h3>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    共 {selectedEvents.length} 场
                  </span>
                </div>
                {selectedEvents.length === 0 ? (
                  <p className="py-2 text-xs text-muted-foreground">当日暂无已发布的协会活动。</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {selectedEvents.map((ev) => (
                      <li key={ev.id}>
                        <button
                          type="button"
                          onClick={() => onSelectActivity(ev.id)}
                          className="flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5 text-left transition-colors hover:border-primary/40"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                              <span className="truncate">{ev.title}</span>
                              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
                                {activityTypeLabel(ev.type)}
                              </span>
                              {ev.required && <StatusBadge kind="registration" value="必到名单" />}
                              {ev.myRegistration === 'enrolled' && <StatusBadge kind="registration" value="已报名" />}
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                              {formatDateTime(ev.startAt)} ~ {hhmmOf(ev.endAt)}
                              {ev.venue
                                ? ` · ${[ev.venue.building, ev.venue.room].filter(Boolean).join(' ') || ev.venue.name}`
                                : ''}
                            </p>
                          </div>
                          <span className="text-xs font-medium text-primary">查看详情 →</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** 导出或订阅 .ics 日历弹窗 */
export function CalendarSubscribeDialog({
  principalId,
  open,
  onOpenChange,
}: {
  principalId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState<'all' | 'mine' | null>(null);
  const query = usePrivateQuery<CalendarSubscriptionLinks, ApiError>(
    open ? principalId : null,
    ['activities', 'calendar-subscription'],
    async () => (await api.get<CalendarSubscriptionLinks>('/activities/calendar-subscription')).data,
  );

  const copyLink = async (which: 'all' | 'mine', url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // 降级：输入框可直接全选复制
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlusIcon className="size-4 text-primary" aria-hidden="true" />
            订阅或导出活动日历（.ics）
          </DialogTitle>
          <DialogDescription>
            添加到 Apple 日历、Google Calendar 或手机系统日历后，新发布的比赛与训练安排会自动同步提醒。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <a href="/api/v1/activities/calendar.ics?scope=all" download="dlufl-acm-all.ics">
                <DownloadIcon aria-hidden="true" />
                下载全部活动 (.ics)
              </a>
            </Button>
            <Button asChild size="sm" variant="outline">
              <a href="/api/v1/activities/calendar.ics?scope=mine" download="dlufl-acm-mine.ics">
                <DownloadIcon aria-hidden="true" />
                下载我的活动 (.ics)
              </a>
            </Button>
          </div>

          {query.isPending ? (
            <Skeleton className="h-28 rounded-xl" />
          ) : query.isError ? (
            <p className="text-xs text-destructive">{query.error.message}</p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="ical-all-url">全部协会活动订阅链接</Label>
                <div className="flex gap-2">
                  <Input id="ical-all-url" readOnly value={query.data.allUrl} className="font-mono text-xs" />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void copyLink('all', query.data.allUrl)}
                  >
                    {copied === 'all' ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
                    {copied === 'all' ? '已复制' : '复制'}
                  </Button>
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ical-mine-url">我的报名与必到活动订阅链接（含个人签名，请勿外泄）</Label>
                <div className="flex gap-2">
                  <Input id="ical-mine-url" readOnly value={query.data.mineUrl} className="font-mono text-xs" />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void copyLink('mine', query.data.mineUrl)}
                  >
                    {copied === 'mine' ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
                    {copied === 'mine' ? '已复制' : '复制'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
