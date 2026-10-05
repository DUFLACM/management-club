/**
 * 管理端 · 成员：GET /admin/members?q=&status=&cursor=（members.read）。
 * 表头 40px、行 56px 约 7 列；详情 Sheet GET /admin/members/:id；
 * 入社审批 POST membership-decision；直接调整身份 POST membership（members.manage）；
 * 平台绑定更改/解绑 POST platform-accounts/:accountId(/revoke)；月评预览 GET /admin/membership-evaluation。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarRangeIcon, LoaderCircleIcon, SearchIcon } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrivateInfiniteQuery } from '@/lib/private-infinite';
import { usePrincipal } from '@/lib/session';
import { useDebouncedValue, LoadMoreButton } from '@/lib/hooks';
import { currentMonthKey, formatDateTime, membershipLabel } from '@/lib/format';
import { PanelHeader } from '@/components/club/PanelHeader';
import { PrincipalGate } from '@/components/club/QueryBoundary';
import { EmptyState } from '@/components/club/EmptyState';
import { ErrorState } from '@/components/club/ErrorState';
import { ResponsiveDetail } from '@/components/club/ResponsiveDetail';
import { StatusBadge } from '@/components/club/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { Textarea } from '@/components/ui/textarea';

interface MemberRowDto {
  id: string;
  displayName: string;
  studentNo: string;
  grade: number | null;
  membership: string;
  e: string;
  restrictions: string[];
  createdAt: string;
}

interface MemberDetailDto {
  id: string;
  studentNo: string;
  verifiedRealName: string;
  grade: number | null;
  accountStatus: string;
  profile: { displayName: string | null; bio: string | null; visibility: string } | null;
  membershipTerms: Array<{
    id: string;
    membershipStatus: string;
    basis: string | null;
    effectiveFrom: string | null;
    createdAt: string;
  }>;
  restrictions: Array<{ id: string; type: string; reason: string | null; endsAt: string | null; revokedAt: string | null }>;
  platformAccounts: Array<{
    id: string;
    platform: string;
    externalId: string;
    displayHandle: string | null;
    status: string;
  }>;
  registrations: Array<{
    id: string;
    status: string;
    createdAt: string;
    activity: { title: string; startAt: string } | null;
  }>;
}

interface EvaluationDto {
  month: string;
  formalCount: number;
  quota: number;
  loseQuotaCandidates: Array<{
    userId: string;
    kind: string;
    inOfficeMonths: number;
    graceMonths: number;
    demoteNextMonth: boolean;
  }>;
  observingCandidates: Array<{ userId: string; monthM: number; meetsM12: boolean; note: string }>;
  note: string;
}

const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'formal', label: '正式成员' },
  { value: 'provisional', label: '预备成员' },
  { value: 'observing', label: '考察成员' },
  { value: 'applicant', label: '申请中' },
  { value: 'withdrawn', label: '已退出' },
];

/** 直接调整身份的可选目标（含低频终态） */
const ADJUST_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  ...STATUS_OPTIONS.slice(0, 4),
  { value: 'honorary_retired', label: '荣誉退役' },
  { value: 'withdrawn', label: '已退出' },
  { value: 'dismissed', label: '已除名' },
  { value: 'vetoed', label: '一票否决' },
];

function MembershipBadge({ status }: { status: string }) {
  return <Badge variant="neutral">{membershipLabel(status)}</Badge>;
}

export default function MembersPanel() {
  const principal = usePrincipal();
  return (
    <PrincipalGate principal={principal}>
      {(principalId) => <MembersBody principalId={principalId} />}
    </PrincipalGate>
  );
}

