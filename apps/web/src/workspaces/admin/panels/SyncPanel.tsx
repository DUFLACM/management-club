/**
 * 管理端 · 平台同步（sync.manage / members.read）：
 * GET /admin/platform/jobs（最近任务）+ GET /admin/platform/accounts?status=（绑定审核，
 * POST /admin/platform/accounts/:id/review）+ POST /admin/platform/jobs/:id/retry。
 * 只展示最近成功/失败事实，不放假曲线。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon, RefreshCwIcon } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrincipal } from '@/lib/session';
import { formatDateTime, platformLabel } from '@/lib/format';
import { PanelHeader } from '@/components/club/PanelHeader';
import { PrincipalGate } from '@/components/club/QueryBoundary';
import { EmptyState } from '@/components/club/EmptyState';
import { ErrorState } from '@/components/club/ErrorState';
import { StatusBadge } from '@/components/club/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface JobDto {
  id: string;
  type: string;
  status: string;
  attempts: number;
  runAfter: string;
  lastError: string | null;
  createdAt: string;
}

interface AccountDto {
  id: string;
  platform: string;
  externalId: string;
  displayHandle: string | null;
  status: string;
  proofSummary: string | null;
  createdAt: string;
  user: { id: string; verifiedRealName: string | null; studentNo: string | null } | null;
}

const JOB_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '更新中',
  done: '成功',
  dead: '失败',
};

export default function SyncPanel() {
  const principal = usePrincipal();
  return (
    <PrincipalGate principal={principal}>
      {(principalId) => <SyncBody principalId={principalId} />}
    </PrincipalGate>
  );
}

function SyncBody({ principalId }: { principalId: string }) {
  const queryClient = useQueryClient();
  const [accountStatus, setAccountStatus] = useState('pending_review');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const jobsQuery = usePrivateQuery<JobDto[], ApiError>(
    principalId,
    ['admin', 'platform', 'jobs'],
    async () => (await api.get<JobDto[]>('/admin/platform/jobs')).data,
    { refetchInterval: 15_000 },
  );

  const accountsQuery = usePrivateQuery<AccountDto[], ApiError>(
    principalId,
    ['admin', 'platform', 'accounts', accountStatus],
    async () =>
      (await api.get<AccountDto[]>(`/admin/platform/accounts?status=${accountStatus}`)).data,
  );

  const reviewMutation = useMutation({
    mutationFn: async (input: { id: string; decision: 'verify' | 'reject'; note?: string }) => {
      await api.post(`/admin/platform/accounts/${input.id}/review`, {
        decision: input.decision,
        ...(input.note ? { note: input.note } : {}),
      });
      return input;
    },
    onSuccess: (input) => {
      setActionError(null);
      setActionNotice(
        input.decision === 'verify'
          ? '已核验持有；系统自动排队一次初始同步。'
          : '已驳回该绑定（账号进入已解绑状态）。',
      );
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'platform'] });
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  const retryMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const { data } = await api.post<{ retried: boolean; reason?: string }>(
        `/admin/platform/jobs/${jobId}/retry`,
      );
      return data;
    },
    onSuccess: (result) => {
      setActionError(null);
      setActionNotice(result.retried ? '任务已重新排队。' : (result.reason ?? '未能重试该任务。'));
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'platform', 'jobs'] });
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="平台同步"
        description="绑定持有核验与同步任务状态；最近成功/失败一目了然。"
        actions={
          <Button
            variant="outline"
            onClick={() => {
              void jobsQuery.refetch();
              void accountsQuery.refetch();
            }}
          >
            <RefreshCwIcon aria-hidden="true" />
            刷新状态
          </Button>
        }
      />

      {actionError && (
        <Alert variant="destructive">
          <AlertTitle>操作未完成</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}
      {actionNotice && !actionError && (
        <Alert>
          <AlertTitle>已处理</AlertTitle>
          <AlertDescription>{actionNotice}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="p-0 pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2 p-5 pb-3">
            <h2 className="text-sm font-semibold text-foreground">绑定审核</h2>
            <Select value={accountStatus} onValueChange={setAccountStatus}>
              <SelectTrigger className="w-40" aria-label="绑定状态筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending_review">待持有核验</SelectItem>
                <SelectItem value="verified">已核验</SelectItem>
                <SelectItem value="revoked">已解绑</SelectItem>
                <SelectItem value="all">全部</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {accountsQuery.isPending ? (
            <div className="flex flex-col gap-2 px-5">
              {[0, 1].map((index) => (
                <Skeleton key={index} className="h-12" />
              ))}
            </div>
          ) : accountsQuery.isError ? (
            <div className="px-5 pb-5">
              {accountsQuery.error.status === 403 ? (
                <EmptyState kind="forbidden" description={accountsQuery.error.message} />
              ) : (
                <ErrorState
                  description={accountsQuery.error.message}
                  onRetry={() => void accountsQuery.refetch()}
                  retrying={accountsQuery.isFetching}
                />
              )}
            </div>
          ) : (accountsQuery.data ?? []).length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted-foreground">当前筛选下没有绑定记录。</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {(accountsQuery.data ?? []).map((account) => (
                <li key={account.id} className="flex flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {platformLabel(account.platform)} · {account.displayHandle ?? account.externalId}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {account.user?.verifiedRealName ?? '—'} ·{' '}
                      <span className="tabular-nums">{account.user?.studentNo ?? '—'}</span>
                    </span>
                    <span className="ml-auto">
                      <StatusBadge
                        kind="sync"
                        value={
                          account.status === 'verified'
                            ? '已核验'
                            : account.status === 'pending_review'
                              ? '待持有核验'
                              : '已解绑'
                        }
                      />
                    </span>
                  </div>
                  {account.proofSummary && (
                    <p className="text-xs leading-5 text-muted-foreground">
                      持有说明：{account.proofSummary}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {account.status === 'pending_review' && (
                      <>
                        <Button
                          size="sm"
                          disabled={reviewMutation.isPending}
                          onClick={() =>
                            reviewMutation.mutate({
                              id: account.id,
                              decision: 'verify',
                              note: '持有证明人工核验通过',
                            })
                          }
                        >
                          {reviewMutation.isPending && reviewMutation.variables?.id === account.id && (
                            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                          )}
                          核验通过
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={reviewMutation.isPending}
                          onClick={() => {
                            const note = window.prompt('驳回说明（可选）') ?? '';
                            reviewMutation.mutate({ id: account.id, decision: 'reject', note: note || undefined });
                          }}
                        >
                          驳回
                        </Button>
                      </>
                    )}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      申请于 {formatDateTime(account.createdAt)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0 pb-2">
          <div className="p-5 pb-3">
            <h2 className="text-sm font-semibold text-foreground">最近同步任务</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              仅展示事实状态（排队/运行/成功/死信）与最近错误；15 秒自动刷新。
            </p>
          </div>
          {jobsQuery.isPending ? (
            <div className="flex flex-col gap-2 px-5">
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} className="h-10" />
              ))}
            </div>
          ) : jobsQuery.isError ? (
            <div className="px-5 pb-5">
              <ErrorState
                description={jobsQuery.error.message}
                onRetry={() => void jobsQuery.refetch()}
                retrying={jobsQuery.isFetching}
              />
            </div>
          ) : (jobsQuery.data ?? []).length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted-foreground">暂无平台同步任务。</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="h-10">
                    <TableHead className="pl-5">任务</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">尝试</TableHead>
                    <TableHead>计划执行</TableHead>
                    <TableHead>最近错误</TableHead>
                    <TableHead className="pr-5" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(jobsQuery.data ?? []).map((job) => (
                    <TableRow key={job.id} className="h-14">
                      <TableCell className="pl-5 font-mono text-xs">{job.type}</TableCell>
                      <TableCell>
                        <StatusBadge
                          kind="sync"
                          value={JOB_STATUS_LABELS[job.status] ?? job.status}
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{job.attempts}</TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {formatDateTime(job.runAfter)}
                      </TableCell>
                      <TableCell className="max-w-64 truncate text-xs text-destructive">
                        {job.lastError ?? '—'}
                      </TableCell>
                      <TableCell className="pr-5">
                        {(job.status === 'dead' || job.status === 'failed') && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={retryMutation.isPending}
                            onClick={() => retryMutation.mutate(job.id)}
                          >
                            重试
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
