/**
 * 管理端 · 训练室预约审批标签页（挂载于活动与地点面板）：
 * GET /admin/room-bookings?status= + POST /admin/room-bookings/:id/decision。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLinkIcon, LoaderCircleIcon } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { formatDateTime } from '@/lib/format';
import type { RoomBookingDto } from '@/components/club/RoomBookingPanel';
import { EmptyState } from '@/components/club/EmptyState';
import { ErrorState } from '@/components/club/ErrorState';
import { StatusBadge } from '@/components/club/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

const STATUS_OPTIONS = [
  { value: 'pending', label: '待审批' },
  { value: 'approved', label: '已批准' },
  { value: 'rejected', label: '已驳回' },
  { value: 'cancelled', label: '已取消' },
  { value: 'all', label: '全部状态' },
];

export function AdminRoomBookingsTab({ principalId }: { principalId: string }) {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('pending');
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = usePrivateQuery<RoomBookingDto[], ApiError>(
    principalId,
    ['admin', 'room-bookings', statusFilter],
    async () => (await api.get<RoomBookingDto[]>(`/admin/room-bookings?status=${statusFilter}`)).data,
  );

  const decisionMutation = useMutation({
    mutationFn: async (input: { id: string; decision: 'approve' | 'reject'; reason?: string }) => {
      await api.post(`/admin/room-bookings/${input.id}/decision`, {
        decision: input.decision,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      return input.decision;
    },
    onSuccess: (decision) => {
      setError(null);
      setNotice(decision === 'approve' ? '已批准该训练室预约，并通知所有申请人。' : '已驳回该预约，并通知所有申请人。');
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'room-bookings'] });
    },
    onError: (err: ApiError) => setError(err.message),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          审核成员提交的训练室使用申请；批准/驳回会自动通知主申请人及全部共同申请人。
        </p>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36" aria-label="按预约状态筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {notice && (
        <Alert>
          <AlertTitle>已处理</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>操作未完成</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {query.isPending ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : query.isError ? (
        <ErrorState description={query.error.message} onRetry={() => void query.refetch()} />
      ) : query.data.length === 0 ? (
        <EmptyState kind="empty" title="暂无匹配预约" description="当前筛选状态下没有训练室预约记录。" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="flex flex-col divide-y divide-border">
              {query.data.map((row) => {
                const durationHours = (Date.parse(row.endsAt) - Date.parse(row.startsAt)) / 3600_000;
                const busy = decisionMutation.isPending && decisionMutation.variables?.id === row.id;
                return (
                  <li key={row.id} className="flex flex-col gap-2.5 p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-foreground">{row.purpose}</span>
                          <StatusBadge
                            kind="disclosure"
                            value={
                              row.status === 'approved'
                                ? '已批准'
                                : row.status === 'rejected'
                                  ? '已驳回'
                                  : row.status === 'cancelled'
                                    ? '已取消'
                                    : '待审批'
                            }
                          />
                          <Badge variant="outline" className="tabular-nums">
                            {row.headcount} 人 · {durationHours.toFixed(1)} 小时
                          </Badge>
                          {durationHours > 3 && (
                            <Badge variant="warning" className="text-[11px]">
                              超 3 小时加长申请
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                          时段：{formatDateTime(row.startsAt)} ~ {formatDateTime(row.endsAt)}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          主申请人：{row.applicant.name}（{row.applicant.studentNo}） · 共同申请人：
                          {row.coApplicants.map((m) => `${m.name}（${m.studentNo}）`).join('、')}
                        </p>
                        {row.contestLink && (
                          <a
                            href={row.contestLink}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            <ExternalLinkIcon className="size-3" aria-hidden="true" />
                            {row.contestLink}
                          </a>
                        )}
                        {row.rejectionReason && (
                          <p className="mt-1 text-xs text-destructive">驳回说明：{row.rejectionReason}</p>
                        )}
                      </div>
                    </div>

                    {row.status === 'pending' && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <Input
                          value={rejectReasons[row.id] ?? ''}
                          onChange={(e) =>
                            setRejectReasons((prev) => ({ ...prev, [row.id]: e.target.value }))
                          }
                          placeholder="驳回原因（可选）"
                          className="h-8 max-w-xs text-xs"
                        />
                        <Button
                          type="button"
                          size="sm"
                          disabled={decisionMutation.isPending}
                          onClick={() => decisionMutation.mutate({ id: row.id, decision: 'approve' })}
                        >
                          {busy && decisionMutation.variables?.decision === 'approve' && (
                            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                          )}
                          批准
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={decisionMutation.isPending}
                          onClick={() =>
                            decisionMutation.mutate({
                              id: row.id,
                              decision: 'reject',
                              reason: (rejectReasons[row.id] ?? '').trim() || undefined,
                            })
                          }
                        >
                          {busy && decisionMutation.variables?.decision === 'reject' && (
                            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                          )}
                          驳回
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
