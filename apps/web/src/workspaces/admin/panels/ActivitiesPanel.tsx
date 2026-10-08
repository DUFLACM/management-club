/**
 * 管理端 · 活动与地点。
 * - tab=activities：GET /admin/activities?status=&q=&cursor=；创建（自定义活动，可选关联平台比赛）；
 *   详情（公告设置/报名候补/现场出勤/参与核验/归档）+ 发布 + 必到名单 + 结算候选 + 现场码大屏。
 * - tab=venues：GET /admin/venues（认证状态 + 运行状态双徽标）；新增地点（venueDraftSchema）、
 *   版本详情（贡献者/样本/审核事件/绑定活动）、现场采样（点击定位）、提交认证、审核
 *   （有地点审核权限即可审核，含创建者本人）、停用/恢复/归档（停用前 impact 预览）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LoaderCircleIcon,
  RefreshCwIcon,
  MonitorPlayIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrivateInfiniteQuery } from '@/lib/private-infinite';
import { usePrincipal } from '@/lib/session';
import { useDebouncedValue, LoadMoreButton } from '@/lib/hooks';
import { ACTIVITY_TYPE_LABELS, activityTypeLabel, formatDateTime, formatStartEnd, policyLabel, toLocalInputValue, fromLocalInputValue, memberName } from '@/lib/format';
import { PanelHeader } from '@/components/club/PanelHeader';
import { AttendanceQrBoard } from '@/components/club/AttendanceQrBoard';
import { PrincipalGate } from '@/components/club/QueryBoundary';
import { EmptyState } from '@/components/club/EmptyState';
import { ErrorState } from '@/components/club/ErrorState';
import { ResponsiveDetail } from '@/components/club/ResponsiveDetail';
import { StatusBadge } from '@/components/club/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

interface AdminActivityRow {
  id: string;
  type: string;
  status: string;
  sourceType: string;
  platform: string | null;
  title: string;
  startAt: string;
  endAt: string;
  registerDeadline: string | null;
  cancelDeadline: string | null;
  capacity: number | null;
  waitlistCapacity: number | null;
  remoteAllowed: boolean;
  announcement: string;
  policy: { policy: string } | null;
  venueVersion: { building: string | null; room: string | null; venue?: { name: string } } | null;
  _count?: { registrations: number };
}

interface ActivityDetailDto {
  id: string;
  revision: number;
  type: string;
  title: string;
  status: string;
  sourceType: string;
  platform: string | null;
  platformContestId: string | null;
  announcement: string;
  joinNotes: string | null;
  startAt: string;
  endAt: string;
  registerStartAt: string | null;
  registerDeadline: string | null;
  cancelDeadline: string | null;
  capacity: number | null;
  waitlistCapacity: number | null;
  remoteAllowed: boolean;
  remotePolicy: string | null;
  requireValidSubmission: boolean;
  scoringConfig: Record<string, unknown> | null;
  venueVersionId: string | null;
  policy: {
    policy: string;
    checkinOpenAt: string;
    checkinCloseAt: string;
    checkoutOpenAt: string | null;
    checkoutCloseAt: string | null;
    maxAccuracyMeters: string | number;
    qrRotateSeconds: number;
    qrTtlSeconds: number;
    selfCheckout: boolean;
    autoCheckout: boolean;
  } | null;
  registrations: Array<{ status: string; waitlistSeq: number | null }>;
  participants: Array<{ required: boolean }>;
  venueBindings: Array<{
    venueVersionId: string;
    venueVersion: { building: string | null; room: string | null; venue: { name: string } };
  }>;
}

interface AttendanceListDto {
  items: Array<{
    userId: string;
    name: string | null;
    studentNo: string;
    required: boolean;
    regStatus: string;
    checkin: string | null;
    checkout: string | null;
    resultStatus: string | null;
    leave: string | null;
  }>;
  stats: {
    total: number;
    checkedIn: number;
    checkedOut: number;
    notCheckedIn: number;
    leaveApproved: number;
    pendingReview: number;
  };
}

interface VenueRowDto {
  id: string;
  name: string;
  campus: string | null;
  building: string | null;
  floor: string | null;
  room: string | null;
  operationalStatus: string;
  suspendReason: string | null;
  effectiveVersionId: string | null;
  versions: Array<{
    id: string;
    versionNo: number;
    status: string;
    name: string;
    building: string | null;
    room: string | null;
    allowedCapabilities: string[];
    validFrom: string | null;
    validUntil: string | null;
    revokedAt: string | null;
    approvedAt: string | null;
    rejectedReason: string | null;
    submittedAt: string | null;
  }>;
  versionCount: number;
}

interface VenueVersionDetail {
  id: string;
  versionNo: number;
  status: string;
  revision: number;
  name: string;
  campus: string | null;
  building: string | null;
  floor: string | null;
  room: string | null;
  description: string | null;
  directions: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
  radiusMeters: string | number | null;
  maxAccuracyMeters: string | number | null;
  allowedCapabilities: string[];
  validFrom: string | null;
  validUntil: string | null;
  revokedAt: string | null;
  rejectedReason: string | null;
  contributors: Array<{ id: string; principalId: string; role: string; lastAt: string | null }>;
  samples: Array<{
    id: string;
    source: string;
    sampledAt: string;
    accuracyMeters: string | number | null;
    deviceType: string | null;
    note: string | null;
  }>;
  reviewEvents: Array<{ id: string; action: string; note: string | null; createdAt: string }>;
  activityBindings: Array<{
    activityId: string;
    activity: { id: string; title: string; status: string; startAt: string };
  }>;
}

const ACTIVITY_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  published: '已发布',
  cancelled: '已取消',
  archived: '已归档',
};

function activityStatusLabel(status: string): string {
  return ACTIVITY_STATUS_LABELS[status] ?? status;
}

export default function ActivitiesPanel() {
  const principal = usePrincipal();
  return (
    <PrincipalGate principal={principal}>
      {(principalId) => <ActivitiesBody principalId={principalId} />}
    </PrincipalGate>
  );
}

function ActivitiesBody({ principalId }: { principalId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'venues' ? 'venues' : 'activities';

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="活动与地点"
        description="创建与发布活动、导入平台赛事；地点认证与现场码。"
      />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          setSearchParams((previous) => {
            const next = new URLSearchParams(previous);
            if (value === 'activities') next.delete('tab');
            else next.set('tab', value);
            next.delete('activity');
            next.delete('venue');
            return next;
          })
        }
      >
        <TabsList aria-label="活动/地点">
          <TabsTrigger value="activities">活动</TabsTrigger>
          <TabsTrigger value="venues">地点</TabsTrigger>
        </TabsList>
        <TabsContent value="activities" className="mt-4">
          <ActivitiesTab principalId={principalId} />
        </TabsContent>
        <TabsContent value="venues" className="mt-4">
          <VenuesTab principalId={principalId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ======================= 活动 =======================

function ActivitiesTab({ principalId }: { principalId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 450);
  const [createOpen, setCreateOpen] = useState(false);
  const detailId = searchParams.get('activity');

  const listQuery = usePrivateInfiniteQuery<
    { items: AdminActivityRow[]; nextCursor?: string | null },
    ApiError
  >(
    principalId,
    ['admin', 'activities', 'list', status, debouncedSearch],
    async (cursor) => {
      const params = new URLSearchParams();
      if (status !== 'all') params.set('status', status);
      if (debouncedSearch) params.set('q', debouncedSearch);
      if (cursor) params.set('cursor', cursor);
      const { data, meta } = await api.get<AdminActivityRow[]>(
        `/admin/activities?${params.toString()}`,
      );
      return { items: data, nextCursor: meta?.nextCursor };
    },
  );

  const items = listQuery.data?.pages.flatMap((page) => page.items) ?? [];

  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [batchResult, setBatchResult] = useState<{ deletedCount: number; skipped: Array<{ label: string; reason: string }> } | null>(null);

  const toggleSelected = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allVisibleSelected = items.length > 0 && items.every((activity) => selected.has(activity.id));
  const toggleAllVisible = () => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (allVisibleSelected) items.forEach((activity) => next.delete(activity.id));
      else items.forEach((activity) => next.add(activity.id));
      return next;
    });
  };

  const batchDeleteMutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ deletedCount: number; skipped: Array<{ id: string; label: string; reason: string }> }>(
        '/admin/activities/batch-delete',
        { activityIds: [...selected] },
      );
      return data;
    },
    onSuccess: (result) => {
      setBatchResult({ deletedCount: result.deletedCount, skipped: result.skipped.map(({ label, reason }) => ({ label, reason })) });
      setConfirmBatch(false);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'activities'] });
    },
    onError: (error: ApiError) => {
      setBatchResult({ deletedCount: 0, skipped: [{ label: '批量删除请求失败', reason: error.message }] });
      setConfirmBatch(false);
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative lg:w-64">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="搜索活动标题"
            className="pl-9"
            aria-label="搜索活动"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="lg:w-40" aria-label="状态筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="draft">草稿</SelectItem>
            <SelectItem value="published">已发布</SelectItem>
            <SelectItem value="cancelled">已取消</SelectItem>
            <SelectItem value="archived">已归档</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex flex-wrap gap-2 lg:ml-auto">
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon aria-hidden="true" />
            新建活动
          </Button>
        </div>
      </div>

      {listQuery.isPending ? (
        <Card>
          <CardContent className="flex flex-col gap-2 p-5">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-12" />
            ))}
          </CardContent>
        </Card>
      ) : listQuery.isError ? (
        <Card>
          <CardContent className="py-10">
            {listQuery.error.status === 403 ? (
              <EmptyState kind="forbidden" description={listQuery.error.message} />
            ) : (
              <ErrorState
                description={listQuery.error.message}
                onRetry={() => void listQuery.refetch()}
                retrying={listQuery.isFetching}
              />
            )}
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10">
            <EmptyState kind="empty" description="还没有活动；点右上角「新建活动」创建。" />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 pb-2">
            {batchResult && (
              <div className="mx-5 mt-4 rounded-xl border border-border bg-muted/40 p-3 text-sm">
                <p className="font-medium text-foreground">已删除 {batchResult.deletedCount} 个活动</p>
                {batchResult.skipped.length > 0 && (
                  <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
                    {batchResult.skipped.map((item, index) => (
                      <li key={index}>跳过 {item.label}：{item.reason}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {(selected.size > 0 || batchResult) && (
              <div className="mx-5 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-border p-3">
                <span className="text-sm font-medium text-foreground">已选 {selected.size} 项</span>
                <Button size="sm" variant="ghost" onClick={toggleAllVisible}>
                  {allVisibleSelected ? '取消全选' : '全选本页'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  清除选择
                </Button>
                <Button
                  size="sm"
                  variant={confirmBatch ? 'destructive' : 'outline'}
                  className={confirmBatch ? undefined : 'text-destructive hover:text-destructive'}
                  disabled={batchDeleteMutation.isPending || selected.size === 0}
                  onClick={() => {
                    if (confirmBatch) batchDeleteMutation.mutate();
                    else setConfirmBatch(true);
                  }}
                >
                  {batchDeleteMutation.isPending ? (
                    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2Icon aria-hidden="true" />
                  )}
                  {confirmBatch ? `确认删除 ${selected.size} 项（不可恢复）` : '批量删除（仅无数据草稿）'}
                </Button>
                <span className="text-xs text-muted-foreground">已发布或已有数据的活动会被自动跳过。</span>
              </div>
            )}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="h-10">
                    <TableHead className="w-10 pl-5">
                      <Checkbox
                        aria-label="全选本页活动"
                        checked={allVisibleSelected}
                        onCheckedChange={toggleAllVisible}
                      />
                    </TableHead>
                    <TableHead>标题</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>时间</TableHead>
                    <TableHead>地点</TableHead>
                    <TableHead className="text-right">报名</TableHead>
                    <TableHead className="pr-5">签到</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((activity) => (
                    <TableRow
                      key={activity.id}
                      className="h-14 cursor-pointer"
                      onClick={() =>
                        setSearchParams((previous) => {
                          const next = new URLSearchParams(previous);
                          next.set('activity', activity.id);
                          return next;
                        })
                      }
                    >
                      <TableCell className="pl-5" onClick={(event) => event.stopPropagation()}>
                        <Checkbox
                          aria-label={`选择 ${activity.title}`}
                          checked={selected.has(activity.id)}
                          onCheckedChange={() => toggleSelected(activity.id)}
                        />
                      </TableCell>
                      <TableCell className="max-w-64 truncate font-medium">
                        {activity.title}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {activityTypeLabel(activity.type)}
                      </TableCell>
                      <TableCell>
                        <BadgeOfActivityStatus status={activity.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {formatStartEnd(activity.startAt, activity.endAt)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {activity.venueVersion
                          ? [activity.venueVersion.building, activity.venueVersion.room]
                              .filter(Boolean)
                              .join(' ') || '—'
                          : '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {activity._count?.registrations ?? 0}
                        {activity.capacity ? ` / ${activity.capacity}` : ''}
                      </TableCell>
                      <TableCell className="pr-5 text-muted-foreground">
                        {activity.policy ? policyLabel(activity.policy.policy) : '未配置'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="px-5">
              <LoadMoreButton
                onClick={() => {
                  void listQuery.fetchNextPage();
                }}
                loading={listQuery.isFetchingNextPage}
                hasNext={Boolean(listQuery.data?.pages.at(-1)?.nextCursor)}
                hint="已展示全部活动"
              />
            </div>
          </CardContent>
        </Card>
      )}

      {detailId && (
        <ActivityDetailSheet
          principalId={principalId}
          activityId={detailId}
          onClose={() =>
            setSearchParams((previous) => {
              const next = new URLSearchParams(previous);
              next.delete('activity');
              return next;
            })
          }
        />
      )}
      {createOpen && <CreateActivityDialog
        principalId={principalId}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />}
    </div>
  );
}

function BadgeOfActivityStatus({ status }: { status: string }) {
  const value =
    status === 'draft'
      ? '草稿'
      : status === 'published'
        ? '已发布'
        : status === 'cancelled'
          ? '已取消'
          : '已归档';
  return <StatusBadge kind="disclosure" value={value} />;
}

function ActivityDetailSheet({
  principalId,
  activityId,
  onClose,
}: {
  principalId: string;
  activityId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [detailTab, setDetailTab] = useState('announcement');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [qrBoardOpen, setQrBoardOpen] = useState(false);
  const [boardWasFullscreen, setBoardWasFullscreen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [settleResult, setSettleResult] = useState<{
    posted: number;
    deduplicated: number;
    skipped: Array<{ name: string; reason: string }>;
    lambda: { key: string; source: string };
    cap: number;
    validCount: number;
  } | null>(null);
  const settleScoresMutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{
        posted: number;
        deduplicated: number;
        skipped: Array<{ name: string; reason: string }>;
        lambda: { key: string; source: string };
        cap: number;
        validCount: number;
      }>(`/admin/activities/${activityId}/settle-scores`);
      return data;
    },
    onSuccess: (result) => {
      setActionError(null);
      setSettleResult(result);
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin'] });
    },
    onError: (error: ApiError) => setActionError(error.message),
  });
  const deleteMutation = useMutation({
    mutationFn: async () => {
      await api.delete(`/admin/activities/${activityId}`);
      return true;
    },
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'activities'] });
      onClose();
    },
    onError: (error: ApiError) => {
      setConfirmDelete(false);
      setActionError(error.message);
    },
  });

  const query = usePrivateQuery<ActivityDetailDto, ApiError>(
    principalId,
    ['admin', 'activities', 'detail', activityId],
    async () => (await api.get<ActivityDetailDto>(`/admin/activities/${activityId}`)).data,
  );

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'activities'] });
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'activities'] });
  }, [principalId, queryClient]);

  const publishMutation = useMutation({
    mutationFn: async () => {
      await api.post(`/admin/activities/${activityId}/publish`);
      return true;
    },
    onSuccess: () => {
      setActionError(null);
      setActionNotice('已发布；围栏快照与必到名单已固化。');
      invalidate();
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  const settleMutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{
        created: number;
        absenceCandidates: number;
        note: string;
      }>(`/admin/activities/${activityId}/settle`);
      return data;
    },
    onSuccess: (result) => {
      setActionError(null);
      setActionNotice(
        `生成认定候选 ${result.created} 条、缺席候选 ${result.absenceCandidates} 条；${result.note}`,
      );
      invalidate();
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  return (
    <>
      <ResponsiveDetail
        open={!qrBoardOpen}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={query.data?.title ?? '活动详情'}
        description={
          query.data
            ? `${activityTypeLabel(query.data.type)} · ${formatStartEnd(query.data.startAt, query.data.endAt)} · ${activityStatusLabel(query.data.status)}`
            : undefined
        }
        footer={
          query.data && (
            <div className="flex flex-wrap items-center gap-2">
              {query.data.status === 'draft' && (
                <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                  编辑草稿
                </Button>
              )}
              {query.data.status === 'draft' && (
                <Button
                  size="sm"
                  disabled={publishMutation.isPending || !query.data.policy || query.data.venueBindings.length === 0}
                  onClick={() => publishMutation.mutate()}
                >
                  {publishMutation.isPending && (
                    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  )}
                  发布
                </Button>
              )}
              {query.data.status === 'draft' && (
                <Button
                  size="sm"
                  variant={confirmDelete ? 'destructive' : 'outline'}
                  disabled={deleteMutation.isPending}
                  onClick={() => {
                    if (confirmDelete) deleteMutation.mutate();
                    else setConfirmDelete(true);
                  }}
                >
                  {deleteMutation.isPending && (
                    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  )}
                  {confirmDelete ? '确认删除（不可恢复）' : '删除草稿'}
                </Button>
              )}
              {query.data.policy && query.data.status === 'published' && (
                <Button size="sm" variant="outline" onClick={() => {
                  setBoardWasFullscreen(Boolean(document.fullscreenElement));
                  setQrBoardOpen(true);
                  if (!document.fullscreenElement && document.fullscreenEnabled) {
                    void document.documentElement.requestFullscreen().catch(() => undefined);
                  }
                }}>
                  <MonitorPlayIcon aria-hidden="true" />
                  现场码大屏
                </Button>
              )}
              {query.data.status === 'published' && new Date(query.data.endAt) < new Date() && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={settleMutation.isPending}
                  onClick={() => settleMutation.mutate()}
                >
                  {settleMutation.isPending && (
                    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  )}
                  生成出勤认定候选
                </Button>
              )}
              {query.data.status === 'published' && query.data.platform && query.data.platformContestId && new Date(query.data.endAt) < new Date() && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={settleScoresMutation.isPending}
                  onClick={() => settleScoresMutation.mutate()}
                >
                  {settleScoresMutation.isPending && (
                    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  )}
                  结算比赛积分
                </Button>
              )}
              <span className="text-xs text-muted-foreground">
                {query.data.status === 'archived'
                  ? '活动已归档，记录只读。'
                  : query.data.status === 'draft'
                    ? query.data.venueBindings.length === 0
                      ? '请编辑草稿并选择签到地点后再发布。'
                      : '草稿可编辑，保存后再发布。'
                    : '发布后配置已固化，如需修改请新建活动。'}
              </span>
            </div>
          )
        }
      >
        {query.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
        ) : query.isError ? (
          <ErrorState description={query.error.message} onRetry={() => void query.refetch()} />
        ) : (
          <div className="flex flex-col gap-4">
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

            {settleResult && (
              <Alert>
                <AlertTitle>
                  比赛积分结算完成：入账 {settleResult.posted} 笔
                  {settleResult.deduplicated > 0 ? `（幂等跳过 ${settleResult.deduplicated} 笔）` : ''} · λ={settleResult.lambda.key}（{settleResult.lambda.source}）· 上限 {settleResult.cap} · 有效参赛 {settleResult.validCount} 人
                </AlertTitle>
                <AlertDescription>
                  {settleResult.skipped.length > 0 ? (
                    <ul className="mt-1 flex flex-col gap-0.5 text-xs">
                      {settleResult.skipped.map((item, index) => (
                        <li key={index}>跳过 {item.name}：{item.reason}</li>
                      ))}
                    </ul>
                  ) : (
                    '无跳过项；积分已实时出现在成员端活动详情与积分页。'
                  )}
                </AlertDescription>
              </Alert>
            )}

            <Tabs value={detailTab} onValueChange={setDetailTab}>
              <TabsList aria-label="活动管理分区">
                <TabsTrigger value="announcement">公告设置</TabsTrigger>
                <TabsTrigger value="registrations">报名候补</TabsTrigger>
                <TabsTrigger value="attendance">现场出勤</TabsTrigger>
                <TabsTrigger value="participants">参与核验</TabsTrigger>
                <TabsTrigger value="lecture">讲题审批</TabsTrigger>
                <TabsTrigger value="standings">比赛榜单</TabsTrigger>
                <TabsTrigger value="archive">归档</TabsTrigger>
              </TabsList>

              <TabsContent value="announcement" className="mt-3">
                <AnnouncementSection detail={query.data} />
              </TabsContent>
              <TabsContent value="registrations" className="mt-3">
                <RegistrationsSection principalId={principalId} activityId={activityId} />
              </TabsContent>
              <TabsContent value="lecture" className="mt-3">
                <LectureRequestsSection principalId={principalId} activityId={activityId} />
              </TabsContent>
              <TabsContent value="standings" className="mt-3">
                <AdminStandingsSection principalId={principalId} activityId={activityId} />
              </TabsContent>
              <TabsContent value="attendance" className="mt-3">
                <AttendanceSection principalId={principalId} activityId={activityId} />
              </TabsContent>
              <TabsContent value="participants" className="mt-3">
                <ParticipantsSection principalId={principalId} activityId={activityId} />
              </TabsContent>
              <TabsContent value="archive" className="mt-3">
                <p className="text-sm leading-[22px] text-muted-foreground">
                  活动归档与取消暂由后台维护（保留全部报名/出勤/积分记录）；此处提供只读视图。
                  当前状态：{activityStatusLabel(query.data.status)}。
                </p>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </ResponsiveDetail>

      {editOpen && query.data?.status === 'draft' && (
        <ActivityFormDialog
          key={`${activityId}-${query.data.revision}`}
          principalId={principalId}
          open
          draft={query.data}
          onOpenChange={setEditOpen}
          onSaved={() => {
            setActionError(null);
            setActionNotice('草稿已保存。');
            invalidate();
          }}
        />
      )}

      {qrBoardOpen && query.data && (
        <AttendanceQrBoard activity={query.data} principalId={principalId} wasFullscreen={boardWasFullscreen} onClose={() => setQrBoardOpen(false)} />
      )}
    </>
  );
}

function AnnouncementSection({ detail }: { detail: ActivityDetailDto }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="leading-[22px] whitespace-pre-wrap text-foreground/90">{detail.announcement}</p>
      {detail.joinNotes && (
        <p className="leading-[22px] whitespace-pre-wrap text-muted-foreground">
          参加须知：{detail.joinNotes}
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-muted-foreground">起止时间</dt>
        <dd>{formatStartEnd(detail.startAt, detail.endAt)}</dd>
        <dt className="text-muted-foreground">报名窗口</dt>
        <dd>
          {detail.registerStartAt ? formatDateTime(detail.registerStartAt) : '随公告'} ~{' '}
          {detail.registerDeadline ? formatDateTime(detail.registerDeadline) : '不限'}
        </dd>
        <dt className="text-muted-foreground">取消 / 请假截止</dt>
        <dd>
          {detail.cancelDeadline ? formatDateTime(detail.cancelDeadline) : '未设置'} / 未设置
        </dd>
        <dt className="text-muted-foreground">容量 / 候补</dt>
        <dd className="tabular-nums">
          {detail.capacity ?? '不限'} / {detail.waitlistCapacity ?? 0}
        </dd>
        <dt className="text-muted-foreground">远程参赛</dt>
        <dd>
          {detail.remoteAllowed ? `允许${detail.remotePolicy ? `（${detail.remotePolicy}）` : ''}` : '不允许'}
        </dd>
        <dt className="text-muted-foreground">有效提交要求</dt>
        <dd>{detail.requireValidSubmission ? '需要至少一次有效提交' : '无'}</dd>
        <dt className="text-muted-foreground">计分配置</dt>
        <dd className="font-mono text-xs break-all">
          {detail.scoringConfig ? JSON.stringify(detail.scoringConfig) : '默认（λ 类别 + 特殊上限）'}
        </dd>
        <dt className="text-muted-foreground">签到策略</dt>
        <dd>
          {detail.policy
            ? `${policyLabel(detail.policy.policy)}；签到 ${formatStartEnd(detail.policy.checkinOpenAt, detail.policy.checkinCloseAt)}`
            : '未配置（发布会被阻塞）'}
        </dd>
        <dt className="text-muted-foreground">绑定地点版本</dt>
        <dd>
          {detail.venueBindings.length === 0
            ? '未绑定（GEO 类策略发布会被阻塞）'
            : detail.venueBindings
                .map(
                  (binding) =>
                    `${binding.venueVersion.venue.name} ${binding.venueVersion.building ?? ''} ${binding.venueVersion.room ?? ''}（${binding.venueVersionId.slice(0, 8)}）`,
                )
                .join('；')}
        </dd>
      </dl>
    </div>
  );
}

function RegistrationsSection({
  principalId,
  activityId,
}: {
  principalId: string;
  activityId: string;
}) {
  const query = usePrivateQuery<AttendanceListDto, ApiError>(
    principalId,
    ['admin', 'activities', 'attendance', activityId],
    async () => (await api.get<AttendanceListDto>(`/admin/activities/${activityId}/attendance`)).data,
  );

  if (query.isPending) return <Skeleton className="h-40 rounded-xl" />;
  if (query.isError) return <ErrorState description={query.error.message} onRetry={() => void query.refetch()} />;
  const stats = query.data.stats;
  const statCards = [
    { label: '名单总数', value: stats.total },
    { label: '已签到', value: stats.checkedIn },
    { label: '已签退', value: stats.checkedOut },
    { label: '未签到', value: stats.notCheckedIn },
    { label: '请假批准', value: stats.leaveApproved },
    { label: '待复核', value: stats.pendingReview },
  ];
  return (
    <div className="flex flex-col gap-3">
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {statCards.map((card) => (
          <li key={card.label} className="rounded-xl border border-border p-3">
            <p className="text-xs text-muted-foreground">{card.label}</p>
            <p className="text-xl font-semibold text-foreground tabular-nums">{card.value}</p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        候补与报名明细在「现场出勤」名单中一并展示（含 required_list 必到名单）。
      </p>
    </div>
  );
}

interface AdminStandingsDto {
  platform: string;
  contestId: string;
  contestUrl: string | null;
  ended: boolean;
  available: boolean;
  processing?: boolean;
  reason?: string;
  note: string | null;
  fetchedAt: string;
  problems: Array<{ index: string; name: string | null; fullScore: number | null; url: string | null; clubSolved: number }>;
  clubRanking: Array<{
    clubRank: number;
    userId: string;
    name: string;
    handle: string;
    displayName?: string | null;
    solvedCount: number;
    score: number;
    platformRank: number | null;
  }>;
  totalEntries: number;
}

/** 管理端比赛榜单：社团排名 + 平台位次 + 逐题通过情况（结算引擎数据源同源） */
function AdminStandingsSection({ principalId, activityId }: { principalId: string; activityId: string }) {
  const [expanded, setExpanded] = useState(false);
  const query = usePrivateQuery<AdminStandingsDto, ApiError>(
    principalId,
    ['admin', 'activities', 'standings', activityId],
    async () => (await api.get<AdminStandingsDto>(`/admin/activities/${activityId}/standings`)).data,
    { enabled: expanded, staleTime: 60_000, retry: false },
  );

  return (
    <div className="flex flex-col gap-3">
      {!expanded && query.isPending ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm leading-[22px] text-muted-foreground">
            查看平台榜单（社团排名、平台位次与逐题通过情况）；数据与结算引擎同源，60 秒缓存。
          </p>
          <Button size="sm" onClick={() => setExpanded(true)}>
            加载比赛榜单
          </Button>
        </div>
      ) : query.isError ? (
        <ErrorState description={query.error.message} onRetry={() => void query.refetch()} />
      ) : query.isPending ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : query.data.processing ? (
        <Alert>
          <AlertTitle>数据同步处理中</AlertTitle>
          <AlertDescription>{query.data.reason ?? '比赛结束后约 5 分钟可查看，请稍后刷新。'}</AlertDescription>
        </Alert>
      ) : !query.data.available ? (
        <div className="flex flex-col items-start gap-2">
          <Alert>
            <AlertTitle>平台榜单暂不可用</AlertTitle>
            <AlertDescription>{query.data.reason}</AlertDescription>
          </Alert>
          {query.data.contestUrl && (
            <Button asChild size="sm" variant="outline">
              <a href={query.data.contestUrl} target="_blank" rel="noreferrer">
                前往官方榜单
              </a>
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              榜单共 {query.data.totalEntries} 人 · 社团上榜 {query.data.clubRanking.length} 人 · 更新于{' '}
              {formatDateTime(query.data.fetchedAt)}
            </span>
            <Button size="sm" variant="ghost" disabled={query.isFetching} onClick={() => void query.refetch()}>
              <RefreshCwIcon className={query.isFetching ? 'animate-spin' : ''} aria-hidden="true" />
              刷新
            </Button>
          </div>
          {query.data.problems.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {query.data.problems.map((problem) => (
                <a
                  key={problem.index}
                  href={problem.url ?? query.data.contestUrl ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                  title={`${problem.name ?? problem.index} · 社团通过 ${problem.clubSolved} 人`}
                  className="flex min-w-14 flex-col items-center rounded-xl border border-border bg-muted/40 px-3 py-2 text-muted-foreground transition-colors hover:border-primary/50"
                >
                  <span className="text-sm font-semibold">{problem.index}</span>
                  <span className="text-[11px] tabular-nums">{problem.clubSolved} 人过</span>
                </a>
              ))}
            </div>
          )}
          {query.data.clubRanking.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有社团成员出现在该榜单（绑定平台账号后自动参与）。</p>
          ) : (
            <ol className="flex flex-col divide-y divide-border rounded-xl border border-border">
              {query.data.clubRanking.map((row) => (
                <li key={row.userId} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                  <span className="w-8 shrink-0 text-center font-semibold text-foreground tabular-nums">{row.clubRank}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{row.name}</span>
                  <span className="hidden truncate text-xs text-muted-foreground sm:block">{row.displayName ?? row.handle}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">{row.solvedCount} 题</span>
                  <span className="w-16 shrink-0 text-right font-medium text-foreground tabular-nums">{row.score}</span>
                  <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    {row.platformRank != null ? `#${row.platformRank}` : '—'}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

interface LectureRequestRow {
  id: string;
  topic: string | null;
  status: string;
  reviewNote: string | null;
  createdAt: string;
  user: {
    id: string;
    verifiedRealName: string;
    studentNo: string;
    profile: { displayName: string | null } | null;
  };
}

/** 讲题审批：通过后该成员获得本活动材料（幻灯片/题解）上传权限 */
function LectureRequestsSection({
  principalId,
  activityId,
}: {
  principalId: string;
  activityId: string;
}) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const query = usePrivateQuery<LectureRequestRow[], ApiError>(
    principalId,
    ['admin', 'activities', 'lecture-requests', activityId],
    async () => (await api.get<LectureRequestRow[]>(`/admin/activities/${activityId}/lecture-requests`)).data,
  );

  const decisionMutation = useMutation({
    mutationFn: async (input: { requestId: string; decision: 'approve' | 'reject' }) => {
      await api.post(`/admin/activities/${activityId}/lecture-requests/${input.requestId}/decision`, {
        decision: input.decision,
      });
      return input.decision;
    },
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin'] });
    },
    onError: (error: ApiError) => setActionError(error.message),
  });

  if (query.isPending) return <Skeleton className="h-40 rounded-xl" />;
  if (query.isError) return <ErrorState description={query.error.message} onRetry={() => void query.refetch()} />;

  return (
    <div className="flex flex-col gap-3">
      {actionError && (
        <Alert variant="destructive">
          <AlertTitle>操作未完成</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}
      {query.data.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          还没有成员申请本次活动的讲题。
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {query.data.map((request) => (
            <li key={request.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                  {memberName(request.user)}
                  <span className="font-normal text-muted-foreground tabular-nums">
                    {request.user.studentNo}
                  </span>
                  <StatusBadge
                    kind="disclosure"
                    value={
                      request.status === 'approved'
                        ? '已批准'
                        : request.status === 'pending'
                          ? '待审批'
                          : '已驳回'
                    }
                  />
                </p>
                <p className="text-xs text-muted-foreground">
                  {request.topic ? `主题：${request.topic} · ` : ''}
                  提交于 {formatDateTime(request.createdAt)}
                  {request.reviewNote ? ` · 备注：${request.reviewNote}` : ''}
                </p>
              </div>
              {request.status === 'pending' && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={decisionMutation.isPending}
                    onClick={() => decisionMutation.mutate({ requestId: request.id, decision: 'approve' })}
                  >
                    {decisionMutation.isPending && decisionMutation.variables?.decision === 'approve' && (
                      <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                    )}
                    批准
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={decisionMutation.isPending}
                    onClick={() => decisionMutation.mutate({ requestId: request.id, decision: 'reject' })}
                  >
                    {decisionMutation.isPending && decisionMutation.variables?.decision === 'reject' && (
                      <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                    )}
                    驳回
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        批准后该成员在活动详情页获得「讲题材料」上传权限（≤20 MiB，PDF/Markdown/Office/图片/ZIP）。
      </p>

      <LectureRatingSummary principalId={principalId} activityId={activityId} />
    </div>
  );
}

interface LectureRatingSummaryRow {
  lectureRequestId: string;
  lecturerName: string;
  studentNo: string;
  topic: string | null;
  stats: { count: number; average: number; distribution: number[] };
  comments: Array<{ id: string; score: number; comment: string; createdAt: string }>;
}

/** 讲题满意度汇总（匿名）：成员在活动结束后打分，这里只看汇总与匿名评语 */
function LectureRatingSummary({
  principalId,
  activityId,
}: {
  principalId: string;
  activityId: string;
}) {
  const query = usePrivateQuery<LectureRatingSummaryRow[], ApiError>(
    principalId,
    ['admin', 'activities', 'lecture-ratings', activityId],
    async () =>
      (await api.get<LectureRatingSummaryRow[]>(`/admin/activities/${activityId}/lecture-ratings`)).data,
  );

  if (query.isPending) return <Skeleton className="h-24 rounded-xl" />;
  if (query.isError) {
    return <ErrorState description={query.error.message} onRetry={() => void query.refetch()} />;
  }
  if (query.data.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">讲题满意度（匿名）</h3>
        <span className="text-xs text-muted-foreground">活动结束后由到场成员打分，1–5 星</span>
      </div>
      <ul className="flex flex-col divide-y divide-border">
        {query.data.map((row) => (
          <li key={row.lectureRequestId} className="flex flex-col gap-1.5 py-2.5">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
              {row.lecturerName}
              <span className="font-normal text-muted-foreground tabular-nums">{row.studentNo}</span>
              {row.stats.count > 0 ? (
                <span className="text-muted-foreground">
                  <span className="font-semibold text-foreground tabular-nums">
                    {row.stats.average.toFixed(1)}
                  </span>{' '}
                  / 5 · {row.stats.count} 人评分
                </span>
              ) : (
                <span className="font-normal text-muted-foreground">暂无评分</span>
              )}
            </p>
            {row.topic && <p className="text-xs text-muted-foreground">主题：{row.topic}</p>}
            {row.stats.count > 0 && (
              <p className="text-xs text-muted-foreground tabular-nums">
                {[5, 4, 3, 2, 1]
                  .map((star) => `${star}星 ${row.stats.distribution[star - 1] ?? 0}`)
                  .join(' · ')}
              </p>
            )}
            {row.comments.length > 0 && (
              <ul className="flex flex-col gap-1">
                {row.comments.map((item) => (
                  <li key={item.id} className="text-xs leading-5 text-foreground/90">
                    <span className="text-muted-foreground tabular-nums">{item.score} 星 · </span>
                    {item.comment}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        评分与评语均不记录评价人，接口也不返回评价人身份；讲题人本人仅在评分达 3 人后可见评语。
      </p>
    </div>
  );
}

function AttendanceSection({
  principalId,
  activityId,
}: {
  principalId: string;
  activityId: string;
}) {
  const queryClient = useQueryClient();
  const [group, setGroup] = useState('all');
  const [search, setSearch] = useState('');
  const [reviewUserId, setReviewUserId] = useState<string | null>(null);
  const [reviewStatus, setReviewStatus] = useState('ontime');
  const [reviewMinutes, setReviewMinutes] = useState('');
  const [reviewReason, setReviewReason] = useState('');
  const [reviewError, setReviewError] = useState<string | null>(null);

  const query = usePrivateQuery<AttendanceListDto, ApiError>(
    principalId,
    ['admin', 'activities', 'attendance', activityId, group],
    async () => {
      const params = new URLSearchParams();
      if (group !== 'all') params.set('group', group);
      const { data } = await api.get<AttendanceListDto>(
        `/admin/activities/${activityId}/attendance?${params.toString()}`,
      );
      return data;
    },
  );

  const reviewMutation = useMutation({
    mutationFn: async (input: { userId: string; status: string; reason: string }) => {
      const minutes = Number(reviewMinutes) || 0;
      await api.post(`/admin/activities/${activityId}/attendance/manual`, {
        userId: input.userId,
        newStatus: input.status,
        ...(input.status === 'late' ? { lateMinutes: minutes } : {}),
        ...(input.status === 'early_leave' ? { earlyMinutes: minutes } : {}),
        ...(input.status === 'late_and_early' ? { lateMinutes: minutes, earlyMinutes: minutes } : {}),
        reason: input.reason,
      });
      return true;
    },
    onSuccess: () => {
      setReviewError(null);
      setReviewUserId(null);
      setReviewReason('');
      setReviewMinutes('');
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'activities', 'attendance'] });
    },
    onError: (error: ApiError) => setReviewError(error.message),
  });

  const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
    { value: 'ontime', label: '到场（按时）' },
    { value: 'late', label: '迟到' },
    { value: 'early_leave', label: '早退' },
    { value: 'late_and_early', label: '迟到且早退' },
    { value: 'absent', label: '缺勤' },
    { value: 'leave_approved', label: '请假通过' },
    { value: 'remote_approved', label: '远程通过' },
  ];

  if (query.isPending) return <Skeleton className="h-48 rounded-xl" />;
  if (query.isError) return <ErrorState description={query.error.message} onRetry={() => void query.refetch()} />;

  const keyword = search.trim().toLowerCase();
  const rows = query.data.items.filter(
    (row) =>
      keyword === '' ||
      (row.name ?? '').toLowerCase().includes(keyword) ||
      row.studentNo.includes(keyword),
  );

  return (
    <div className="flex flex-col gap-3">
      {reviewError && (
        <Alert variant="destructive">
          <AlertTitle>复核未完成</AlertTitle>
          <AlertDescription>{reviewError}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select value={group} onValueChange={setGroup}>
          <SelectTrigger className="sm:w-44" aria-label="分组筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部名单</SelectItem>
            <SelectItem value="not_checked_in">未签到</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative sm:w-56">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索姓名 / 校园编号"
            className="pl-9"
            aria-label="搜索名单"
          />
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">没有匹配的名单行。</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {rows.map((row) => {
            const expanded = reviewUserId === row.userId;
            return (
              <li key={row.userId} className="flex flex-col gap-2 py-2.5 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">
                      {row.name ?? '（未实名）'}{' '}
                      <span className="text-xs text-muted-foreground tabular-nums">{row.studentNo}</span>
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      签到 {row.checkin ? formatDateTime(row.checkin) : '—'} · 签退{' '}
                      {row.checkout ? formatDateTime(row.checkout) : '—'}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {row.regStatus === 'required_list' && (
                      <StatusBadge kind="registration" value="必到名单" />
                    )}
                    {row.leave === 'approved' && <StatusBadge kind="attendance" value="请假已批准" />}
                    {row.resultStatus && (
                      <StatusBadge
                        kind="attendance"
                        value={
                          row.resultStatus === 'pending_review'
                            ? '待人工复核'
                            : row.resultStatus === 'ontime'
                              ? '准时'
                              : row.resultStatus === 'late'
                                ? '迟到'
                                : row.resultStatus === 'early_leave'
                                  ? '早退'
                                  : row.resultStatus === 'late_and_early'
                                    ? '迟到且早退'
                                    : row.resultStatus === 'leave_approved'
                                      ? '请假已批准'
                                      : row.resultStatus === 'remote_approved'
                                        ? '远程已批准'
                                        : row.resultStatus === 'absent'
                                          ? '缺勤'
                                          : '待认定'
                        }
                      />
                    )}
                    <Button
                      size="sm"
                      variant={expanded ? 'default' : 'outline'}
                      onClick={() => {
                        setReviewError(null);
                        setReviewStatus('ontime');
                        setReviewMinutes('');
                        setReviewUserId(expanded ? null : row.userId);
                      }}
                    >
                      复核 / 补签
                    </Button>
                  </span>
                </span>
                {expanded && (
                  <form
                    className="flex flex-col gap-2 rounded-xl border border-dashed border-border p-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (reviewReason.trim().length >= 3) {
                        reviewMutation.mutate({ userId: row.userId, status: reviewStatus, reason: reviewReason.trim() });
                      }
                    }}
                  >
                    <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor={`review-status-${row.userId}`}>认定结果</Label>
                        <Select value={reviewStatus} onValueChange={setReviewStatus}>
                          <SelectTrigger id={`review-status-${row.userId}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {STATUS_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor={`review-minutes-${row.userId}`}>
                          {reviewStatus === 'early_leave' ? '早退分钟' : '迟到分钟'}
                        </Label>
                        <Input
                          id={`review-minutes-${row.userId}`}
                          type="number"
                          min={0}
                          max={600}
                          value={reviewMinutes}
                          onChange={(event) => setReviewMinutes(event.target.value)}
                          placeholder="0"
                          disabled={reviewStatus === 'ontime' || reviewStatus === 'absent' || reviewStatus === 'leave_approved' || reviewStatus === 'remote_approved'}
                        />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`review-reason-${row.userId}`}>复核原因（3-1000 字，必填；不能复核本人）</Label>
                      <Textarea
                        id={`review-reason-${row.userId}`}
                        value={reviewReason}
                        onChange={(event) => setReviewReason(event.target.value)}
                        rows={2}
                        maxLength={1000}
                        placeholder="例如：现场工作人员确认 19:02 到场，设备故障未能扫码"
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        disabled={reviewMutation.isPending || reviewReason.trim().length < 3}
                      >
                        {reviewMutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
                        提交认定
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setReviewUserId(null)}>
                        收起
                      </Button>
                      <span className="self-center text-xs text-muted-foreground">
                        到场类认定会补建 MANUAL 签到记录；必到成员自动补报名；原值与认定值留痕可审计。
                      </span>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        名单合并必到名单与报名记录；分页按前 50 行展示，更多请用搜索定位。
      </p>
    </div>
  );
}

function ParticipantsSection({
  principalId,
  activityId,
}: {
  principalId: string;
  activityId: string;
}) {
  const queryClient = useQueryClient();
  const [memberSearch, setMemberSearch] = useState('');
  const debouncedSearch = useDebouncedValue(memberSearch, 450);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [manualIds, setManualIds] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const membersQuery = usePrivateQuery<
    { items: Array<{ id: string; displayName: string; studentNo: string }> } | null,
    ApiError
  >(
    principalId,
    ['admin', 'members', 'picker', debouncedSearch],
    async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('q', debouncedSearch);
      const { data } = await api.get<{
        items: Array<{ id: string; displayName: string; studentNo: string }>;
      }>(`/admin/members?${params.toString()}`);
      return data;
    },
    { retry: false },
  );

  const requiredMutation = useMutation({
    mutationFn: async (userIds: string[]) => {
      await api.post(`/admin/activities/${activityId}/required-participants`, { userIds });
      return userIds;
    },
    onSuccess: (userIds) => {
      setActionError(null);
      setActionNotice(`已设置必到名单 ${userIds.length} 人（发布时冻结快照，现场签到成功后自动报名）。`);
      void queryClient.invalidateQueries({
        queryKey: ['principal', principalId, 'admin', 'activities'],
      });
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  const membersForbidden =
    membersQuery.isError && (membersQuery.error.status === 403 || membersQuery.error.code === 'FORBIDDEN');

  return (
    <div className="flex flex-col gap-3">
      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}
      {actionNotice && !actionError && (
        <Alert>
          <AlertDescription>{actionNotice}</AlertDescription>
        </Alert>
      )}
      {membersForbidden ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            当前账号没有成员读取权限（members.read）。可手动粘贴成员 userId（每行一个）：
          </p>
          <Textarea
            value={manualIds}
            onChange={(event) => setManualIds(event.target.value)}
            rows={4}
            placeholder="0f436bb5-2463-4a98-8538-dc7b8b808328"
          />
          <Button
            size="sm"
            className="w-fit"
            disabled={
              requiredMutation.isPending ||
              manualIds
                .split(/[\s,]+/)
                .filter((id) => id.trim().length > 0).length === 0
            }
            onClick={() =>
              requiredMutation.mutate(
                manualIds
                  .split(/[\s,]+/)
                  .map((id) => id.trim())
                  .filter((id) => id.length > 0),
              )
            }
          >
            {requiredMutation.isPending && (
              <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
            )}
            设置必到名单
          </Button>
        </div>
      ) : (
        <>
          <div className="relative sm:w-72">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={memberSearch}
              onChange={(event) => setMemberSearch(event.target.value)}
              placeholder="搜索校园编号 / 姓名加入必到名单"
              className="pl-9"
              aria-label="搜索成员"
            />
          </div>
          {membersQuery.isPending ? (
            <Skeleton className="h-24 rounded-xl" />
          ) : membersQuery.isError ? (
            <ErrorState description={membersQuery.error.message} onRetry={() => void membersQuery.refetch()} />
          ) : (
            <ul className="flex max-h-56 flex-col divide-y divide-border overflow-y-auto rounded-xl border border-border px-3">
              {(membersQuery.data?.items ?? []).map((member) => (
                <li key={member.id} className="flex items-center gap-3 py-2 text-sm">
                  <Checkbox
                    id={`required-${member.id}`}
                    checked={selected[member.id] != null}
                    onCheckedChange={(value) => {
                      setSelected((previous) => {
                        const next = { ...previous };
                        if (value === true) next[member.id] = member.studentNo;
                        else delete next[member.id];
                        return next;
                      });
                    }}
                    aria-label={`选择 ${member.displayName}`}
                  />
                  <label htmlFor={`required-${member.id}`} className="min-w-0 flex-1 truncate">
                    {member.displayName}{' '}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {member.studentNo}
                    </span>
                  </label>
                </li>
              ))}
              {(membersQuery.data?.items ?? []).length === 0 && (
                <li className="py-3 text-center text-sm text-muted-foreground">没有匹配成员。</li>
              )}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={requiredMutation.isPending || Object.keys(selected).length === 0}
              onClick={() => requiredMutation.mutate(Object.keys(selected))}
            >
              {requiredMutation.isPending && (
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
              )}
              设置必到名单（{Object.keys(selected).length}）
            </Button>
            <span className="text-xs text-muted-foreground">
              多选；发布时冻结必到名单，现场签到成功后自动报名；缺席须申请请假，出勤截止无操作自动记为缺勤。
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ======================= 地点 =======================

function VenuesTab({ principalId }: { principalId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 450);
  const [createOpen, setCreateOpen] = useState(false);
  const venueId = searchParams.get('venue');

  const listQuery = usePrivateInfiniteQuery<{ items: VenueRowDto[]; nextCursor?: string | null }, ApiError>(
    principalId,
    ['admin', 'venues', 'list', status, debouncedSearch],
    async (cursor) => {
      const params = new URLSearchParams();
      if (status !== 'all') params.set('status', status);
      if (debouncedSearch) params.set('q', debouncedSearch);
      if (cursor) params.set('cursor', cursor);
      const { data, meta } = await api.get<VenueRowDto[]>(
        `/admin/venues?${params.toString()}`,
      );
      return { items: data, nextCursor: meta?.nextCursor };
    },
  );

  const items = listQuery.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative lg:w-64">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="搜索地点名称"
            className="pl-9"
            aria-label="搜索地点"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="lg:w-40" aria-label="运行状态筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部运行状态</SelectItem>
            <SelectItem value="active">运行中</SelectItem>
            <SelectItem value="suspended">已停用</SelectItem>
            <SelectItem value="archived">已归档</SelectItem>
          </SelectContent>
        </Select>
        <Button className="lg:ml-auto" onClick={() => setCreateOpen(true)}>
          <PlusIcon aria-hidden="true" />
          新增地点
        </Button>
      </div>

      {listQuery.isPending ? (
        <Card>
          <CardContent className="flex flex-col gap-2 p-5">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-16 rounded-xl" />
            ))}
          </CardContent>
        </Card>
      ) : listQuery.isError ? (
        <Card>
          <CardContent className="py-10">
            {listQuery.error.status === 403 ? (
              <EmptyState kind="forbidden" description={listQuery.error.message} />
            ) : (
              <ErrorState
                description={listQuery.error.message}
                onRetry={() => void listQuery.refetch()}
                retrying={listQuery.isFetching}
              />
            )}
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10">
            <EmptyState kind="empty" description="还没有登记地点；新增地点后先建草稿再提交认证。" />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 pb-2">
            <ul className="flex flex-col divide-y divide-border">
              {items.map((venue) => {
                const latest = venue.versions[0];
                return (
                  <li key={venue.id}>
                    <button
                      type="button"
                      className="flex w-full flex-col gap-1.5 p-4 text-left hover:bg-muted/40"
                      onClick={() =>
                        setSearchParams((previous) => {
                          const next = new URLSearchParams(previous);
                          next.set('venue', venue.id);
                          return next;
                        })
                      }
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{venue.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {[venue.campus, venue.building, venue.floor, venue.room]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                        <span className="ml-auto flex items-center gap-2">
                          {latest && (
                            <StatusBadge
                              kind="venue-cert"
                              value={
                                latest.status === 'draft'
                                  ? '草稿'
                                  : latest.status === 'pending_review'
                                    ? '待认证'
                                    : latest.status === 'approved'
                                      ? '已认证'
                                      : latest.status === 'rejected'
                                        ? '已驳回'
                                        : '已过期'
                              }
                            />
                          )}
                          <StatusBadge
                            kind="venue-ops"
                            value={
                              venue.operationalStatus === 'active'
                                ? '运行中'
                                : venue.operationalStatus === 'suspended'
                                  ? '已停用'
                                  : '已归档'
                            }
                          />
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>版本 {venue.versionCount} 个</span>
                        {latest && <span>最新 v{latest.versionNo} · 能力 {latest.allowedCapabilities.join('/')}</span>}
                        {latest?.validUntil && <span>有效期至 {formatDateTime(latest.validUntil)}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="px-5">
              <LoadMoreButton
                onClick={() => {
                  void listQuery.fetchNextPage();
                }}
                loading={listQuery.isFetchingNextPage}
                hasNext={Boolean(listQuery.data?.pages.at(-1)?.nextCursor)}
                hint="已展示全部地点"
              />
            </div>
          </CardContent>
        </Card>
      )}

      {venueId && (
        <VenueDetailSheet
          principalId={principalId}
          venueId={venueId}
          onClose={() =>
            setSearchParams((previous) => {
              const next = new URLSearchParams(previous);
              next.delete('venue');
              return next;
            })
          }
        />
      )}
      <CreateVenueDialog principalId={principalId} open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

const VENUE_CERT_LABELS: Record<string, string> = {
  draft: '草稿',
  pending_review: '待认证',
  approved: '已认证',
  rejected: '已驳回',
  revoked: '已撤销',
};

function certLabel(status: string): string {
  return VENUE_CERT_LABELS[status] ?? status;
}

function VenueDetailSheet({
  principalId,
  venueId,
  onClose,
}: {
  principalId: string;
  venueId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [versionId, setVersionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [impact, setImpact] = useState<string | null>(null);
  const [sampling, setSampling] = useState(false);

  const query = usePrivateQuery<{ operationalStatus: string; versions: VenueVersionDetail[] }, ApiError>(
    principalId,
    ['admin', 'venues', 'detail', venueId],
    async () =>
      (await api.get<{ operationalStatus: string; versions: VenueVersionDetail[] }>(`/admin/venues/${venueId}`))
        .data,
  );

  useEffect(() => {
    if (versionId == null && query.data?.versions.length) {
      setVersionId(query.data.versions[0]?.id ?? null);
    }
  }, [query.data, versionId]);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'venues'] });
  }, [principalId, queryClient]);

  const runAction = useCallback(
    async (fn: () => Promise<unknown>, successMessage: string) => {
      setActionError(null);
      try {
        await fn();
        setActionNotice(successMessage);
        invalidate();
      } catch (error) {
        setActionNotice(null);
        setActionError(
          error instanceof ApiError ? error.message : '操作失败，请稍后重试。',
        );
      }
    },
    [invalidate],
  );

  const version = query.data?.versions.find((item) => item.id === versionId) ?? null;

  const addSample = async () => {
    if (!version) return;
    setSampling(true);
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10_000,
          maximumAge: 0,
        });
      });
      await runAction(
        () =>
          api.post(`/admin/venues/${venueId}/versions/${version.id}/samples`, {
            source: 'browser_geolocation',
            sampledAt: new Date().toISOString(),
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracyMeters: position.coords.accuracy,
            deviceType: navigator.userAgent.slice(0, 60),
          }),
        '现场样本已记录（仅草稿期可追加）。',
      );
    } catch (cause) {
      const code = (cause as { code?: number }).code;
      setActionNotice(null);
      setActionError(
        code === 1
          ? '定位权限被拒绝：请在浏览器允许位置访问后重试。'
          : code === 3
            ? '定位超时（10 秒）：请到开阔位置重试。'
            : '定位失败，请重试。',
      );
    } finally {
      setSampling(false);
    }
  };

  return (
    <ResponsiveDetail
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={version?.name ?? '地点详情'}
      description={
        query.data
          ? `运行状态 ${query.data.operationalStatus === 'active' ? '运行中' : query.data.operationalStatus === 'suspended' ? '已停用' : '已归档'} · ${query.data.versions.length} 个版本`
          : undefined
      }
    >
      {query.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      ) : query.isError ? (
        <ErrorState description={query.error.message} onRetry={() => void query.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
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

          <div className="flex flex-wrap gap-2">
            {query.data.versions.map((item) => (
              <Button
                key={item.id}
                size="sm"
                variant={item.id === versionId ? 'default' : 'outline'}
                onClick={() => setVersionId(item.id)}
              >
                v{item.versionNo} · {certLabel(item.status)}
              </Button>
            ))}
          </div>

          {version && (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">位置</dt>
                <dd>
                  {[version.campus, version.building, version.floor, version.room]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </dd>
                <dt className="text-muted-foreground">允许能力</dt>
                <dd>{version.allowedCapabilities.join(' / ')}</dd>
                <dt className="text-muted-foreground">坐标 / 半径 / 精度</dt>
                <dd className="tabular-nums">
                  {version.latitude != null && version.longitude != null
                    ? `${Number(version.latitude).toFixed(6)}, ${Number(version.longitude).toFixed(6)} · R ${Number(version.radiusMeters ?? 0)}m · ±${Number(version.maxAccuracyMeters ?? 0)}m`
                    : '未设置（QR_ONLY 可无坐标）'}
                </dd>
                <dt className="text-muted-foreground">有效期</dt>
                <dd>
                  {version.validFrom ? formatDateTime(version.validFrom) : '—'} ~{' '}
                  {version.validUntil ? formatDateTime(version.validUntil) : '长期'}
                </dd>
                {version.directions && (
                  <>
                    <dt className="text-muted-foreground">路线说明</dt>
                    <dd>{version.directions}</dd>
                  </>
                )}
                {version.rejectedReason && (
                  <>
                    <dt className="text-muted-foreground">驳回原因</dt>
                    <dd className="text-destructive">{version.rejectedReason}</dd>
                  </>
                )}
              </dl>

              <div className="flex flex-wrap gap-2">
                {version.status === 'draft' && (
                  <>
                    <Button size="sm" variant="outline" disabled={sampling} onClick={() => void addSample()}>
                      {sampling && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
                      采集现场样本（定位）
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        void runAction(
                          () =>
                            api.post(
                              `/admin/venues/${venueId}/versions/${version.id}/submit`,
                              { expectedRevision: version.revision },
                            ),
                          '已提交认证，可直接审核。',
                        )
                      }
                    >
                      提交认证
                    </Button>
                  </>
                )}
                {version.status === 'pending_review' && (
                  <>
                    <Button
                      size="sm"
                      onClick={() =>
                        void runAction(
                          () =>
                            api.post(
                              `/admin/venues/${venueId}/versions/${version.id}/decisions`,
                              {
                                decision: 'approve',
                                reason: '现场核验通过（请按实际填写）',
                              },
                            ),
                          '已通过认证。',
                        )
                      }
                    >
                      通过认证
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const reason = window.prompt('驳回原因（3-1000 字）');
                        if (reason && reason.trim().length >= 3) {
                          void runAction(
                            () =>
                              api.post(
                                `/admin/venues/${venueId}/versions/${version.id}/decisions`,
                                { decision: 'reject', reason: reason.trim() },
                              ),
                            '已驳回。',
                          );
                        }
                      }}
                    >
                      驳回
                    </Button>
                  </>
                )}
                {version.status === 'approved' && !version.revokedAt && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const reason = window.prompt('撤销原因（3-1000 字）');
                      if (reason && reason.trim().length >= 3) {
                        void runAction(
                          () =>
                            api.post(
                              `/admin/venues/${venueId}/versions/${version.id}/revoke`,
                              { reason: reason.trim() },
                            ),
                          '已撤销该版本。',
                        );
                      }
                    }}
                  >
                    撤销认证
                  </Button>
                )}
              </div>

              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-foreground">现场样本（{version.samples.length}）</h3>
                {version.samples.length === 0 ? (
                  <p className="text-sm text-muted-foreground">暂无样本；草稿期可现场采集。</p>
                ) : (
                  <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {version.samples.map((sample) => (
                      <li key={sample.id} className="tabular-nums">
                        {formatDateTime(sample.sampledAt)} · {sample.source} · 精度 ±
                        {sample.accuracyMeters != null ? `${Number(sample.accuracyMeters)}m` : '—'}
                        {sample.deviceType ? ` · ${sample.deviceType}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-foreground">贡献者</h3>
                <ul className="flex flex-wrap gap-2 text-xs">
                  {version.contributors.map((contributor) => (
                    <li
                      key={contributor.id}
                      className="rounded-md bg-muted px-2 py-1 text-muted-foreground"
                    >
                      {contributor.principalId.slice(0, 8)} · {contributor.role}
                    </li>
                  ))}
                  {version.contributors.length === 0 && (
                    <li className="text-muted-foreground">无记录</li>
                  )}
                </ul>
              </section>

              {version.reviewEvents.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h3 className="text-sm font-semibold text-foreground">审核事件</h3>
                  <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {version.reviewEvents.map((event) => (
                      <li key={event.id}>
                        {formatDateTime(event.createdAt)} · {event.action}
                        {event.note ? ` · ${event.note}` : ''}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-foreground">绑定活动</h3>
                {version.activityBindings.length === 0 ? (
                  <p className="text-sm text-muted-foreground">暂无绑定活动。</p>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm">
                    {version.activityBindings.map((binding) => (
                      <li key={binding.activityId} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate">{binding.activity.title}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {formatDateTime(binding.activity.startAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}

          {/* 地点运行状态动作 */}
          <section className="flex flex-col gap-2 border-t border-border pt-3">
            <h3 className="text-sm font-semibold text-foreground">运行状态</h3>
            {impact && <p className="text-xs text-muted-foreground">停用影响：{impact}</p>}
            <div className="flex flex-wrap gap-2">
              {query.data.operationalStatus === 'active' && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        const { data } = await api.get<{ summary?: string }>(
                          `/admin/venues/${venueId}/impact`,
                        );
                        setImpact(
                          typeof data === 'string' ? data : JSON.stringify(data).slice(0, 300),
                        );
                      } catch {
                        setImpact('影响预览获取失败；仍可继续停用。');
                      }
                    }}
                  >
                    查看停用影响
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const reason = window.prompt('停用原因（3-1000 字）');
                      if (reason && reason.trim().length >= 3) {
                        void runAction(
                          () => api.post(`/admin/venues/${venueId}/suspend`, { reason: reason.trim() }),
                          '地点已停用（进行中的签到会被拒绝）。',
                        );
                      }
                    }}
                  >
                    停用
                  </Button>
                </>
              )}
              {query.data.operationalStatus === 'suspended' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void runAction(
                      () => api.post(`/admin/venues/${venueId}/resume`, { reason: '恢复运行' }),
                      '地点已恢复运行。',
                    )
                  }
                >
                  恢复运行
                </Button>
              )}
              {query.data.operationalStatus !== 'archived' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const reason = window.prompt('归档原因（3-1000 字）');
                    if (reason && reason.trim().length >= 3) {
                      void runAction(
                        () => api.post(`/admin/venues/${venueId}/archive`, { reason: reason.trim() }),
                        '地点已归档。',
                      );
                    }
                  }}
                >
                  归档
                </Button>
              )}
            </div>
          </section>
        </div>
      )}
    </ResponsiveDetail>
  );
}

function CreateVenueDialog({
  principalId,
  open,
  onOpenChange,
}: {
  principalId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: '',
    campus: '',
    building: '',
    floor: '',
    room: '',
    description: '',
    directions: '',
    latitude: '',
    longitude: '',
    radiusMeters: '',
    maxAccuracyMeters: '',
    allowedCapabilities: ['GEO', 'QR'] as string[],
    validFrom: '',
    validUntil: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  const mutation = useMutation({
    mutationFn: async () => {
      const capabilities = form.allowedCapabilities as ('GEO' | 'QR')[];
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        allowedCapabilities: capabilities,
        ...(form.campus.trim() ? { campus: form.campus.trim() } : {}),
        ...(form.building.trim() ? { building: form.building.trim() } : {}),
        ...(form.floor.trim() ? { floor: form.floor.trim() } : {}),
        ...(form.room.trim() ? { room: form.room.trim() } : {}),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        ...(form.directions.trim() ? { directions: form.directions.trim() } : {}),
        ...(form.validFrom ? { validFrom: new Date(form.validFrom).toISOString() } : {}),
        ...(form.validUntil ? { validUntil: new Date(form.validUntil).toISOString() } : {}),
      };
      if (capabilities.includes('GEO')) {
        body.latitude = form.latitude ? Number(form.latitude) : null;
        body.longitude = form.longitude ? Number(form.longitude) : null;
        body.radiusMeters = form.radiusMeters ? Number(form.radiusMeters) : null;
        body.maxAccuracyMeters = form.maxAccuracyMeters ? Number(form.maxAccuracyMeters) : null;
      }
      return (await api.post<{ venueId: string; versionId: string }>('/admin/venues', body)).data;
    },
    onSuccess: () => {
      onOpenChange(false);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'venues'] });
    },
    onError: (cause: ApiError) => setError(cause.message),
  });

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>新增地点（创建草稿 v1）</DialogTitle>
          <DialogDescription>
            创建后为草稿版本；采集样本、提交认证并审核通过后即可用于发布活动（可自行审核）。
            声明 GEO 能力必须提供真实坐标/半径/精度，不得虚构。
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="地点名称 *" value={form.name} onChange={set('name')} maxLength={80} id="venue-name" />
          <Field label="校区" value={form.campus} onChange={set('campus')} maxLength={40} id="venue-campus" />
          <Field label="楼栋" value={form.building} onChange={set('building')} maxLength={40} id="venue-building" />
          <Field label="楼层" value={form.floor} onChange={set('floor')} maxLength={20} id="venue-floor" />
          <Field label="房间" value={form.room} onChange={set('room')} maxLength={40} id="venue-room" />
          <div className="grid gap-1.5">
            <Label>允许能力（至少一项）</Label>
            <div className="flex gap-4 pt-1">
              {(['GEO', 'QR'] as const).map((capability) => (
                <label key={capability} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.allowedCapabilities.includes(capability)}
                    onCheckedChange={(value) =>
                      setForm((previous) => ({
                        ...previous,
                        allowedCapabilities:
                          value === true
                            ? [...previous.allowedCapabilities, capability]
                            : previous.allowedCapabilities.filter((item) => item !== capability),
                      }))
                    }
                  />
                  {capability === 'GEO' ? 'GEO 定位' : 'QR 活动码'}
                </label>
              ))}
            </div>
          </div>
          <Field
            label="纬度（GEO 必填）"
            value={form.latitude}
            onChange={set('latitude')}
            type="number"
            id="venue-lat"
          />
          <Field
            label="经度（GEO 必填）"
            value={form.longitude}
            onChange={set('longitude')}
            type="number"
            id="venue-lng"
          />
          <Field
            label="围栏半径（米，5-2000）"
            value={form.radiusMeters}
            onChange={set('radiusMeters')}
            type="number"
            id="venue-radius"
          />
          <Field
            label="精度阈值（米，5-200）"
            value={form.maxAccuracyMeters}
            onChange={set('maxAccuracyMeters')}
            type="number"
            id="venue-accuracy"
          />
          <div className="grid gap-1.5">
            <Label htmlFor="venue-validFrom">有效期起（可选）</Label>
            <Input
              id="venue-validFrom"
              type="datetime-local"
              value={form.validFrom}
              onChange={(event) => set('validFrom')(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="venue-validUntil">有效期止（可选）</Label>
            <Input
              id="venue-validUntil"
              type="datetime-local"
              value={form.validUntil}
              onChange={(event) => set('validUntil')(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="venue-directions">路线说明</Label>
            <Textarea
              id="venue-directions"
              value={form.directions}
              onChange={(event) => set('directions')(event.target.value)}
              rows={2}
              maxLength={500}
              placeholder="从哪个门进、几楼拐弯等成员能看懂的说明"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={locating}
            onClick={() => {
              setLocating(true);
              navigator.geolocation.getCurrentPosition(
                (position) => {
                  setForm((previous) => ({
                    ...previous,
                    latitude: String(position.coords.latitude),
                    longitude: String(position.coords.longitude),
                    maxAccuracyMeters: previous.maxAccuracyMeters || '50',
                    radiusMeters: previous.radiusMeters || '60',
                  }));
                  setLocating(false);
                },
                () => setLocating(false),
                { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
              );
            }}
          >
            {locating && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            用当前位置填入坐标
          </Button>
          <span className="text-xs text-muted-foreground">创建后仍可在版本详情里采集多个样本。</span>
        </div>
        <Button
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || form.name.trim().length < 1 || form.allowedCapabilities.length === 0}
        >
          {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
          创建地点草稿
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  maxLength,
  id,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  maxLength?: number;
  id: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

// ======================= 创建活动 =======================

function CreateActivityDialog({
  principalId,
  open,
  onOpenChange,
}: {
  principalId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>新建活动</DialogTitle>
          <DialogDescription>
            填写活动配置并选择已认证的签到地点；可选关联平台比赛（用于目录匹配与赛后自动结算）。保存后为草稿。
          </DialogDescription>
        </DialogHeader>
        <ActivityFormFields
          principalId={principalId}
          onCancel={() => onOpenChange(false)}
          onSaved={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function ActivityFormDialog({
  principalId,
  open,
  onOpenChange,
  draft,
  onSaved,
}: {
  principalId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft?: ActivityDetailDto;
  onSaved?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{draft ? '编辑活动草稿' : '新建活动（草稿）'}</DialogTitle>
          <DialogDescription>
            {draft ? '修改配置后保存草稿，确认无误后再发布。' : '填写活动配置并选择已认证的签到地点，保存后为草稿。'}
          </DialogDescription>
        </DialogHeader>
        <ActivityFormFields
          principalId={principalId}
          draft={draft}
          onCancel={() => onOpenChange(false)}
          onSaved={() => {
            onOpenChange(false);
            onSaved?.();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/** 活动草稿表单主体（创建/编辑共用；平台比赛绑定仅创建时可设置，编辑不改变来源）。 */
function ActivityFormFields({
  principalId,
  draft,
  onCancel,
  onSaved,
}: {
  principalId: string;
  draft?: ActivityDetailDto;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    type: draft?.type ?? 'training',
    title: draft?.title ?? '',
    announcement: draft?.announcement ?? '',
    joinNotes: draft?.joinNotes ?? '',
    startAt: toLocalInputValue(draft?.startAt),
    endAt: toLocalInputValue(draft?.endAt),
    registerDeadline: toLocalInputValue(draft?.registerDeadline),
    cancelDeadline: toLocalInputValue(draft?.cancelDeadline),
    capacity: draft?.capacity == null ? '' : String(draft.capacity),
    waitlistCapacity: String(draft?.waitlistCapacity ?? 0),
    remoteAllowed: draft?.remoteAllowed ?? false,
    requireValidSubmission: draft?.requireValidSubmission ?? false,
    scoringCategory: String(draft?.scoringConfig?.category ?? 'activity'),
    scoringSpecialCap: draft?.scoringConfig?.specialCap == null ? '' : String(draft.scoringConfig.specialCap),
    scoringLambda: String(draft?.scoringConfig?.lambdaKey ?? 'B'),
    policy: (draft?.policy?.policy ?? 'GEO_OR_QR') as 'GEO_ONLY' | 'QR_ONLY' | 'GEO_OR_QR' | 'GEO_AND_QR',
    checkinOpenAt: toLocalInputValue(draft?.policy?.checkinOpenAt),
    checkinCloseAt: toLocalInputValue(draft?.policy?.checkinCloseAt),
    checkoutOpenAt: toLocalInputValue(draft?.policy?.checkoutOpenAt),
    checkoutCloseAt: toLocalInputValue(draft?.policy?.checkoutCloseAt),
    maxAccuracyMeters: String(draft?.policy?.maxAccuracyMeters ?? 50),
    qrRotateSeconds: String(draft?.policy?.qrRotateSeconds ?? 25),
    selfCheckout: draft?.policy?.selfCheckout ?? true,
    autoCheckout: draft?.policy?.autoCheckout ?? false,
    venueVersionId: draft?.venueVersionId ?? draft?.venueBindings[0]?.venueVersionId ?? '',
    // 平台比赛绑定：仅创建时生效（编辑草稿时后端 schema 不接受变更来源平台）。
    bindContest: Boolean(draft?.platform),
    contestPlatform: draft?.platform ?? 'nowcoder',
    contestExternalId: draft?.platformContestId ?? '',
  });
  const initialForm = useRef(form).current;
  const [error, setError] = useState<string | null>(null);

  const venuesQuery = usePrivateQuery<VenueRowDto[] | null, ApiError>(
    principalId,
    ['admin', 'venues', 'flat'],
    async () => (await api.get<VenueRowDto[]>('/admin/venues?status=active')).data,
    { retry: false },
  );

  const approvedVersions = (venuesQuery.data ?? []).flatMap((venue) =>
    venue.versions.filter((version) => version.status === 'approved' && !version.revokedAt)
      .map((version) => ({ ...version, venueName: venue.name })),
  );
  const venueSelected = approvedVersions.some((version) => version.id === form.venueVersionId);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!venueSelected) throw new Error('请选择已认证的签到地点。');
      if (!draft && form.bindContest && !form.contestExternalId.trim()) {
        throw new Error('已勾选关联平台比赛，请填写比赛 ID。');
      }
      const iso = (value: string) => fromLocalInputValue(value);
      const scoring: Record<string, unknown> = { ...(draft?.scoringConfig ?? {}), category: form.scoringCategory, lambdaKey: form.scoringLambda };
      if (form.scoringSpecialCap) scoring.specialCap = Number(form.scoringSpecialCap);
      else delete scoring.specialCap;
      const body: Record<string, unknown> = {
        type: form.type,
        title: form.title.trim(),
        announcement: form.announcement.trim(),
        joinNotes: form.joinNotes.trim() || (draft ? null : undefined),
        startAt: iso(form.startAt),
        endAt: iso(form.endAt),
        registerDeadline: iso(form.registerDeadline),
        cancelDeadline: iso(form.cancelDeadline),
        capacity: form.capacity ? Number(form.capacity) : null,
        waitlistCapacity: Number(form.waitlistCapacity || 0),
        remoteAllowed: form.remoteAllowed,
        requireValidSubmission: form.requireValidSubmission,
        scoringConfig: scoring,
        venueVersionIds: [form.venueVersionId],
        primaryVenueVersionId: form.venueVersionId,
        attendancePolicy: {
          policy: form.policy,
          checkinOpenAt: form.checkinOpenAt === initialForm.checkinOpenAt && draft?.policy ? draft.policy.checkinOpenAt : iso(form.checkinOpenAt),
          checkinCloseAt: form.checkinCloseAt === initialForm.checkinCloseAt && draft?.policy ? draft.policy.checkinCloseAt : iso(form.checkinCloseAt),
          checkoutOpenAt: form.checkoutOpenAt === initialForm.checkoutOpenAt && draft?.policy ? draft.policy.checkoutOpenAt : iso(form.checkoutOpenAt),
          checkoutCloseAt: form.checkoutCloseAt === initialForm.checkoutCloseAt && draft?.policy ? draft.policy.checkoutCloseAt : iso(form.checkoutCloseAt),
          maxAccuracyMeters: Number(form.maxAccuracyMeters || 50),
          qrRotateSeconds: Number(form.qrRotateSeconds || 25),
          qrTtlSeconds: draft?.policy?.qrTtlSeconds ?? 60,
          selfCheckout: form.selfCheckout,
          autoCheckout: form.autoCheckout,
        },
      };
      if (!draft && form.bindContest) {
        body.platform = form.contestPlatform;
        body.platformContestId = form.contestExternalId.trim();
      }
      if (draft) {
        // 只提交修改过的字段，保留秒级时间、平台来源与多地点绑定等原始配置。
        const changes: Record<string, unknown> = { expectedRevision: draft.revision };
        const scalarKeys = ['type', 'title', 'announcement', 'joinNotes', 'startAt', 'endAt', 'registerDeadline', 'cancelDeadline', 'capacity', 'waitlistCapacity', 'remoteAllowed', 'requireValidSubmission'] as const;
        for (const key of scalarKeys) if (form[key] !== initialForm[key]) changes[key] = body[key];
        if (form.scoringCategory !== initialForm.scoringCategory || form.scoringSpecialCap !== initialForm.scoringSpecialCap || form.scoringLambda !== initialForm.scoringLambda) changes.scoringConfig = scoring;
        const policyKeys = ['policy', 'checkinOpenAt', 'checkinCloseAt', 'checkoutOpenAt', 'checkoutCloseAt', 'maxAccuracyMeters', 'qrRotateSeconds', 'selfCheckout', 'autoCheckout'] as const;
        if (!draft.policy || policyKeys.some((key) => form[key] !== initialForm[key])) changes.attendancePolicy = body.attendancePolicy;
        if (form.venueVersionId !== initialForm.venueVersionId || !draft.venueBindings.some((binding) => binding.venueVersionId === form.venueVersionId)) {
          changes.venueVersionIds = body.venueVersionIds;
          changes.primaryVenueVersionId = body.primaryVenueVersionId;
        }
        return (await api.patch(`/admin/activities/${draft.id}`, changes)).data;
      }
      return (await api.post<{ activityId: string }>('/admin/activities', body)).data;
    },
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'activities'] });
      onSaved();
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label>活动类型</Label>
          <Select value={form.type} onValueChange={set('type')}>
            <SelectTrigger aria-label="活动类型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(ACTIVITY_TYPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Field label="标题 *（2-120 字）" value={form.title} onChange={set('title')} id="activity-title" />
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="activity-announcement">公告 *（5-20000 字）</Label>
          <Textarea
            id="activity-announcement"
            value={form.announcement}
            onChange={(event) => set('announcement')(event.target.value)}
            rows={4}
          />
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="activity-notes">参加须知（可选）</Label>
          <Textarea id="activity-notes" value={form.joinNotes} onChange={(event) => set('joinNotes')(event.target.value)} rows={2} maxLength={4000} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="activity-start">开始时间 *</Label>
          <Input
            id="activity-start"
            type="datetime-local"
            value={form.startAt}
            onChange={(event) => set('startAt')(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="activity-end">结束时间 *</Label>
          <Input
            id="activity-end"
            type="datetime-local"
            value={form.endAt}
            onChange={(event) => set('endAt')(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="activity-reg-deadline">报名截止（可选）</Label>
          <Input
            id="activity-reg-deadline"
            type="datetime-local"
            value={form.registerDeadline}
            onChange={(event) => set('registerDeadline')(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="activity-cancel-deadline">取消截止（可选）</Label>
          <Input
            id="activity-cancel-deadline"
            type="datetime-local"
            value={form.cancelDeadline}
            onChange={(event) => set('cancelDeadline')(event.target.value)}
          />
        </div>
        <Field label="容量（空=不限）" value={form.capacity} onChange={set('capacity')} type="number" id="activity-capacity" />
        <Field label="候补容量" value={form.waitlistCapacity} onChange={set('waitlistCapacity')} type="number" id="activity-waitlist" />

        {!draft && (
          <fieldset className="grid gap-2 rounded-xl border border-border p-3 sm:col-span-2">
            <legend className="px-1 text-sm font-semibold text-foreground">关联平台比赛（可选）</legend>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.bindContest}
                onCheckedChange={(value) =>
                  setForm((previous) => ({ ...previous, bindContest: value === true }))
                }
              />
              本活动对应一场平台比赛
            </label>
            {form.bindContest && (
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>平台</Label>
                  <Select value={form.contestPlatform} onValueChange={set('contestPlatform')}>
                    <SelectTrigger aria-label="比赛平台">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="nowcoder">牛客</SelectItem>
                      <SelectItem value="codeforces">Codeforces</SelectItem>
                      <SelectItem value="atcoder">AtCoder</SelectItem>
                      <SelectItem value="hydro">Hydro（校内）</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Field
                  label="比赛 ID *"
                  value={form.contestExternalId}
                  onChange={set('contestExternalId')}
                  id="activity-contest-id"
                />
              </div>
            )}
            <p className="text-xs leading-5 text-muted-foreground">
              直接填写比赛 ID（无需等待异步导入任务）：用于指定目录 λ 系数匹配、成员端比赛成绩展示，
              活动结束 5 分钟后结算引擎自动抓取榜单计分。公告与时间仍需手动填写，与「导入平台比赛」的
              自动抓取元数据方式不同，保存后不可更改。
            </p>
          </fieldset>
        )}

        <fieldset className="grid gap-2 rounded-xl border border-border p-3 sm:col-span-2">
          <legend className="px-1 text-sm font-semibold text-foreground">计分配置（简化）</legend>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label>计分类别</Label>
              <Select value={form.scoringCategory} onValueChange={set('scoringCategory')}>
                <SelectTrigger aria-label="计分类别">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="activity">活动参与</SelectItem>
                  <SelectItem value="contest">比赛</SelectItem>
                  <SelectItem value="contribution">贡献</SelectItem>
                  <SelectItem value="service">服务</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>λ 档位（结算引擎用）</Label>
              <Select value={form.scoringLambda} onValueChange={set('scoringLambda')}>
                <SelectTrigger aria-label="λ 档位">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="A">甲类 λ=1.2</SelectItem>
                  <SelectItem value="B">乙类 λ=1.0</SelectItem>
                  <SelectItem value="C">丙类 λ=0.8</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Field
              label="特殊上限（可选，分）"
              value={form.scoringSpecialCap}
              onChange={set('scoringSpecialCap')}
              type="number"
              id="activity-cap"
            />
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            λ 档位供赛后结算引擎使用：未设置时引擎按指定目录匹配，仍无则默认乙类；平台赛活动结束后
            5 分钟自动结算入账（也可在详情页手动「结算比赛积分」）。
          </p>
        </fieldset>

        <fieldset className="grid gap-3 rounded-xl border border-border p-3 sm:col-span-2">
          <legend className="px-1 text-sm font-semibold text-foreground">签到策略子表单</legend>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>策略</Label>
              <Select
                value={form.policy}
                onValueChange={(value) =>
                  setForm((previous) => ({
                    ...previous,
                    policy: value as typeof previous.policy,
                  }))
                }
              >
                <SelectTrigger aria-label="签到策略">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GEO_ONLY">仅定位</SelectItem>
                  <SelectItem value="QR_ONLY">仅活动码</SelectItem>
                  <SelectItem value="GEO_OR_QR">定位或活动码</SelectItem>
                  <SelectItem value="GEO_AND_QR">定位 + 活动码</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>签到地点 *（必填）</Label>
              <Select
                value={form.venueVersionId || 'none'}
                onValueChange={(value) => set('venueVersionId')(value === 'none' ? '' : value)}
              >
                <SelectTrigger aria-label="签到地点版本" aria-required="true" aria-invalid={!venueSelected}>
                  <SelectValue placeholder="选择已认证地点版本" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" disabled>请选择签到地点</SelectItem>
                  {(venuesQuery.data ?? []).flatMap((venue) =>
                    venue.versions
                      .filter((version) => version.status === 'approved' && !version.revokedAt)
                      .map((version) => (
                        <SelectItem key={version.id} value={version.id}>
                          {venue.name} v{version.versionNo}（{version.id.slice(0, 8)}）
                        </SelectItem>
                      )),
                  )}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">所有签到策略都需要地点，包括仅活动码。</p>
              {venuesQuery.isError ? (
                <p className="text-xs text-destructive">地点加载失败：{venuesQuery.error.message}</p>
              ) : !venuesQuery.isPending && approvedVersions.length === 0 ? (
                <p className="text-xs text-destructive">暂无已认证地点，请先到「地点」创建并完成认证。</p>
              ) : !venuesQuery.isPending && !venueSelected ? (
                <p className="text-xs text-destructive">请选择已认证的签到地点后再保存。</p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="policy-checkin-open">签到窗口起 *</Label>
              <Input
                id="policy-checkin-open"
                type="datetime-local"
                value={form.checkinOpenAt}
                onChange={(event) => set('checkinOpenAt')(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="policy-checkin-close">签到窗口止 *</Label>
              <Input
                id="policy-checkin-close"
                type="datetime-local"
                value={form.checkinCloseAt}
                onChange={(event) => set('checkinCloseAt')(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="policy-checkout-open">签退窗口起（可选）</Label>
              <Input
                id="policy-checkout-open"
                type="datetime-local"
                value={form.checkoutOpenAt}
                onChange={(event) => set('checkoutOpenAt')(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="policy-checkout-close">签退窗口止（可选）</Label>
              <Input
                id="policy-checkout-close"
                type="datetime-local"
                value={form.checkoutCloseAt}
                onChange={(event) => set('checkoutCloseAt')(event.target.value)}
              />
            </div>
            <Field
              label="定位精度阈值（米）"
              value={form.maxAccuracyMeters}
              onChange={set('maxAccuracyMeters')}
              type="number"
              id="policy-accuracy"
            />
            <Field
              label="活动码轮换（秒）"
              value={form.qrRotateSeconds}
              onChange={set('qrRotateSeconds')}
              type="number"
              id="policy-rotate"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.selfCheckout}
              onCheckedChange={(value) =>
                setForm((previous) => ({ ...previous, selfCheckout: value === true }))
              }
            />
            允许成员自助签退
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.autoCheckout}
              onCheckedChange={(value) =>
                setForm((previous) => ({ ...previous, autoCheckout: value === true }))
              }
            />
            活动结束自动签退（未签退者按结束时间补记）
          </label>
        </fieldset>

        <div className="flex flex-col gap-2 sm:col-span-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.remoteAllowed}
              onCheckedChange={(value) =>
                setForm((previous) => ({ ...previous, remoteAllowed: value === true }))
              }
            />
            允许远程参赛（每月次数由积分认定时校验）
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.requireValidSubmission}
              onCheckedChange={(value) =>
                setForm((previous) => ({ ...previous, requireValidSubmission: value === true }))
              }
            />
            需要平台有效提交（比赛类默认开启）
          </label>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={mutation.isPending} onClick={onCancel}>
          取消
        </Button>
        <Button
          onClick={() => mutation.mutate()}
          disabled={
            mutation.isPending ||
            !venueSelected ||
            form.title.trim().length < 2 ||
            form.announcement.trim().length < 5 ||
            !form.startAt ||
            !form.endAt ||
            !form.checkinOpenAt ||
            !form.checkinCloseAt ||
            (!draft && form.bindContest && !form.contestExternalId.trim())
          }
        >
          {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
          {draft ? '保存草稿' : '创建草稿'}
        </Button>
      </div>
    </div>
  );
}

