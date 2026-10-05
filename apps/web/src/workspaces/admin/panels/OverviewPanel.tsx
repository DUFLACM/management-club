/**
 * 管理端 · 概览：GET /admin/dashboard。
 * 响应式业务状态网格 + 当天活动；无权限显示 EmptyState forbidden。
 */
import { Link } from 'react-router';
import {
  ArrowUpRightIcon,
  CalendarDaysIcon,
  ClipboardListIcon,
  CloudOffIcon,
  CoinsIcon,
  FileClockIcon,
  MapPinnedIcon,
  UserPlusIcon,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrincipal } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PanelHeader } from '@/components/club/PanelHeader';
import { PrincipalGate, QueryBoundary } from '@/components/club/QueryBoundary';
import { Card, CardContent } from '@/components/ui/card';

interface AdminDashboardDto {
  counts: {
    pendingApplications: number;
    pendingVenueReviews: number;
    attendanceAnomalies: number;
    pendingClaims: number;
    openDisclosures: number;
    syncFailures: number;
  };
  todayActivities: Array<{
    id: string;
    title: string;
    startAt: string;
    venue: string | null;
  }>;
}

export default function OverviewPanel() {
  const principal = usePrincipal();
  return (
    <PrincipalGate principal={principal}>
      {(principalId) => <OverviewBody principalId={principalId} />}
    </PrincipalGate>
  );
}

function OverviewBody({ principalId }: { principalId: string }) {
  const query = usePrivateQuery<AdminDashboardDto, ApiError>(
    principalId,
    ['admin', 'dashboard'],
    async () => (await api.get<AdminDashboardDto>('/admin/dashboard')).data,
  );

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader title="管理概览" description="今天的待办与现场活动。" />
      <QueryBoundary query={query}>
        {(data) => {
          const cards = [
            {
              key: 'pendingApplications',
              label: '待审批入社申请',
              value: data.counts.pendingApplications,
              icon: UserPlusIcon,
              href: '/admin?section=members',
            },
            {
              key: 'pendingVenueReviews',
              label: '待认证地点',
              value: data.counts.pendingVenueReviews,
              icon: MapPinnedIcon,
              href: '/admin?section=activities&tab=venues',
            },
            {
              key: 'attendanceAnomalies',
              label: '出勤待复核',
              value: data.counts.attendanceAnomalies,
              icon: FileClockIcon,
              href: '/admin?section=activities',
            },
            {
              key: 'pendingClaims',
              label: '贡献申报待审',
              value: data.counts.pendingClaims,
              icon: ClipboardListIcon,
              href: '/admin?section=points&tab=claims',
            },
            {
              key: 'syncFailures',
              label: '同步失败任务',
              value: data.counts.syncFailures,
              icon: CloudOffIcon,
              href: '/admin?section=sync',
            },
            {
              key: 'openDisclosures',
              label: '进行中的积分公示',
              value: data.counts.openDisclosures,
              icon: CoinsIcon,
              href: '/admin?section=points',
            },
          ] as const;
          return (
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-12 xl:items-stretch">
              <section aria-labelledby="admin-overview-status" className="min-w-0 xl:col-span-8">
                <div className="mb-3 flex items-end justify-between gap-3">
                  <div>
                    <h2
                      id="admin-overview-status"
                      className="text-sm leading-[22px] font-semibold text-foreground"
                    >
                      待办与状态
                    </h2>
                    <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                      点击卡片进入对应业务
                    </p>
                  </div>
                </div>

                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {cards.map((card) => {
                    const Icon = card.icon;
                    const requiresAttention = card.value > 0;
                    return (
                      <li key={card.key} className="min-w-0">
                        <Link
                          to={card.href}
                          className="group block h-full rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          <Card
                            className={cn(
                              'h-full min-h-32 transition-[border-color,background-color,box-shadow,transform] duration-150 group-hover:-translate-y-0.5 group-hover:border-primary/40 group-hover:shadow-md',
                              requiresAttention && 'border-primary/25 bg-primary/[0.025]',
                            )}
                          >
                            <CardContent className="flex h-full flex-col justify-between gap-4 p-4 sm:p-5">
                              <div className="flex items-start justify-between gap-2">
                                <span
                                  className={cn(
                                    'flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground',
                                    requiresAttention && 'bg-primary/10 text-primary',
                                  )}
                                >
                                  <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
                                </span>
                                <ArrowUpRightIcon
                                  className="size-4 shrink-0 text-muted-foreground/60 transition-[color,transform] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary"
                                  aria-hidden="true"
                                />
                              </div>
                              <div className="min-w-0">
                                <span
                                  className={cn(
                                    'block text-[28px] leading-8 font-semibold tracking-tight text-foreground tabular-nums',
                                    requiresAttention && 'text-primary',
                                  )}
                                >
                                  {card.value}
                                </span>
                                <span className="mt-1 block text-xs leading-5 text-muted-foreground sm:text-sm">
                                  {card.label}
                                </span>
                              </div>
                            </CardContent>
                          </Card>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section aria-labelledby="admin-overview-today" className="min-w-0 xl:col-span-4">
                <Card className="h-full min-h-56 overflow-hidden">
                  <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
                    <h2
                      id="admin-overview-today"
                      className="flex items-center gap-2 text-sm font-semibold text-foreground"
                    >
                      <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <CalendarDaysIcon className="size-4" aria-hidden="true" />
                      </span>
                      今天的活动
                    </h2>
                    <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground tabular-nums">
                      {data.todayActivities.length} 场
                    </span>
                  </div>
                  <CardContent className="p-0">
                    {data.todayActivities.length === 0 ? (
                      <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-5 py-8 text-center">
                        <CalendarDaysIcon className="size-6 text-muted-foreground/50" aria-hidden="true" />
                        <p className="text-sm leading-[22px] text-muted-foreground">
                          今天没有安排活动
                        </p>
                      </div>
                    ) : (
                      <ul className="divide-y divide-border">
                        {data.todayActivities.map((activity) => (
                          <li key={activity.id}>
                            <Link
                              to={`/admin?section=activities&activity=${activity.id}`}
                              className="group flex min-w-0 items-start gap-3 px-5 py-4 outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium text-foreground group-hover:text-primary">
                                  {activity.title}
                                </span>
                                <span className="mt-1 block text-xs leading-5 text-muted-foreground tabular-nums">
                                  {formatDateTime(activity.startAt)}
                                </span>
                                {activity.venue && (
                                  <span className="mt-0.5 block truncate text-xs leading-5 text-muted-foreground">
                                    {activity.venue}
                                  </span>
                                )}
                              </span>
                              <ArrowUpRightIcon
                                className="mt-0.5 size-4 shrink-0 text-muted-foreground/60 transition-[color,transform] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary"
                                aria-hidden="true"
                              />
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </section>
            </div>
          );
        }}
      </QueryBoundary>
    </div>
  );
}
