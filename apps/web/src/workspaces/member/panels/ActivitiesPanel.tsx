/**
 * 成员端 · 活动目录：GET /activities?tab=&type=&q=&cursor=
 * 详情 GET /activities/:id（公告/报名/出勤三区）；报名/取消/请假/远程申请写操作。
 * 桌面详情 Sheet（600px），手机全高 Drawer。
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLinkIcon, LoaderCircleIcon, SearchIcon } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrivateInfiniteQuery } from '@/lib/private-infinite';
import { usePrincipal } from '@/lib/session';
import { useDebouncedValue, LoadMoreButton } from '@/lib/hooks';
import {
  ACTIVITY_TYPE_LABELS,
  activityTypeLabel,
  formatDateTime,
  formatStartEnd,
  formatVenue,
  platformContestUrl,
  platformLabel,
  policyLabel,
  relativeDeadline,
} from '@/lib/format';
import { PanelHeader } from '@/components/club/PanelHeader';
import { MemberGate } from '@/components/club/QueryBoundary';
import { ErrorState } from '@/components/club/ErrorState';
import { ResponsiveDetail } from '@/components/club/ResponsiveDetail';
import { StatusBadge } from '@/components/club/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

interface ActivityCardDto {
  id: string;
  type: string;
  platform: string | null;
  platformContestId: string | null;
  title: string;
  startAt: string;
  endAt: string;
  registerDeadline: string | null;
  cancelDeadline: string | null;
  capacity: number | null;
  enrolledCount: number;
  requiredCount: number;
  waitlistCapacity: number | null;
  venue: { name: string; building: string | null; room: string | null } | null;
  attendancePolicy: string | null;
  remoteAllowed: boolean;
  requireValidSubmission: boolean;
  myRegistration: { status: string; waitlistSeq: number | null } | null;
}

interface ActivityDetailDto {
  id: string;
  type: string;
  title: string;
  status: string;
  platform: string | null;
  platformContestId: string | null;
  announcement: string;
  joinNotes: string | null;
  startAt: string;
  endAt: string;
  registerStartAt: string | null;
  registerDeadline: string | null;
  cancelDeadline: string | null;
  leaveDeadline: string | null;
  capacity: number | null;
  waitlistCapacity: number | null;
  remoteAllowed: boolean;
  remotePolicy: string | null;
  requireValidSubmission: boolean;
  scoringConfig: Record<string, unknown> | null;
  registrations: Array<{ status: string; waitlistSeq: number | null }>;
  participants: Array<{ required: boolean }>;
  leaveRequests: Array<{ status: string; reason: string }>;
  remotePermissions: Array<{ status: string; reason: string }>;
  checkpoints: Array<{ checkpoint: 'IN' | 'OUT'; acceptedAt: string; method: string }>;
  policy: {
    policy: string;
    checkinOpenAt: string;
    checkinCloseAt: string;
    checkoutOpenAt: string | null;
    checkoutCloseAt: string | null;
    maxAccuracyMeters: string | number;
  } | null;
  venueBindings: Array<{
    venueVersionId: string;
    venueVersion: { building: string | null; room: string | null; venue: { name: string } };
  }>;
}

const TAB_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'open', label: '可报名' },
  { value: 'mine', label: '我的报名' },
  { value: 'ongoing', label: '进行中' },
  { value: 'ended', label: '已结束' },
];

function registrationBadgeOf(status: string | null | undefined): string {
  if (!status) return '未报名';
  if (status === 'enrolled') return '已报名';
  if (status === 'waitlisted') return '候补中';
  if (status === 'pending_approval') return '待审核';
  if (status === 'cancelled') return '已取消';
  return status;
}

export default function ActivitiesPanel() {
  const principal = usePrincipal();
  return (
    <MemberGate principal={principal}>
      {(principalId) => <ActivitiesBody principalId={principalId} />}
    </MemberGate>
  );
}

function ActivitiesBody({ principalId }: { principalId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') ?? 'all';
  const type = searchParams.get('type') ?? 'all';
  const activityId = searchParams.get('activity');
  const [searchInput, setSearchInput] = useState(searchParams.get('q') ?? '');
  const debouncedSearch = useDebouncedValue(searchInput, 450);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setSearchParams((previous) => {
        const next = new URLSearchParams(previous);
        if (value == null || value === '' || value === 'all') next.delete(key);
        else next.set(key, value);
        return next;
      });
    },
    [setSearchParams],
  );

  // 搜索词延迟写入 URL（作为查询 key 的一部分）
  useEffect(() => {
    if ((searchParams.get('q') ?? '') !== debouncedSearch) {
      setParam('q', debouncedSearch === '' ? null : debouncedSearch);
    }
  }, [debouncedSearch, searchParams, setParam]);

  const listQuery = usePrivateInfiniteQuery<{ items: ActivityCardDto[]; nextCursor?: string | null }, ApiError>(
    principalId,
    ['activities', 'list', tab, type, debouncedSearch],
    async (cursor) => {
      const params = new URLSearchParams({ tab });
      if (type !== 'all') params.set('type', type);
      if (debouncedSearch) params.set('q', debouncedSearch);
      if (cursor) params.set('cursor', cursor);
      const { data } = await api.get<{ items: ActivityCardDto[]; nextCursor?: string | null }>(
        `/activities?${params.toString()}`,
      );
      return data;
    },
  );

  const items = listQuery.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader title="活动" description="周赛、训练、讲座与集体活动的报名与详情。" />
      <Tabs value={tab} onValueChange={(value) => setParam('tab', value === 'all' ? null : value)}>
        <TabsList aria-label="活动状态">
          {TAB_OPTIONS.map((option) => (
            <TabsTrigger key={option.value} value={option.value}>
              {option.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:w-64">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="搜索活动标题"
            className="pl-9"
            aria-label="搜索活动标题"
          />
        </div>
        <Select value={type} onValueChange={(value) => setParam('type', value)}>
          <SelectTrigger className="sm:w-44" aria-label="活动类型筛选">
            <SelectValue placeholder="全部类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            {Object.entries(ACTIVITY_TYPE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {listQuery.isPending ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-44 rounded-2xl" />
          ))}
        </div>
      ) : listQuery.isError ? (
        <Card>
          <CardContent className="py-10">
            <ErrorState
              description={listQuery.error.message}
              onRetry={() => {
                void listQuery.refetch();
              }}
              retrying={listQuery.isFetching}
            />
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {tab === 'mine'
              ? '还没有报名记录；切到「可报名」看看近期活动。'
              : debouncedSearch
                ? '没有匹配搜索条件的活动。'
                : '这里还没有活动，稍后再来看看。'}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {items.map((item) => (
            <ActivityCardView
              key={item.id}
              item={item}
              onOpen={() => setParam('activity', item.id)}
            />
          ))}
        </div>
      )}
      {!listQuery.isPending && !listQuery.isError && (
        <LoadMoreButton
          onClick={() => {
            void listQuery.fetchNextPage();
          }}
          loading={listQuery.isFetchingNextPage}
          hasNext={Boolean(listQuery.data?.pages.at(-1)?.nextCursor)}
          hint="已展示全部活动"
        />
      )}

      {activityId && (
        <ActivityDetail
          principalId={principalId}
          activityId={activityId}
          onClose={() => setParam('activity', null)}
        />
      )}
    </div>
  );
}

function ActivityCardView({ item, onOpen }: { item: ActivityCardDto; onOpen: () => void }) {
  const seats = item.capacity == null ? '不限' : `${item.enrolledCount}/${item.capacity}`;
  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            onClick={onOpen}
            className="min-w-0 text-left text-[15px] leading-6 font-semibold text-foreground hover:text-primary"
          >
            {item.title}
          </button>
          {item.myRegistration && (
            <StatusBadge kind="registration" value={registrationBadgeOf(item.myRegistration.status)} />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-foreground/80">
            {activityTypeLabel(item.type)}
          </span>
          {item.requireValidSubmission && <span>需有效提交</span>}
          {item.attendancePolicy && <span>签到：{item.attendancePolicy}</span>}
          {item.platform && <span>{platformLabel(item.platform)} 平台赛</span>}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">时间</dt>
          <dd className="text-foreground">{formatStartEnd(item.startAt, item.endAt)}</dd>
          <dt className="text-muted-foreground">地点</dt>
          <dd className="text-foreground">{formatVenue(item.venue)}</dd>
          <dt className="text-muted-foreground">报名截止</dt>
          <dd className="text-foreground">
            {item.registerDeadline ? formatDateTime(item.registerDeadline) : '待公布'}
          </dd>
          <dt className="text-muted-foreground">名额</dt>
          <dd className="text-foreground tabular-nums">
            {seats}
            {item.waitlistCapacity ? ` · 候补 ${item.waitlistCapacity}` : ''}
          </dd>
        </dl>
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          {item.requiredCount > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              必到 {item.requiredCount} 人
            </span>
          )}
          <Button size="sm" variant="outline" onClick={onOpen}>
            详情与报名
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ActivityDetail({
  principalId,
  activityId,
  onClose,
}: {
  principalId: string;
  activityId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [leaveReason, setLeaveReason] = useState('');
  const [remoteReason, setRemoteReason] = useState('');
  const [showLeaveForm, setShowLeaveForm] = useState(false);
  const [showRemoteForm, setShowRemoteForm] = useState(false);

  const query = usePrivateQuery<ActivityDetailDto, ApiError>(
    principalId,
    ['activities', 'detail', activityId],
    async () => (await api.get<ActivityDetailDto>(`/activities/${activityId}`)).data,
  );

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'activities'] });
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'me'] });
  }, [principalId, queryClient]);

  const registerMutation = useMutation({
    mutationFn: async () =>
      (
        await api.post<{ status: string; waitlistSeq: number | null; message: string }>(
          `/activities/${activityId}/registrations`,
          { idempotencyKey: crypto.randomUUID() },
        )
      ).data,
    onSuccess: (result) => {
      setActionError(null);
      setActionNotice(result.message);
      invalidate();
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async () =>
      (await api.delete<{ status: string; promoted?: string }>(`/activities/${activityId}/registrations/me`)).data,
    onSuccess: (result) => {
      setActionError(null);
      setActionNotice(
        result.promoted === 'enrolled'
          ? '已取消报名；候补第一位已递补。'
          : result.promoted === 'confirm_required'
            ? '已取消报名；候补第一位需确认是否递补。'
            : '已取消报名。',
      );
      invalidate();
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  const leaveMutation = useMutation({
    mutationFn: async (reason: string) => {
      await api.post(`/activities/${activityId}/leave-requests`, { reason });
      return true;
    },
    onSuccess: () => {
      setActionError(null);
      setActionNotice('请假申请已提交，等待负责人审核。');
      setShowLeaveForm(false);
      setLeaveReason('');
      invalidate();
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  const remoteMutation = useMutation({
    mutationFn: async (reason: string) => {
      await api.post(`/activities/${activityId}/remote-requests`, { reason });
      return true;
    },
    onSuccess: () => {
      setActionError(null);
      setActionNotice('远程参赛申请已提交（点击不等于取得计分许可，需审批）。');
      setShowRemoteForm(false);
      setRemoteReason('');
      invalidate();
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  const platformUrl = query.data
    ? platformContestUrl(query.data.platform, query.data.platformContestId)
    : null;

  return (
    <ResponsiveDetail
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={query.data?.title ?? '活动详情'}
      description={
        query.data
          ? `${activityTypeLabel(query.data.type)} · ${formatStartEnd(query.data.startAt, query.data.endAt)}`
          : undefined
      }
    >
      {query.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      ) : query.isError ? (
        <ErrorDetail error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          {actionError && (
            <Alert variant="destructive">
              <AlertTitle>操作未完成</AlertTitle>
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}
          {actionNotice && !actionError && (
            <Alert>
              <AlertTitle>已更新</AlertTitle>
              <AlertDescription>{actionNotice}</AlertDescription>
            </Alert>
          )}

          {query.data.platform && (
            <Alert>
              <AlertTitle>
                {platformLabel(query.data.platform)}平台赛：社团报名与平台报名分别办理
              </AlertTitle>
              <AlertDescription>
                在本页完成社团侧报名/签到记录；比赛本身仍需
                {platformUrl ? (
                  <a
                    href={platformUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mx-1 inline-flex items-center gap-0.5 font-medium text-primary underline-offset-2 hover:underline"
                  >
                    去平台报名
                    <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                  </a>
                ): (
                  ' 去平台报名'
                )}
                ，两边互不替代。
              </AlertDescription>
            </Alert>
          )}

          {/* 公告 */}
          <section aria-label="公告" className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-foreground">公告</h3>
            <p className="text-sm leading-[22px] whitespace-pre-wrap text-foreground/90">
              {query.data.announcement}
            </p>
            {query.data.joinNotes && (
              <p className="text-sm leading-[22px] whitespace-pre-wrap text-muted-foreground">
                参加须知：{query.data.joinNotes}
              </p>
            )}
            {query.data.scoringConfig && (
              <p className="text-xs leading-5 text-muted-foreground">
                计分配置：{JSON.stringify(query.data.scoringConfig)}
              </p>
            )}
          </section>

          {/* 报名 */}
          <section aria-label="报名" className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-foreground">报名</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">报名开始</dt>
              <dd>{query.data.registerStartAt ? formatDateTime(query.data.registerStartAt) : '随公告开放'}</dd>
              <dt className="text-muted-foreground">报名截止</dt>
              <dd>{formatDateTime(query.data.registerDeadline)}</dd>
              <dt className="text-muted-foreground">取消截止</dt>
              <dd>{formatDateTime(query.data.cancelDeadline)}</dd>
              <dt className="text-muted-foreground">请假截止</dt>
              <dd>{formatDateTime(query.data.leaveDeadline)}</dd>
              <dt className="text-muted-foreground">容量/候补</dt>
              <dd className="tabular-nums">
                {query.data.capacity ?? '不限'} / {query.data.waitlistCapacity ?? 0}
              </dd>
            </dl>
            {query.data.registrations[0] ? (
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge kind="registration" value={registrationBadgeOf(query.data.registrations[0].status)} />
                {query.data.registrations[0].status === 'waitlisted' &&
                  query.data.registrations[0].waitlistSeq != null && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      候补第 {query.data.registrations[0].waitlistSeq} 位
                    </span>
                  )}
              </div>
            ) : !query.data.participants[0]?.required ? (
              <p className="text-sm text-muted-foreground">当前未报名。</p>
            ) : null}
            {query.data.participants[0]?.required && (
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge kind="registration" value="必到名单" />
                <p className="text-sm text-muted-foreground">
                  {query.data.registrations[0]?.status === 'enrolled'
                    ? '已报名，如需缺席请提交请假申请。'
                    : '现场签到成功后自动报名；如需缺席请提交请假申请。出勤截止无操作将记为缺勤。'}
                </p>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {!query.data.participants[0]?.required && (!query.data.registrations[0] ||
                !['enrolled', 'waitlisted', 'pending_approval'].includes(
                  query.data.registrations[0].status,
                )) && (
                <Button
                  onClick={() => registerMutation.mutate()}
                  disabled={registerMutation.isPending}
                >
                  {registerMutation.isPending && (
                    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  )}
                  报名
                </Button>
              )}
              {!query.data.participants[0]?.required && query.data.registrations[0] &&
                ['enrolled', 'waitlisted', 'pending_approval'].includes(
                  query.data.registrations[0].status,
                ) && (
                  <Button
                    variant="outline"
                    onClick={() => cancelMutation.mutate()}
                    disabled={cancelMutation.isPending}
                  >
                    {cancelMutation.isPending && (
                      <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                    )}
                    取消报名
                  </Button>
                )}
              {!showLeaveForm && (
                <Button variant="ghost" onClick={() => setShowLeaveForm(true)}>
                  请假
                </Button>
              )}
              {query.data.remoteAllowed && !showRemoteForm && (
                <Button variant="ghost" onClick={() => setShowRemoteForm(true)}>
                  申请远程
                </Button>
              )}
            </div>
            {query.data.remoteAllowed && query.data.remotePolicy && (
              <p className="text-xs leading-5 text-muted-foreground">
                远程规则：{query.data.remotePolicy}
              </p>
            )}
            {showLeaveForm && (
              <form
                className="flex flex-col gap-2 rounded-xl border border-border p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (leaveReason.trim().length >= 3) leaveMutation.mutate(leaveReason.trim());
                }}
              >
                <Label htmlFor="leave-reason">请假原因（至少 3 字）</Label>
                <Textarea
                  id="leave-reason"
                  value={leaveReason}
                  onChange={(event) => setLeaveReason(event.target.value)}
                  rows={3}
                  maxLength={1000}
                  required
                />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={leaveMutation.isPending || leaveReason.trim().length < 3}>
                    {leaveMutation.isPending && (
                      <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                    )}
                    提交请假
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setShowLeaveForm(false)}>
                    收起
                  </Button>
                </div>
              </form>
            )}
            {showRemoteForm && (
              <form
                className="flex flex-col gap-2 rounded-xl border border-border p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (remoteReason.trim().length >= 3) remoteMutation.mutate(remoteReason.trim());
                }}
              >
                <Label htmlFor="remote-reason">远程参赛原因（至少 3 字）</Label>
                <Textarea
                  id="remote-reason"
                  value={remoteReason}
                  onChange={(event) => setRemoteReason(event.target.value)}
                  rows={3}
                  maxLength={1000}
                  required
                />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={remoteMutation.isPending || remoteReason.trim().length < 3}>
                    {remoteMutation.isPending && (
                      <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                    )}
                    提交申请
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setShowRemoteForm(false)}>
                    收起
                  </Button>
                </div>
              </form>
            )}
            {query.data.leaveRequests[0] && (
              <p className="text-xs text-muted-foreground">
                当前请假申请状态：
                {query.data.leaveRequests[0].status === 'approved'
                  ? '已批准'
                  : query.data.leaveRequests[0].status === 'rejected'
                    ? '已驳回'
                    : '待审核'}
              </p>
            )}
            {query.data.remotePermissions[0] && (
              <p className="text-xs text-muted-foreground">
                远程申请状态：
                {query.data.remotePermissions[0].status === 'approved'
                  ? '已批准'
                  : query.data.remotePermissions[0].status === 'rejected'
                    ? '已驳回'
                    : '待审核'}
              </p>
            )}
            {query.data.registerDeadline && (
              <p className="text-xs text-muted-foreground">
                {relativeDeadline(query.data.registerDeadline) ?? '报名已截止'}（截止{' '}
                {formatDateTime(query.data.registerDeadline)}）
              </p>
            )}
          </section>

          {/* 出勤 */}
          <section aria-label="出勤" className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-foreground">出勤</h3>
            {query.data.policy ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">签到方式</dt>
                <dd>{policyLabel(query.data.policy.policy)}</dd>
                <dt className="text-muted-foreground">签到窗口</dt>
                <dd>
                  {formatStartEnd(query.data.policy.checkinOpenAt, query.data.policy.checkinCloseAt)}
                </dd>
                {query.data.policy.checkoutOpenAt && query.data.policy.checkoutCloseAt && (
                  <>
                    <dt className="text-muted-foreground">签退窗口</dt>
                    <dd>
                      {formatStartEnd(query.data.policy.checkoutOpenAt, query.data.policy.checkoutCloseAt)}
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">定位精度阈值</dt>
                <dd className="tabular-nums">
                  ±{Number(query.data.policy.maxAccuracyMeters)} 米
                </dd>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">本活动未配置现场签到策略。</p>
            )}
            <ul className="flex flex-col gap-1 text-sm">
              {query.data.venueBindings.map((binding) => (
                <li key={binding.venueVersionId} className="text-foreground">
                  {[binding.venueVersion.venue.name, binding.venueVersion.building, binding.venueVersion.room]
                    .filter(Boolean)
                    .join(' ')}
                </li>
              ))}
              {query.data.venueBindings.length === 0 && (
                <li className="text-muted-foreground">地点待公布</li>
              )}
            </ul>
            <div className="flex flex-wrap gap-2">
              {(['IN', 'OUT'] as const).map((checkpoint) => {
                const record = query.data.checkpoints.find((c) => c.checkpoint === checkpoint);
                return (
                  <span key={checkpoint} className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    {checkpoint === 'IN' ? '签到' : '签退'}：
                    {record ? (
                      <>
                        <StatusBadge
                          kind="attendance"
                          value={record.method === 'QR' ? '二维码签到已记录' : '签到已记录'}
                        />
                        <span className="text-xs tabular-nums">{formatDateTime(record.acceptedAt)}</span>
                      </>
                    ) : (
                      '未记录'
                    )}
                  </span>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </ResponsiveDetail>
  );
}

function ErrorDetail({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <p className="text-sm font-medium text-foreground">详情加载失败</p>
      <p className="text-sm text-muted-foreground">{error.message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}
