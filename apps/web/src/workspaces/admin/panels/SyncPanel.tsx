/**
 * 管理端 · 平台同步（sync.manage / members.read）：
 * GET /admin/platform/jobs（最近任务）+ GET /admin/platform/jobs/failures（完整失败队列）
 * + GET /admin/platform/accounts?status=（绑定审核，POST /admin/platform/accounts/:id/review，
 * POST /admin/platform/accounts/:id/sync）+ POST /admin/platform/jobs/:id/{retry,cancel}
 * + POST /admin/platform/jobs/retry-failures。
 * 失败任务单独成队列，不受“最近 N 条”截断；支持重试、全部重试、忽略与账号级重新同步。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';

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
  updatedAt: string;
  /** 账号同步任务的目标账号（payload.accountId）；全量刷新等任务为 null */
  accountId: string | null;
  account: {
    id: string;
    platform: string;
    externalId: string;
    displayHandle: string | null;
    status: string;
    user: { id: string; verifiedRealName: string | null; studentNo: string | null } | null;
  } | null;
}

const JOB_TYPE_LABELS: Record<string, string> = {
  'platform.sync_account': '账号同步',
  'platform.refresh_all': '每日全量刷新',
};

interface AccountDto {
  id: string;
  platform: string;
  externalId: string;
  displayHandle: string | null;
  status: string;
  proofSummary: string | null;
  createdAt: string;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  user: { id: string; verifiedRealName: string | null; studentNo: string | null } | null;
}

interface FailureQueueDto {
  items: JobDto[];
  total: number;
}

const JOB_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '更新中',
  done: '成功',
  dead: '失败',
  failed: '失败',
  cancelled: '已忽略',
};

const JOB_STATUS_FILTERS = [
  { value: 'all', label: '全部状态' },
  { value: 'failed', label: '失败' },
  { value: 'active', label: '排队 / 运行' },
  { value: 'done', label: '成功' },
  { value: 'cancelled', label: '已忽略' },
];

/** 把常见第三方错误翻译成管理员能执行的下一步，避免只看到一行英文报错 */
function syncErrorHint(error: string | null): string | null {
  if (!error) return null;
  const text = error.toLowerCase();
  if (/解析到禁止访问|private|内网|ssrf/.test(text)) {
    return '出站地址被安全策略拒绝：检查服务器代理是否把平台域名解析到 fake-IP，或配置 PLATFORM_*_ADDRESS 为经核验的公网 IP。';
  }
  if (/403|401|forbidden|unauthorized|风控|访问受限/.test(text)) {
    return '平台拒绝访问：确认账号在平台上是公开的、未被风控；稍后重试，必要时让成员核对绑定 UID/handle。';
  }
  if (/429|rate limit|too many|限流/.test(text)) {
    return '平台限流：等待一段时间再重试，不要连续手动刷新；批量重试已按 30 秒错峰。';
  }
  if (/timeout|timed out|超时|econnreset|econnrefused|etimedout|enotfound|fetch failed|network/.test(text)) {
    return '网络或 DNS 失败：检查服务器出站网络、代理和平台域名解析。';
  }
  if (/not found|不存在|404|unknown user|invalid handle/.test(text)) {
    return '平台账号或比赛不存在：核对成员绑定的 UID / handle，必要时解绑后重新绑定。';
  }
  if (/无处理器|handler/.test(text)) {
    return '任务没有对应处理器：确认 Worker 与 API 版本一致，并重启 Worker。';
  }
  return null;
}

