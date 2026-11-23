/**
 * 成员端 · 训练室预约视图：
 * - 近期 14 天占用时段概览（查看当前已占人数与上限 9 人余量）；
 * - 发起新预约（至少提前 24 小时、单次 ≤6 小时、至少 3 人联名、每人每日 1 次 / 每周 2 次）；
 * - 我的预约记录（含审批状态、驳回原因与取消操作）。
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ClockIcon,
  DoorOpenIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  PlusIcon,
  SearchIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { useDebouncedValue } from '@/lib/hooks';
import { formatDateTime } from '@/lib/format';
import { ErrorState } from '@/components/club/ErrorState';
import { EmptyState } from '@/components/club/EmptyState';
import { StatusBadge } from '@/components/club/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

interface MemberRef {
  userId: string;
  studentNo: string;
  name: string;
}

export interface RoomBookingDto {
  id: string;
  startsAt: string;
  endsAt: string;
  purpose: string;
  contestLink: string | null;
  headcount: number;
  status: string;
  rejectionReason: string | null;
  approvedAt: string | null;
  createdAt: string;
  applicant: MemberRef;
  coApplicants: MemberRef[];
}

function defaultStartLocal(): string {
  const d = new Date(Date.now() + 26 * 3600_000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
}

function defaultEndLocal(): string {
  const d = new Date(Date.now() + 29 * 3600_000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
}

function bookingStatusBadge(status: string): string {
  if (status === 'approved') return '已批准';
  if (status === 'rejected') return '已驳回';
  if (status === 'cancelled') return '已取消';
  return '待审批';
}

export function RoomBookingPanel({ principalId }: { principalId: string }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const scheduleQuery = usePrivateQuery<RoomBookingDto[], ApiError>(
    principalId,
    ['me', 'room-bookings', 'schedule'],
    async () => (await api.get<RoomBookingDto[]>('/me/room-bookings/schedule')).data,
  );

  const mineQuery = usePrivateQuery<RoomBookingDto[], ApiError>(
    principalId,
    ['me', 'room-bookings', 'mine'],
    async () => (await api.get<RoomBookingDto[]>('/me/room-bookings')).data,
  );

  const cancelMutation = useMutation({
    mutationFn: (bookingId: string) => api.post(`/me/room-bookings/${bookingId}/cancel`),
    onSuccess: () => {
      setActionError(null);
      setNotice('已取消该训练室预约。');
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'me', 'room-bookings'] });
    },
    onError: (err: ApiError) => setActionError(err.message),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'me', 'room-bookings'] });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="border-primary/20 bg-primary/[0.02]">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
          <div className="flex flex-col gap-1">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <DoorOpenIcon className="size-4 text-primary" aria-hidden="true" />
              训练室自助预约
            </h2>
            <p className="text-xs leading-5 text-muted-foreground">
              至少提前 24 小时申请 · 至少 3 人联名（主申请人 + ≥2 位共同申请人）· 同时上限 9 人 · 单次最长 6 小时（超过 3 小时需说明）· 每人每日 1 次 / 每周 2 次。
            </p>
          </div>
          <Button type="button" onClick={() => setCreateOpen(true)}>
            <PlusIcon aria-hidden="true" />
            申请训练室
          </Button>
        </CardContent>
      </Card>

      {notice && (
        <Alert>
          <AlertTitle>已提交</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {actionError && (
        <Alert variant="destructive">
          <AlertTitle>操作失败</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <Card className="xl:col-span-7">
          <CardContent className="flex flex-col gap-3 p-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <ClockIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                未来 14 天时段占用
              </h3>
              <span className="text-xs text-muted-foreground">容量上限 9 人/时段</span>
            </div>
            {scheduleQuery.isPending ? (
              <Skeleton className="h-44 rounded-xl" />
            ) : scheduleQuery.isError ? (
              <ErrorState description={scheduleQuery.error.message} onRetry={() => void scheduleQuery.refetch()} />
            ) : scheduleQuery.data.length === 0 ? (
              <EmptyState kind="empty" title="近期时段空闲" description="未来 14 天暂无已提交或已批准的训练室预约。" />
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {scheduleQuery.data.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">{row.purpose}</span>
                        <StatusBadge kind="disclosure" value={bookingStatusBadge(row.status)} />
                        <Badge variant="outline" className="tabular-nums">
                          {row.headcount} / 9 人
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                        {formatDateTime(row.startsAt)} ~ {formatDateTime(row.endsAt)} · 申请人：{row.applicant.name}
                        {row.coApplicants.length > 0 ? ` 等 ${row.headcount} 人` : ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="xl:col-span-5">
          <CardContent className="flex flex-col gap-3 p-5">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <UsersIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              我的预约记录
            </h3>
            {mineQuery.isPending ? (
              <Skeleton className="h-44 rounded-xl" />
            ) : mineQuery.isError ? (
              <ErrorState description={mineQuery.error.message} onRetry={() => void mineQuery.refetch()} />
            ) : mineQuery.data.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">你还没有发起或参与过训练室预约。</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {mineQuery.data.map((row) => {
                  const canCancel =
                    (row.status === 'pending' || row.status === 'approved') &&
                    new Date(row.startsAt).getTime() > Date.now();
                  return (
                    <li key={row.id} className="flex flex-col gap-1.5 py-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-foreground">{row.purpose}</span>
                        <StatusBadge kind="disclosure" value={bookingStatusBadge(row.status)} />
                      </div>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {formatDateTime(row.startsAt)} ~ {formatDateTime(row.endsAt)}（{row.headcount} 人）
                      </p>
                      <p className="text-xs text-muted-foreground">
                        成员：{row.applicant.name}
                        {row.coApplicants.map((m) => `、${m.name}`).join('')}
                      </p>
                      {row.contestLink && (
                        <a
                          href={row.contestLink}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          <ExternalLinkIcon className="size-3" aria-hidden="true" />
                          关联比赛/训练链接
                        </a>
                      )}
                      {row.rejectionReason && (
                        <p className="rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                          驳回原因：{row.rejectionReason}
                        </p>
                      )}
                      {canCancel && (
                        <div className="pt-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={cancelMutation.isPending}
                            onClick={() => cancelMutation.mutate(row.id)}
                          >
                            取消预约
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <CreateRoomBookingDialog
        principalId={principalId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setActionError(null);
          setNotice('训练室预约申请已提交，审批结果会通过消息中心通知所有共同申请人。');
          invalidate();
        }}
      />
    </div>
  );
}

function CreateRoomBookingDialog({
  principalId,
  open,
  onOpenChange,
  onCreated,
}: {
  principalId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [startsAt, setStartsAt] = useState(defaultStartLocal);
  const [endsAt, setEndsAt] = useState(defaultEndLocal);
  const [purpose, setPurpose] = useState('');
  const [contestLink, setContestLink] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<MemberRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const debounced = useDebouncedValue(search, 300);

  const candidatesQuery = usePrivateQuery<MemberRef[], ApiError>(
    open ? principalId : null,
    ['me', 'room-bookings', 'candidates', debounced],
    async () => {
      const qs = debounced ? `?q=${encodeURIComponent(debounced)}` : '';
      return (await api.get<MemberRef[]>(`/me/room-bookings/candidates${qs}`)).data;
    },
  );

  const selectedIds = useMemo(() => new Set(selected.map((m) => m.userId)), [selected]);

  const mutation = useMutation({
    mutationFn: async () => {
      await api.post('/me/room-bookings', {
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        purpose: purpose.trim(),
        coApplicantUserIds: selected.map((m) => m.userId),
        contestLink: contestLink.trim() || undefined,
      });
    },
    onSuccess: () => {
      setError(null);
      setPurpose('');
      setContestLink('');
      setSelected([]);
      onOpenChange(false);
      onCreated();
    },
    onError: (err: ApiError) => setError(err.message),
  });

  const canSubmit = purpose.trim().length >= 3 && selected.length >= 2 && selected.length <= 8 && startsAt && endsAt;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>申请训练室使用</DialogTitle>
          <DialogDescription>至少提前 24 小时提交，并选择至少 2 名共同申请人（共 ≥3 人）。</DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[65dvh] flex-col gap-3 overflow-y-auto pr-1">
          {error && (
            <Alert variant="destructive">
              <AlertTitle>无法提交</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="room-start">开始时间</Label>
              <Input
                id="room-start"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="room-end">结束时间（≤6 小时）</Label>
              <Input
                id="room-end"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="room-purpose">使用用途（3-300 字）</Label>
            <Input
              id="room-purpose"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="如：ICPC 区域赛模拟 VP（3 人小队）"
              maxLength={300}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="room-link">比赛 / 训练链接（可选）</Label>
            <Input
              id="room-link"
              value={contestLink}
              onChange={(e) => setContestLink(e.target.value)}
              placeholder="https://codeforces.com/gym/..."
              maxLength={300}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="room-co-search">
              共同申请人（已选 {selected.length} 人，需 2–8 人，总计 {selected.length + 1} 人）
            </Label>
            {selected.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selected.map((member) => (
                  <Badge key={member.userId} variant="info" className="gap-1 pr-1">
                    {member.name}
                    <button
                      type="button"
                      aria-label={`移除 ${member.name}`}
                      onClick={() => setSelected((prev) => prev.filter((item) => item.userId !== member.userId))}
                      className="rounded-full p-0.5 hover:bg-muted"
                    >
                      <XIcon className="size-3" aria-hidden="true" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="room-co-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="按姓名或学号搜索队友"
                className="pl-8"
              />
            </div>
            <ul className="max-h-36 divide-y divide-border overflow-y-auto rounded-xl border border-border">
              {(candidatesQuery.data ?? [])
                .filter((c) => !selectedIds.has(c.userId))
                .map((candidate) => (
                  <li key={candidate.userId}>
                    <button
                      type="button"
                      disabled={selected.length >= 8}
                      onClick={() => setSelected((prev) => [...prev, candidate])}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-muted/50 disabled:opacity-50"
                    >
                      <span className="font-medium text-foreground">{candidate.name}</span>
                      <span className="text-muted-foreground tabular-nums">{candidate.studentNo}</span>
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            type="button"
            disabled={!canSubmit || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            提交预约申请
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
