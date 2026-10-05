/**
 * 成员端 · 概览：GET /me/dashboard。
 *
 * 布局（06 文档 §5）：
 * - 桌面第一行 欢迎卡+E/M 主卡（8 列）+ 当前开放活动（4 列）；
 * - 第二行 排名（3）+ 出勤（3）+ 待办（6）；
 * - 第三行 近六个月构成（8，轻量 SVG 柱图 + 等价数据表）+ 近期安排（4）；
 * - 手机顺序：待签到活动 → 欢迎 E/M → 排名/出勤 → 待办 → 近期 → 构成。
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  AlarmClockIcon,
  CalendarClockIcon,
  CoinsIcon,
  ListTodoIcon,
  MedalIcon,
  PlusIcon,
  ScanLineIcon,
  ShieldCheckIcon,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrincipal } from '@/lib/session';
import {
  activityTypeLabel,
  formatDateTime,
  formatMonthDay,
  formatWeekday,
  membershipLabel,
  monthLabel,
  platformAccountBadge,
  platformLabel,
  relativeDeadline,
} from '@/lib/format';
import { PanelHeader } from '@/components/club/PanelHeader';
import { BindPlatformAccountDialog } from '@/components/club/BindPlatformAccountDialog';
import { MemberGate, QueryBoundary } from '@/components/club/QueryBoundary';
import { StatusBadge } from '@/components/club/StatusBadge';
import { TrainingRoomArt } from '@/components/club/TrainingRoomArt';
import { MonthBars } from '@/components/club/MonthBars';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';

interface DashboardData {
  user: {
    displayName: string;
    studentNo: string;
    realName: string;
    membership: string;
  };
  score: {
    e: string;
    components: Array<{ month: string; m: number; weight: number; contribution: number }>;
    currentMonthM: number;
  };
  rank: { position: number | null; total: number; qualified: boolean; reason?: string | null };
  attendance: { done: number; total: number; note: string | null };
  openActivities: Array<{
    id: string;
    title: string;
    type: string;
    startAt: string;
    endAt: string;
    venue: { name: string; building: string | null; room: string | null } | null;
    policy: string | null;
    myRegistration: string | null;
    required: boolean;
    checkedIn: boolean;
    checkedOut: boolean;
    windowOpen: 'IN' | 'OUT' | 'none';
    canCheckIn: boolean;
  }>;
  todos: Array<{ kind: string; id: string; title: string; deadline: string | null }>;
  upcoming: Array<{
    id: string;
    title: string;
    type: string;
    startAt: string;
    venue: { name: string; room: string | null } | null;
    myRegistration: string | null;
  }>;
  platformSync: Array<{
    platform: string;
    status: string;
    lastSyncAt: string | null;
    lastSyncStatus: string | null;
  }>;
}

const cardTitleClass =
  'flex items-center gap-2 text-sm leading-[22px] font-semibold text-foreground';
const cardIconClass = 'size-4 text-input';

export default function OverviewPanel() {
  const principal = usePrincipal();
  return (
    <MemberGate principal={principal}>
      {(principalId) => <OverviewBody principalId={principalId} />}
    </MemberGate>
  );
}

function OverviewBody({ principalId }: { principalId: string }) {
  const [, setSearchParams] = useSearchParams();
  const [bindOpen, setBindOpen] = useState(false);
  const [bindSubmitted, setBindSubmitted] = useState(false);
  const query = usePrivateQuery<DashboardData, ApiError>(
    principalId,
    ['me', 'dashboard'],
    async () => (await api.get<DashboardData>('/me/dashboard')).data,
  );

  return (
    <QueryBoundary query={query}>
      {(data) => {
        const goSection = (section: string, params: Record<string, string>) => {
          setSearchParams((previous) => {
            const next = new URLSearchParams(previous);
            next.set('section', section);
            for (const [key, value] of Object.entries(params)) next.set(key, value);
            return next;
          });
        };
        return (
          <div className="flex flex-col gap-4">
            <PanelHeader
              title="今天也来写一题"
              description="概览你的有效积分、排名、出勤与近期安排。"
              actions={
                <Button
                  className="ml-auto"
                  type="button"
                  onClick={() => {
                    setBindSubmitted(false);
                    setBindOpen(true);
                  }}
                >
                  <PlusIcon aria-hidden="true" />
                  绑定账号
                </Button>
              }
            />
            {bindSubmitted && (
              <Alert variant="success">
                <AlertDescription>绑定申请已提交，等待管理员核验。</AlertDescription>
              </Alert>
            )}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
              {/* 当前开放活动（手机第一位 / 桌面右上 4 列） */}
              <section
                aria-label="当前开放活动"
                className="order-1 md:order-2 md:col-span-4"
              >
                <Card className="h-full">
                  <CardContent className="flex h-full flex-col gap-3 p-5">
                    <h2 className={cardTitleClass}>
                      <ScanLineIcon className={cardIconClass} aria-hidden="true" />
                      当前开放活动
                    </h2>
                    {data.openActivities.length === 0 ? (
                      <p className="text-sm leading-[22px] text-muted-foreground">
                        暂无进行中或即将开始（2 小时内）的活动。
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-3">
                        {data.openActivities.map((activity) => {
                          const outWindow =
                            activity.windowOpen === 'OUT' && activity.checkedIn && !activity.checkedOut;
                          return (
                            <li
                              key={activity.id}
                              className="rounded-xl border border-border p-3"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium text-foreground">
                                  {activity.title}
                                </span>
                                {activity.required && (
                                  <StatusBadge kind="registration" value="必到名单" />
                                )}
                              </div>
                              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                {activityTypeLabel(activity.type)} ·{' '}
                                {formatDateTime(activity.startAt)} ·{' '}
                                {activity.venue
                                  ? [activity.venue.building, activity.venue.room]
                                      .filter(Boolean)
                                      .join(' ') || '待公布'
                                  : '待公布'}
                              </p>
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                {activity.windowOpen === 'IN' && !activity.checkedIn && (
                                  <StatusBadge kind="attendance" value="未签到" />
                                )}
                                {activity.checkedIn && !activity.checkedOut && (
                                  <StatusBadge kind="attendance" value="待签退" />
                                )}
                                {activity.checkedOut && (
                                  <StatusBadge kind="attendance" value="签退已记录" />
                                )}
                                {activity.canCheckIn && (
                                  <Button
                                    size="sm"
                                    onClick={() =>
                                      goSection('attendance', { id: activity.id })
                                    }
                                  >
                                    <ScanLineIcon aria-hidden="true" />
                                    去签到
                                  </Button>
                                )}
                                {outWindow && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      goSection('attendance', { id: activity.id })
                                    }
                                  >
                                    去签退
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    goSection('activities', { activity: activity.id })
                                  }
                                >
                                  详情
                                </Button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </section>

              {/* 欢迎卡 + E/M 主读数（桌面左上 8 列） */}
              <section
                aria-label="欢迎与积分"
                className="order-2 md:order-1 md:col-span-8"
              >
                <Card className="h-full">
                  <CardContent className="flex h-full flex-col gap-4 p-5 md:flex-row md:items-start md:justify-between">
                    <div className="flex min-w-0 flex-col gap-3">
                      <div>
                        <p className="text-sm text-muted-foreground">
                          {data.user.realName}（{data.user.studentNo}）·{' '}
                          {membershipLabel(data.user.membership)}
                        </p>
                        <h2 className="mt-1 text-lg font-semibold text-foreground">
                          下午好，{data.user.displayName}
                        </h2>
                      </div>
                      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
                        <div>
                          <p className="text-xs leading-5 text-muted-foreground">
                            有效积分 E（近六个月加权）
                          </p>
                          <p className="text-[36px] leading-[44px] font-semibold tracking-tight text-foreground tabular-nums md:text-[44px] md:leading-[52px]">
                            {data.score.e}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs leading-5 text-muted-foreground">
                            本月原始积分 M（{monthLabel(
                              data.score.components[0]?.month ?? '',
                            )}）
                          </p>
                          <p className="text-[28px] leading-9 font-semibold text-foreground tabular-nums">
                            {data.score.currentMonthM}
                          </p>
                        </div>
                      </div>
                      {data.platformSync.length > 0 && (
                        <ul className="flex flex-wrap gap-2" aria-label="平台同步状态">
                          {data.platformSync.map((sync) => (
                            <li key={sync.platform} className="flex items-center gap-1.5">
                              <span className="text-xs text-muted-foreground">
                                {platformLabel(sync.platform)}
                              </span>
                              <StatusBadge
                                kind="sync"
                                value={
                                  sync.lastSyncStatus === 'failed'
                                    ? '更新失败'
                                    : platformAccountBadge(sync.status)
                                }
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <TrainingRoomArt
                      width={180}
                      height={120}
                      className="hidden shrink-0 sm:block"
                    />
                  </CardContent>
                </Card>
              </section>

              {/* 排名 */}
              <section aria-label="排名" className="order-3 md:col-span-3">
                <Card className="h-full">
                  <CardContent className="flex h-full flex-col gap-2 p-5">
                    <h2 className={cardTitleClass}>
                      <MedalIcon className={cardIconClass} aria-hidden="true" />
                      当前有效榜排名
                    </h2>
                    {data.rank.qualified ? (
                      <>
                        <p className="text-[28px] leading-9 font-semibold text-foreground tabular-nums">
                          第 {data.rank.position} 名
                          <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
                            / {data.rank.total} 人
                          </span>
                        </p>
                        <p className="text-xs leading-5 text-muted-foreground">
                          正式/预备/考察成员参与当前有效榜。
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm leading-[22px] font-medium text-foreground">
                          未参与当前榜
                        </p>
                        <p className="text-xs leading-5 text-muted-foreground">
                          {data.rank.reason ?? '当前身份暂不参与排名。'}
                        </p>
                      </>
                    )}
                  </CardContent>
                </Card>
              </section>

              {/* 出勤 */}
              <section aria-label="出勤" className="order-4 md:col-span-3">
                <Card className="h-full">
                  <CardContent className="flex h-full flex-col gap-2 p-5">
                    <h2 className={cardTitleClass}>
                      <ShieldCheckIcon className={cardIconClass} aria-hidden="true" />
                      必到活动出勤
                    </h2>
                    <p className="text-[28px] leading-9 font-semibold text-foreground tabular-nums">
                      {data.attendance.done}
                      <span className="mx-1 text-sm font-normal text-muted-foreground">/</span>
                      <span className="text-base font-medium text-muted-foreground tabular-nums">
                        {data.attendance.total}
                      </span>
                    </p>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {data.attendance.note ?? '已结算必到活动的到场认定。'}
                    </p>
                  </CardContent>
                </Card>
              </section>

              {/* 待办 */}
              <section aria-label="待办" className="order-5 md:col-span-6">
                <Card className="h-full">
                  <CardContent className="flex h-full flex-col gap-3 p-5">
                    <h2 className={cardTitleClass}>
                      <ListTodoIcon className={cardIconClass} aria-hidden="true" />
                      待办
                    </h2>
                    {data.todos.length === 0 ? (
                      <p className="text-sm leading-[22px] text-muted-foreground">
                        暂无待办，保持节奏就好。
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {data.todos.map((todo) => (
                          <li
                            key={`${todo.kind}-${todo.id}`}
                            className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                          >
                            <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                              {todo.kind === 'disclosure' ? (
                                <CoinsIcon
                                  className="size-4 shrink-0 text-input"
                                  aria-hidden="true"
                                />
                              ) : (
                                <AlarmClockIcon
                                  className="size-4 shrink-0 text-input"
                                  aria-hidden="true"
                                />
                              )}
                              <span className="truncate">{todo.title}</span>
                            </span>
                            {todo.deadline && (
                              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                {relativeDeadline(todo.deadline) ?? formatDateTime(todo.deadline)}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </section>

              {/* 近期安排（桌面右下 4 列；手机位于构成之前） */}
              <UpcomingCard
                upcoming={data.upcoming}
                className="order-6 md:order-7 md:col-span-4"
                onOpen={(id) => goSection('activities', { activity: id })}
              />

              {/* 六个月积分构成（桌面 8 列；手机最后） */}
              <CompositionCard
                components={data.score.components}
                className="order-7 md:order-6 md:col-span-8"
              />
            </div>
            <BindPlatformAccountDialog
              principalId={principalId}
              open={bindOpen}
              onOpenChange={setBindOpen}
              onSuccess={() => setBindSubmitted(true)}
            />
          </div>
        );
      }}
    </QueryBoundary>
  );
}

function UpcomingCard({
  upcoming,
  className,
  onOpen,
}: {
  upcoming: DashboardData['upcoming'];
  className?: string;
  onOpen: (id: string) => void;
}) {
  return (
    <section aria-label="近期安排" className={className}>
      <Card className="h-full">
        <CardContent className="flex h-full flex-col gap-3 p-5">
          <h2 className={cardTitleClass}>
            <CalendarClockIcon className={cardIconClass} aria-hidden="true" />
            近期安排（14 天）
          </h2>
          {upcoming.length === 0 ? (
            <p className="text-sm leading-[22px] text-muted-foreground">
              近两周暂无已发布活动。
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {upcoming.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(item.id)}
                    className="flex w-full items-center justify-between gap-3 py-2.5 text-left"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-foreground">
                        {item.title}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {formatMonthDay(item.startAt)}（{formatWeekday(item.startAt)}）·{' '}
                        {activityTypeLabel(item.type)}
                        {item.venue?.room ? ` · ${item.venue.room}` : ''}
                      </span>
                    </span>
                    {item.myRegistration && (
                      <StatusBadge
                        kind="registration"
                        value={
                          item.myRegistration === 'enrolled'
                            ? '已报名'
                            : item.myRegistration === 'waitlisted'
                              ? '候补中'
                              : item.myRegistration === 'pending_approval'
                                ? '待审核'
                                : '未报名'
                        }
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function CompositionCard({
  components,
  className,
}: {
  components: DashboardData['score']['components'];
  className?: string;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section aria-label="近六个月积分构成" className={className}>
      <Card className="h-full">
        <CardContent className="flex h-full flex-col gap-3 p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className={cardTitleClass}>
              <CoinsIcon className={cardIconClass} aria-hidden="true" />
              近六个月积分构成
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={showTable}
              onClick={() => setShowTable((value) => !value)}
            >
              {showTable ? '显示柱图' : '显示数据表'}
            </Button>
          </div>
          {components.length === 0 ? (
            <p className="text-sm leading-[22px] text-muted-foreground">
              尚无积分记录，参加活动后这里会出现构成。
            </p>
          ) : showTable ? (
            <table className="w-full text-sm">
              <caption className="sr-only">近六个月积分构成等价数据表</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 font-medium">月份</th>
                  <th scope="col" className="py-2 text-right font-medium">当月 M</th>
                  <th scope="col" className="py-2 text-right font-medium">系数</th>
                  <th scope="col" className="py-2 text-right font-medium">贡献</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {components.map((row) => (
                  <tr key={row.month}>
                    <td className="py-2">{monthLabel(row.month)}</td>
                    <td className="py-2 text-right tabular-nums">{row.m}</td>
                    <td className="py-2 text-right text-muted-foreground tabular-nums">
                      ×{row.weight}
                    </td>
                    <td className="py-2 text-right font-medium tabular-nums">
                      {row.contribution}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <>
              <MonthBars
                data={components.map((c) => ({ month: c.month, raw: c.m, weight: c.weight }))}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                柱高为当月原始积分 M，柱下系数为该月的有效权重（当月 ×1，往前依次
                ×0.85 / ×0.7 / ×0.55 / ×0.4 / ×0.25）。
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