function jobAccountLabel(job: JobDto): string | null {
  if (!job.account) return null;
  const handle = job.account.displayHandle ?? job.account.externalId;
  const owner = job.account.user?.verifiedRealName ?? job.account.user?.studentNo;
  return `${platformLabel(job.account.platform)} · ${handle}${owner ? ` · ${owner}` : ''}`;
}

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
  const [jobStatus, setJobStatus] = useState('all');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const jobsQuery = usePrivateQuery<JobDto[], ApiError>(
    principalId,
    ['admin', 'platform', 'jobs', jobStatus],
    async () => (await api.get<JobDto[]>(`/admin/platform/jobs?status=${jobStatus}`)).data,
    { refetchInterval: 15_000 },
  );

  const failuresQuery = usePrivateQuery<FailureQueueDto, ApiError>(
    principalId,
    ['admin', 'platform', 'jobs', 'failures'],
    async () => (await api.get<FailureQueueDto>('/admin/platform/jobs/failures')).data,
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

  const syncMutation = useMutation({
    mutationFn: async (account: AccountDto) => {
      const { data } = await api.post<{ jobId: string; deduplicated: boolean }>(
        `/admin/platform/accounts/${account.id}/sync`,
      );
      return { ...data, account };
    },
    onSuccess: (result) => {
      setActionError(null);
      setActionNotice(
        `${platformLabel(result.account.platform)} · ${result.account.displayHandle ?? result.account.externalId}：${
          result.deduplicated ? '30 秒内已有排队任务，已复用' : '同步任务已排队'
        }。`,
      );
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'platform'] });
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  const retryMutation = useMutation({
    mutationFn: async (job: JobDto) => {
      const { data } = await api.post<{ retried: boolean; reason?: string }>(
        `/admin/platform/jobs/${job.id}/retry`,
      );
      return { ...data, label: jobAccountLabel(job) };
    },
    onSuccess: (result) => {
      setActionError(null);
      const subject = result.label ? `（${result.label}）` : '';
      setActionNotice(
        result.retried ? `任务已重新排队${subject}。` : `${result.reason ?? '未能重试该任务'}${subject}。`,
      );
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'platform'] });
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  const retryAllMutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ retried: number; total: number }>(
        '/admin/platform/jobs/retry-failures',
      );
      return data;
    },
    onSuccess: (result) => {
      setActionError(null);
      setActionNotice(
        result.total === 0
          ? '当前没有可重试的失败任务。'
          : `已重新排队 ${result.retried} 个失败任务${result.total > result.retried ? `（${result.total - result.retried} 个因状态变化跳过）` : ''}；任务按 30 秒错峰执行。`,
      );
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'platform'] });
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  const cancelJobMutation = useMutation({
    mutationFn: async (job: JobDto) => {
      const { data } = await api.post<{ cancelled: boolean; reason?: string }>(
        `/admin/platform/jobs/${job.id}/cancel`,
      );
      return { ...data, label: jobAccountLabel(job) };
    },
    onSuccess: (result) => {
      setActionError(null);
      const subject = result.label ? `（${result.label}）` : '';
      setActionNotice(
        result.cancelled
          ? `已忽略该失败任务${subject}，不会再自动重试；错误记录保留在审计中。`
          : `${result.reason ?? '未能忽略该任务'}${subject}。`,
      );
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'platform'] });
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  const failures = failuresQuery.data?.items ?? [];
  const failureTotal = failuresQuery.data?.total ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="平台同步"
        description="绑定持有核验、失败任务队列与账号重新同步；失败可单个或批量重试，也可忽略。"
        actions={
          <Button
            variant="outline"
            onClick={() => {
              void jobsQuery.refetch();
              void failuresQuery.refetch();
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
          <div className="flex flex-wrap items-start justify-between gap-2 p-5 pb-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <TriangleAlertIcon className="size-4 text-destructive" aria-hidden="true" />
                同步失败任务
                {failureTotal > 0 && (
                  <span className="rounded-sm bg-destructive-subtle px-1.5 py-0.5 text-xs text-destructive tabular-nums">
                    {failureTotal}
                  </span>
                )}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                失败任务会一直保留在这里，不受“最近任务”条数限制；可单个重试或忽略，忽略后不再自动重试。
                {failureTotal > failures.length && ` 当前共 ${failureTotal} 条，仅展示最近 ${failures.length} 条。`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {failureTotal > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={retryAllMutation.isPending || failuresQuery.isFetching}
                  onClick={() => retryAllMutation.mutate()}
                >
                  {retryAllMutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
                  全部重试（{Math.min(failureTotal, 50)}）
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={failuresQuery.isFetching}
                onClick={() => void failuresQuery.refetch()}
              >
                <RefreshCwIcon aria-hidden="true" />
                刷新
              </Button>
            </div>
          </div>
          {failuresQuery.isPending ? (
            <div className="flex flex-col gap-2 px-5">
              {[0, 1].map((index) => (
                <Skeleton key={index} className="h-16" />
              ))}
            </div>
          ) : failuresQuery.isError ? (
            <div className="px-5 pb-5">
              <ErrorState
                description={failuresQuery.error.message}
                onRetry={() => void failuresQuery.refetch()}
                retrying={failuresQuery.isFetching}
              />
            </div>
          ) : failures.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted-foreground">当前没有失败任务。</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {failures.map((job) => {
                const hint = syncErrorHint(job.lastError);
                return (
                  <li key={job.id} className="flex flex-col gap-2 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge kind="sync" value="失败" />
                      <span className="text-sm font-medium text-foreground">
                        {jobAccountLabel(job) ?? '每日全量刷新'}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        尝试 {job.attempts} 次 · 最后失败 {formatDateTime(job.updatedAt)}
                      </span>
                    </div>
                    <p className="text-xs leading-5 break-words whitespace-pre-wrap text-destructive">
                      {job.lastError ?? '未记录错误信息'}
                    </p>
                    {hint && (
                      <p className="rounded-md bg-warning-subtle px-2.5 py-2 text-xs leading-5 text-warning-foreground">
                        处理建议：{hint}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={retryMutation.isPending}
                        onClick={() => retryMutation.mutate(job)}
                      >
                        {retryMutation.isPending && retryMutation.variables?.id === job.id && (
                          <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                        )}
                        重试
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        disabled={cancelJobMutation.isPending}
                        onClick={() => {
                          if (!window.confirm('忽略后该任务不会自动重试，错误记录仍保留在审计日志中。确认忽略？')) return;
                          cancelJobMutation.mutate(job);
                        }}
                      >
                        {cancelJobMutation.isPending && cancelJobMutation.variables?.id === job.id && (
                          <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                        )}
                        忽略
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

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
                  <p className={`text-xs leading-5 ${
                    account.lastSyncStatus === 'failed' ? 'text-destructive' : 'text-muted-foreground'
                  }`}>
                    {account.lastSyncAt
                      ? `上次同步 ${formatDateTime(account.lastSyncAt)}${
                          account.lastSyncStatus === 'failed'
                            ? '（失败）'
                            : account.lastSyncStatus === 'truncated'
                              ? '（截断）'
                              : ''
                        }`
                      : '尚未同步'}
                    {account.lastSyncError ? `：${account.lastSyncError}` : ''}
                  </p>
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
                    {account.status === 'verified' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={syncMutation.isPending}
                        onClick={() => syncMutation.mutate(account)}
                      >
                        {syncMutation.isPending && syncMutation.variables?.id === account.id && (
                          <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                        )}
                        重新同步
                      </Button>
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
          <div className="flex flex-wrap items-center justify-between gap-2 p-5 pb-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">最近同步任务</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                仅展示事实状态（排队/运行/成功/失败/已忽略）与最近错误；15 秒自动刷新。
              </p>
            </div>
            <Select value={jobStatus} onValueChange={setJobStatus}>
              <SelectTrigger className="w-36" aria-label="同步任务状态筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {JOB_STATUS_FILTERS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
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
                    <TableHead>账号</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">尝试</TableHead>
                    <TableHead>计划执行</TableHead>
                    <TableHead>最后更新</TableHead>
                    <TableHead>最近错误</TableHead>
                    <TableHead className="pr-5" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(jobsQuery.data ?? []).map((job) => (
                    <TableRow key={job.id} className="h-14">
                      <TableCell className="pl-5 text-xs">
                        <span className="text-foreground">{JOB_TYPE_LABELS[job.type] ?? job.type}</span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {job.account ? (
                          <span className="flex flex-col gap-0.5">
                            <span className="font-medium text-foreground">
                              {platformLabel(job.account.platform)} ·{' '}
                              {job.account.displayHandle ?? job.account.externalId}
                            </span>
                            <span className="text-muted-foreground">
                              {job.account.user?.verifiedRealName ?? '—'} ·{' '}
                              <span className="tabular-nums">{job.account.user?.studentNo ?? '—'}</span>
                            </span>
                          </span>
                        ) : job.accountId ? (
                          <span className="text-muted-foreground">账号已删除</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
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
                      <TableCell className="text-muted-foreground tabular-nums">
                        {formatDateTime(job.updatedAt)}
                      </TableCell>
                      <TableCell
                        className="max-w-64 truncate text-xs text-destructive"
                        title={job.lastError ?? undefined}
                      >
                        {job.lastError ?? '—'}
                      </TableCell>
                      <TableCell className="pr-5">
                        {(job.status === 'dead' || job.status === 'failed' || (job.status === 'queued' && job.attempts > 0)) && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={retryMutation.isPending}
                            onClick={() => retryMutation.mutate(job)}
                          >
                            {job.status === 'queued' ? '立即重试' : '重试'}
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