function MembersBody({ principalId }: { principalId: string }) {
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 450);
  const [status, setStatus] = useState('all');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [evaluationOpen, setEvaluationOpen] = useState(false);

  const listQuery = usePrivateInfiniteQuery<
    { items: MemberRowDto[]; nextCursor?: string | null },
    ApiError
  >(
    principalId,
    ['admin', 'members', 'list', status, debouncedSearch],
    async (cursor) => {
      const params = new URLSearchParams();
      if (status !== 'all') params.set('status', status);
      if (debouncedSearch) params.set('q', debouncedSearch);
      if (cursor) params.set('cursor', cursor);
      const { data } = await api.get<{ items: MemberRowDto[]; nextCursor?: string | null }>(
        `/admin/members?${params.toString()}`,
      );
      return data;
    },
  );

  const items = listQuery.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="成员"
        description="社员名册、身份与入社审批。"
        actions={
          <Button variant="outline" onClick={() => setEvaluationOpen(true)}>
            <CalendarRangeIcon aria-hidden="true" />
            月评预览
          </Button>
        }
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:w-64">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="搜索校园编号 / 姓名 / 展示名"
            className="pl-9"
            aria-label="搜索成员"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="sm:w-44" aria-label="身份筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部身份</SelectItem>
            {STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {listQuery.isPending ? (
        <Card>
          <CardContent className="flex flex-col gap-2 p-5">
            {[0, 1, 2, 3, 4].map((index) => (
              <Skeleton key={index} className="h-10" />
            ))}
          </CardContent>
        </Card>
      ) : listQuery.isError ? (
        <Card>
          <CardContent className="py-10">
            {listQuery.error.status === 403 || listQuery.error.code === 'FORBIDDEN' ? (
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
            <EmptyState
              kind="empty"
              description={debouncedSearch ? '没有匹配的成员。' : '暂无成员记录。'}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 pb-2">
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow className="h-10">
                    <TableHead className="pl-5">校园编号</TableHead>
                    <TableHead>姓名</TableHead>
                    <TableHead>年级</TableHead>
                    <TableHead>身份</TableHead>
                    <TableHead className="text-right">E</TableHead>
                    <TableHead>限制</TableHead>
                    <TableHead className="pr-5">入社时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((member) => (
                    <TableRow
                      key={member.id}
                      className="h-14 cursor-pointer"
                      onClick={() => setDetailId(member.id)}
                    >
                      <TableCell className="pl-5 tabular-nums">{member.studentNo}</TableCell>
                      <TableCell className="font-medium">{member.displayName}</TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {member.grade ?? '—'}
                      </TableCell>
                      <TableCell>
                        <MembershipBadge status={member.membership} />
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {member.e}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {member.restrictions.length > 0 ? member.restrictions.join(' / ') : '—'}
                      </TableCell>
                      <TableCell className="pr-5 text-muted-foreground tabular-nums">
                        {formatDateTime(member.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <ul className="flex flex-col divide-y divide-border md:hidden">
              {items.map((member) => (
                <li key={member.id}>
                  <button
                    type="button"
                    onClick={() => setDetailId(member.id)}
                    className="flex w-full flex-col gap-1 p-4 text-left"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {member.displayName}
                      </span>
                      <MembershipBadge status={member.membership} />
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {member.studentNo} · 年级 {member.grade ?? '—'} · E {member.e}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="px-5">
              <LoadMoreButton
                onClick={() => {
                  void listQuery.fetchNextPage();
                }}
                loading={listQuery.isFetchingNextPage}
                hasNext={Boolean(listQuery.data?.pages.at(-1)?.nextCursor)}
                hint="已展示全部成员"
              />
            </div>
          </CardContent>
        </Card>
      )}

      {detailId && (
        <MemberDetail
          principalId={principalId}
          memberId={detailId}
          onClose={() => setDetailId(null)}
        />
      )}
      <EvaluationDialog open={evaluationOpen} onOpenChange={setEvaluationOpen} />
    </div>
  );
}

function MemberDetail({
  principalId,
  memberId,
  onClose,
}: {
  principalId: string;
  memberId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [adjustStatus, setAdjustStatus] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [editingAccount, setEditingAccount] = useState<{
    id: string;
    externalId: string;
    displayHandle: string;
  } | null>(null);
  const [armedRevokeId, setArmedRevokeId] = useState<string | null>(null);

  const query = usePrivateQuery<MemberDetailDto, ApiError>(
    principalId,
    ['admin', 'members', 'detail', memberId],
    async () => (await api.get<MemberDetailDto>(`/admin/members/${memberId}`)).data,
  );

  const decisionMutation = useMutation({
    mutationFn: async (decision: 'admit' | 'reject') => {
      await api.post(`/admin/members/${memberId}/membership-decision`, {
        decision,
        reason: reason.trim(),
      });
      return decision;
    },
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin'] });
    },
    onError: (error: ApiError) => setActionError(error.message),
  });

  const membershipMutation = useMutation({
    mutationFn: async (input: { status: string; reason: string }) => {
      await api.post(`/admin/members/${memberId}/membership`, input);
    },
    onSuccess: () => {
      setActionError(null);
      setAdjustReason('');
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin'] });
    },
    onError: (error: ApiError) => setActionError(error.message),
  });

  const platformUpdateMutation = useMutation({
    mutationFn: async (input: { id: string; externalId: string; displayHandle: string }) => {
      await api.post(`/admin/members/${memberId}/platform-accounts/${input.id}`, {
        externalId: input.externalId.trim(),
        displayHandle: input.displayHandle.trim() || undefined,
      });
    },
    onSuccess: () => {
      setActionError(null);
      setEditingAccount(null);
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin'] });
    },
    onError: (error: ApiError) => setActionError(error.message),
  });

  const platformRevokeMutation = useMutation({
    mutationFn: async (accountId: string) => {
      await api.post(`/admin/members/${memberId}/platform-accounts/${accountId}/revoke`);
    },
    onSuccess: () => {
      setActionError(null);
      setArmedRevokeId(null);
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin'] });
    },
    onError: (error: ApiError) => setActionError(error.message),
  });

  const term = query.data?.membershipTerms[0];
  const isApplicant = term?.membershipStatus === 'applicant';
  const currentMembership = term?.membershipStatus ?? 'applicant';

  return (
    <ResponsiveDetail
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={query.data ? `${query.data.verifiedRealName}（${query.data.studentNo}）` : '成员详情'}
      description={query.data?.profile?.displayName ?? undefined}
    >
      {query.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
      ) : query.isError ? (
        <ErrorState description={query.error.message} onRetry={() => void query.refetch()} />
      ) : (
        <div className="flex flex-col gap-5">
          {actionError && (
            <Alert variant="destructive">
              <AlertTitle>操作未完成</AlertTitle>
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-foreground">基本资料</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">校园编号 / 年级</dt>
              <dd className="tabular-nums">
                {query.data.studentNo} / {query.data.grade ?? '—'}
              </dd>
              <dt className="text-muted-foreground">账户状态</dt>
              <dd>{query.data.accountStatus}</dd>
              <dt className="text-muted-foreground">主页可见性</dt>
              <dd>{query.data.profile?.visibility ?? '—'}</dd>
              {query.data.profile?.bio && (
                <>
                  <dt className="text-muted-foreground">简介</dt>
                  <dd>{query.data.profile.bio}</dd>
                </>
              )}
            </dl>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-foreground">身份记录</h3>
            <ul className="flex flex-col divide-y divide-border">
              {query.data.membershipTerms.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <MembershipBadge status={item.membershipStatus} />
                    <span className="text-muted-foreground tabular-nums">
                      {formatDateTime(item.createdAt)}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
                    {item.basis ?? ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="flex flex-col gap-2 rounded-xl border border-border p-3">
            <h3 className="text-sm font-semibold text-foreground">身份调整</h3>
            <p className="text-xs text-muted-foreground">
              直接设置该成员的身份（记入身份流转与审计，不能操作本人）。申请中的成员建议优先使用入社审批。
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="adjust-status">目标身份</Label>
              <Select value={adjustStatus || currentMembership} onValueChange={setAdjustStatus}>
                <SelectTrigger id="adjust-status" aria-label="目标身份">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ADJUST_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="adjust-reason">调整原因（3-500 字，必填）</Label>
              <Textarea
                id="adjust-reason"
                value={adjustReason}
                onChange={(event) => setAdjustReason(event.target.value)}
                rows={2}
                maxLength={500}
              />
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={membershipMutation.isPending || adjustReason.trim().length < 3}
                onClick={() =>
                  membershipMutation.mutate({ status: adjustStatus || currentMembership, reason: adjustReason.trim() })
                }
              >
                {membershipMutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
                保存身份
              </Button>
            </div>
          </section>

          {(query.data.restrictions?.length ?? 0) > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-foreground">在效限制</h3>
              <ul className="flex flex-col gap-1 text-sm">
                {query.data.restrictions
                  .filter((item) => item.revokedAt == null)
                  .map((item) => (
                    <li key={item.id} className="text-foreground">
                      {item.type}
                      {item.endsAt ? `（至 ${formatDateTime(item.endsAt)}）` : '（长期）'}
                      {item.reason ? `：${item.reason}` : ''}
                    </li>
                  ))}
              </ul>
            </section>
          )}

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-foreground">平台绑定</h3>
            {query.data.platformAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">未绑定平台账号。</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {query.data.platformAccounts.map((account) => {
                  const editing = editingAccount?.id === account.id;
                  const armed = armedRevokeId === account.id;
                  return (
                    <li key={account.id} className="flex flex-col gap-2 rounded-lg border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-sm">
                          {account.platform} · {account.displayHandle ?? account.externalId}
                          {account.displayHandle && account.displayHandle !== account.externalId ? (
                            <span className="text-muted-foreground">（{account.externalId}）</span>
                          ) : null}
                        </span>
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
                      </div>
                      {account.status !== 'revoked' && !editing && (
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setArmedRevokeId(null);
                              setEditingAccount({
                                id: account.id,
                                externalId: account.externalId,
                                displayHandle: account.displayHandle ?? '',
                              });
                            }}
                          >
                            更改账号
                          </Button>
                          <Button
                            size="sm"
                            variant={armed ? 'destructive' : 'outline'}
                            disabled={platformRevokeMutation.isPending}
                            onClick={() => {
                              if (armed) platformRevokeMutation.mutate(account.id);
                              else setArmedRevokeId(account.id);
                            }}
                          >
                            {platformRevokeMutation.isPending && platformRevokeMutation.variables === account.id && (
                              <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                            )}
                            {armed ? '确认解绑' : '解绑'}
                          </Button>
                        </div>
                      )}
                      {editing && editingAccount && (
                        <div className="flex flex-col gap-2">
                          <div className="grid gap-2 sm:grid-cols-2">
                            <div className="flex flex-col gap-1.5">
                              <Label htmlFor={`edit-external-${account.id}`}>平台账号（UID / handle）</Label>
                              <Input
                                id={`edit-external-${account.id}`}
                                value={editingAccount.externalId}
                                onChange={(event) =>
                                  setEditingAccount({ ...editingAccount, externalId: event.target.value })
                                }
                                maxLength={64}
                              />
                            </div>
                            <div className="flex flex-col gap-1.5">
                              <Label htmlFor={`edit-handle-${account.id}`}>显示名（可选）</Label>
                              <Input
                                id={`edit-handle-${account.id}`}
                                value={editingAccount.displayHandle}
                                onChange={(event) =>
                                  setEditingAccount({ ...editingAccount, displayHandle: event.target.value })
                                }
                                maxLength={64}
                              />
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            更换绑定账号后将回到「待持有核验」，需重新审核；解绑为软删除，保留历史成绩。
                          </p>
                          <div className="flex justify-end gap-2">
                            <Button size="sm" variant="outline" onClick={() => setEditingAccount(null)}>
                              取消
                            </Button>
                            <Button
                              size="sm"
                              disabled={
                                platformUpdateMutation.isPending || editingAccount.externalId.trim().length < 2
                              }
                              onClick={() => platformUpdateMutation.mutate(editingAccount)}
                            >
                              {platformUpdateMutation.isPending && (
                                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                              )}
                              保存绑定
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-foreground">近期报名</h3>
            {query.data.registrations.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无报名记录。</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {query.data.registrations.map((registration) => (
                  <li key={registration.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0 truncate">
                      {registration.activity?.title ?? '（活动已删除）'}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <StatusBadge
                        kind="registration"
                        value={
                          registration.status === 'enrolled'
                            ? '已报名'
                            : registration.status === 'waitlisted'
                              ? '候补中'
                              : registration.status === 'pending_approval'
                                ? '待审核'
                                : '已取消'
                        }
                      />
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatDateTime(registration.createdAt)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {isApplicant && (
            <section className="flex flex-col gap-2 rounded-xl border border-border p-3">
              <h3 className="text-sm font-semibold text-foreground">入社审批</h3>
              <p className="text-xs text-muted-foreground">
                批准后进入一个月观察期（observing）；驳回请写明原因。不能审批本人。
              </p>
              <Label htmlFor="decision-reason">审批原因（3-500 字，必填）</Label>
              <Textarea
                id="decision-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                maxLength={500}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={decisionMutation.isPending || reason.trim().length < 3}
                  onClick={() => decisionMutation.mutate('admit')}
                >
                  {decisionMutation.isPending && decisionMutation.variables === 'admit' && (
                    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  )}
                  批准入社
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={decisionMutation.isPending || reason.trim().length < 3}
                  onClick={() => decisionMutation.mutate('reject')}
                >
                  {decisionMutation.isPending && decisionMutation.variables === 'reject' && (
                    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  )}
                  驳回
                </Button>
              </div>
            </section>
          )}
        </div>
      )}
    </ResponsiveDetail>
  );
}

function EvaluationDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const principal = usePrincipal();
  const principalId = principal?.principalId ?? null;
  const [month, setMonth] = useState(currentMonthKey());

  const query = usePrivateQuery<EvaluationDto, ApiError>(
    principalId,
    ['admin', 'membership-evaluation', month],
    async () => (await api.get<EvaluationDto>(`/admin/membership-evaluation?month=${month}`)).data,
    { enabled: open && principalId != null },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>月度身份评定预览（只读）</DialogTitle>
          <DialogDescription>
            候选名单仅供评定会议；系统不自动更改身份。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="evaluation-month">月份</Label>
          <Input
            id="evaluation-month"
            type="month"
            value={month}
            onChange={(event) => setMonth(event.target.value || currentMonthKey())}
          />
        </div>
        {query.isPending ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : query.isError ? (
          <EmptyState
            kind={query.error.status === 403 ? 'forbidden' : 'error'}
            description={query.error.message}
          />
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-muted-foreground">
              正式 {query.data.formalCount} 人 · 名额上限 {query.data.quota}
            </p>
            <section>
              <h4 className="font-semibold text-foreground">名额候选（超编）</h4>
              {query.data.loseQuotaCandidates.length === 0 ? (
                <p className="text-muted-foreground">无候选。</p>
              ) : (
                <ul className="mt-1 flex flex-col gap-1">
                  {query.data.loseQuotaCandidates.map((item) => (
                    <li key={item.userId} className="text-muted-foreground">
                      {item.userId.slice(0, 8)} · 在位 {item.inOfficeMonths} 月 · 宽限{' '}
                      {item.graceMonths} 月
                      {item.demoteNextMonth ? ' · 下月降级' : ''}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h4 className="font-semibold text-foreground">考察转正候选</h4>
              {query.data.observingCandidates.length === 0 ? (
                <p className="text-muted-foreground">无候选。</p>
              ) : (
                <ul className="mt-1 flex flex-col gap-1">
                  {query.data.observingCandidates.map((item) => (
                    <li key={item.userId} className="text-muted-foreground">
                      {item.userId.slice(0, 8)} · 当月 M {item.monthM} ·{' '}
                      {item.meetsM12 ? '满足 M≥12' : '未达 M≥12'}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <p className="text-xs leading-5 text-muted-foreground">{query.data.note}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
