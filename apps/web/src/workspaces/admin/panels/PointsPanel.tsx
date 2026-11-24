/**
 * 管理端 · 积分审核（points.review / points.propose / claims.review）。
 * - 审核队列 GET /admin/reviews（待审申报 / 已处理 / 申诉 / 复核案件，宽屏左右分栏队列+详情）；
 * - claims 决定 POST /admin/claims/:id/decision；撤回 POST /admin/claims/:id/withdraw（已入账会同时冲正）；
 * - 复核投票 POST /admin/reviews/:id/votes；
 * - 入账 POST /admin/ledger-entries（sourceKey 幂等）；冲正 POST /admin/ledger-entries/:id/reverse；
 * - 月度批次 POST /admin/scoring-batches（blocked=R01 提示）；
 * - 公示 POST /admin/disclosures（48h 校验错误显示）+ GET /admin/disclosures 列表。
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BookOpenIcon,
  ClipboardListIcon,
  CoinsIcon,
  HistoryIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  SearchIcon,
  TrophyIcon,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrivateInfiniteQuery } from '@/lib/private-infinite';
import { usePrincipal } from '@/lib/session';
import { LoadMoreButton } from '@/lib/hooks';
import {
  currentMonthKey,
  formatDateTime,
  formatSignedAmount,
  ledgerStatusBadge,
} from '@/lib/format';
import { PanelHeader } from '@/components/club/PanelHeader';
import { PrincipalGate, QueryBoundary } from '@/components/club/QueryBoundary';
import { EmptyState } from '@/components/club/EmptyState';
import { StatusBadge } from '@/components/club/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { HistoryImportDialog } from './HistoryImportDialog';
import { CompetitionImportDialog } from './CompetitionImportDialog';

interface ReviewCaseDto {
  id: string;
  type: string;
  status: string;
  targetUserId: string | null;
  subject: string | null;
  note: string | null;
  teacherRequired: boolean;
  createdAt: string;
  votes: Array<{ id: string; verdict: string; reason: string }>;
}

interface ClaimDto {
  id: string;
  category: string;
  title: string;
  description: string;
  status: string;
  scoreMonth: string;
  createdAt: string;
  evidenceNote: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  assets: Array<{ assetId: string }>;
  user: { verifiedRealName: string | null; studentNo: string | null } | null;
}

interface ProcessedClaimDto extends ClaimDto {
  ledgerEntry: {
    id: string;
    amount: string | number;
    scoreMonth: string;
    recordedAt: string;
  } | null;
}

interface ReviewQueueDto {
  cases: ReviewCaseDto[];
  claims: ClaimDto[];
  appeals: AppealDto[];
  processedAppeals?: AppealDto[];
  processedClaims: ProcessedClaimDto[];
}

/** 佐证图读取入口：thumb 供列表缩略，full 为原图（已剥除 EXIF/GPS） */
function evidenceUrl(assetId: string, size: 'thumb' | 'full'): string {
  return `/api/v1/me/claim-evidence/${assetId}?size=${size}`;
}

interface AppealLedgerSummaryDto {
  id: string;
  sourceKey: string;
  category: string;
  amount: string;
  scoreMonth: string;
  recordedAt: string;
  status: string;
  reversesEntryId: string | null;
  replacedByEntryId: string | null;
  replacementAmount: string | null;
  reversalReason: string | null;
  eventName: string;
  eventTime: string | null;
  eventKind: string;
}

interface AppealDto {
  id: string;
  userId?: string;
  ledgerEntryId?: string | null;
  ledgerEntry?: AppealLedgerSummaryDto | null;
  subject: string;
  materials: string | null;
  status: string;
  resolutionNote?: string | null;
  closedAt?: string | null;
  createdAt: string;
  user: { id?: string; verifiedRealName: string | null; studentNo: string | null } | null;
}

interface AdminLedgerEntryDto {
  id: string;
  userId: string;
  user: { id: string; verifiedRealName: string | null; studentNo: string | null } | null;
  sourceKey: string;
  category: string;
  amount: string;
  scoreMonth: string;
  recordedAt: string;
  status: string;
  reversesEntryId: string | null;
  replacedByEntryId: string | null;
  reversalReason: string | null;
  batchId: string | null;
  note: string | null;
  eventName: string;
  eventKind: string;
}

const LEDGER_CATEGORY_LABELS: Record<string, string> = {
  contest: '比赛',
  remote_contest: '远程比赛',
  activity: '活动',
  contribution: '贡献',
  service: '服务',
  award: '奖项',
  initial: '入社基础分',
  penalty: '扣分',
  reversal: '冲正',
};

interface DisclosureRowDto {
  id: string;
  monthKey: string;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  publishedAt: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  contribution_lecture: '讲题',
  solution: '题解',
  problem_setting: '出题',
  sharing: '分享',
  service: '服务',
  award: '奖项',
};

const CLAIM_STATUS_LABELS: Record<string, string> = {
  pending: '待审核',
  more_info: '待补充',
  approved: '已通过',
  rejected: '已驳回',
};

function ClaimStatusTag({ status }: { status: string }) {
  const tone =
    status === 'approved'
      ? 'bg-success-subtle text-success-foreground'
      : status === 'rejected'
        ? 'bg-destructive-subtle text-destructive'
        : status === 'more_info'
          ? 'bg-warning-subtle text-warning-foreground'
          : 'bg-info-subtle text-info-foreground';
  return (
    <span className={`rounded-sm px-1.5 py-0.5 text-xs font-medium ${tone}`}>
      {CLAIM_STATUS_LABELS[status] ?? status}
    </span>
  );
}

export default function PointsPanel() {
  const principal = usePrincipal();
  return (
    <PrincipalGate principal={principal}>
      {(principalId) => <PointsBody principalId={principalId} />}
    </PrincipalGate>
  );
}

const POINTS_TABS = ['claims', 'processed', 'manual', 'appeals', 'cases'] as const;
type PointsTabKey = (typeof POINTS_TABS)[number];

function PointsBody({ principalId }: { principalId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const initialTab: PointsTabKey =
    rawTab && (POINTS_TABS as readonly string[]).includes(rawTab)
      ? (rawTab as PointsTabKey)
      : 'claims';
  const [tab, setTabState] = useState<PointsTabKey>(initialTab);
  const [entryOpen, setEntryOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchImportOpen, setBatchImportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [competitionImportOpen, setCompetitionImportOpen] = useState(false);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const queryClient = useQueryClient();
  const [queueNotice, setQueueNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (rawTab && (POINTS_TABS as readonly string[]).includes(rawTab) && rawTab !== tab) {
      setTabState(rawTab as PointsTabKey);
    }
  }, [rawTab, tab]);

  const setTab = useCallback(
    (next: string) => {
      if (!(POINTS_TABS as readonly string[]).includes(next)) return;
      const valid = next as PointsTabKey;
      setTabState(valid);
      setSearchParams(
        (prev) => {
          const updated = new URLSearchParams(prev);
          if (valid === 'claims') updated.delete('tab');
          else updated.set('tab', valid);
          return updated;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const queueQuery = usePrivateQuery<
    ReviewQueueDto,
    ApiError
  >(principalId, ['admin', 'reviews', 'queue'], async () => {
    const { data } = await api.get<ReviewQueueDto>('/admin/reviews');
    return data;
  });

  const disclosuresQuery = usePrivateQuery<DisclosureRowDto[], ApiError>(
    principalId,
    ['admin', 'disclosures'],
    async () => (await api.get<DisclosureRowDto[]>('/admin/disclosures')).data,
  );

  const [disclosureActionError, setDisclosureActionError] = useState<string | null>(null);
  const [confirmDeleteDisclosure, setConfirmDeleteDisclosure] = useState<string | null>(null);
  const closeDisclosureMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/admin/disclosures/${id}/close`);
      return true;
    },
    onSuccess: () => {
      setDisclosureActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'disclosures'] });
    },
    onError: (cause: ApiError) => setDisclosureActionError(cause.message),
  });
  const deleteDisclosureMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/admin/disclosures/${id}`);
      return true;
    },
    onSuccess: () => {
      setDisclosureActionError(null);
      setConfirmDeleteDisclosure(null);
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'disclosures'] });
    },
    onError: (cause: ApiError) => {
      setDisclosureActionError(cause.message);
      setConfirmDeleteDisclosure(null);
    },
  });

  const invalidateQueue = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'reviews'] });
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'disclosures'] });
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'ledger-entries'] });
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'dashboard'] });
  }, [principalId, queryClient]);

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="积分审核"
        description="贡献申报、申诉与复核案件；通过的申报可在「已处理」撤回，入账/冲正与月度公示。"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setEntryOpen(true)}>
              <CoinsIcon aria-hidden="true" />
              入账
            </Button>
            <Button variant="outline" onClick={() => setBatchImportOpen(true)}>
              <ClipboardListIcon aria-hidden="true" />
              批量加分
            </Button>
            <Button variant="outline" onClick={() => setCompetitionImportOpen(true)}>
              <TrophyIcon aria-hidden="true" />
              正式赛名单导入
            </Button>
            <Button variant="outline" onClick={() => setHistoryOpen(true)}>
              <HistoryIcon aria-hidden="true" />
              历史积分导入
            </Button>
            <Button variant="outline" onClick={() => setBatchOpen(true)}>
              <BookOpenIcon aria-hidden="true" />
              月度批次
            </Button>
            <Button onClick={() => setDisclosureOpen(true)}>发布公示</Button>
          </div>
        }
      />

      {queueNotice && (
        <Alert variant={queueNotice.tone === 'error' ? 'destructive' : 'info'}>
          <AlertTitle>{queueNotice.tone === 'error' ? '操作未完成' : '已处理'}</AlertTitle>
          <AlertDescription>{queueNotice.text}</AlertDescription>
        </Alert>
      )}

      <QueryBoundary query={queueQuery}>
        {(queue) => (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList aria-label="审核队列" className="flex-wrap">
              <TabsTrigger value="claims">贡献申报（{queue.claims.length}）</TabsTrigger>
              <TabsTrigger value="processed">已处理申报（{queue.processedClaims.length}）</TabsTrigger>
              <TabsTrigger value="manual">批量 / 手动加分记录</TabsTrigger>
              <TabsTrigger value="appeals">申诉（{queue.appeals.length}）</TabsTrigger>
              <TabsTrigger value="cases">复核案件（{queue.cases.length}）</TabsTrigger>
            </TabsList>
            <TabsContent value="claims" className="mt-4">
              <ClaimsQueue
                claims={queue.claims}
                onNotice={setQueueNotice}
                onHandled={invalidateQueue}
              />
            </TabsContent>
            <TabsContent value="processed" className="mt-4">
              <ProcessedClaimsQueue
                claims={queue.processedClaims}
                onNotice={setQueueNotice}
                onHandled={invalidateQueue}
              />
            </TabsContent>
            <TabsContent value="manual" className="mt-4">
              <ManualLedgerRecordsTab
                principalId={principalId}
                onNotice={setQueueNotice}
                onHandled={invalidateQueue}
                onOpenBatch={() => setBatchImportOpen(true)}
                onOpenSingle={() => setEntryOpen(true)}
              />
            </TabsContent>
            <TabsContent value="appeals" className="mt-4">
              <AppealsQueue
                appeals={queue.appeals}
                processedAppeals={queue.processedAppeals ?? []}
                onNotice={setQueueNotice}
                onHandled={invalidateQueue}
              />
            </TabsContent>
            <TabsContent value="cases" className="mt-4">
              <CasesQueue cases={queue.cases} onNotice={setQueueNotice} onHandled={invalidateQueue} />
            </TabsContent>
          </Tabs>
        )}
      </QueryBoundary>

      <Card>
        <CardContent className="flex flex-col gap-3 p-5">
          <h2 className="text-sm font-semibold text-foreground">公示记录</h2>
          <QueryBoundary
            query={disclosuresQuery}
            isEmpty={(rows) => rows.length === 0}
            emptyNode={<p className="text-sm text-muted-foreground">暂无公示记录。</p>}
            skeleton={<div className="h-16 animate-pulse rounded-lg bg-muted" />}
          >
            {(rows) => (
              <>
                {disclosureActionError && (
                  <Alert variant="destructive" className="mb-2">
                    <AlertDescription>{disclosureActionError}</AlertDescription>
                  </Alert>
                )}
                <ul className="flex flex-col divide-y divide-border">
                  {rows.map((row) => (
                    <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                      <span className="tabular-nums">{row.monthKey} 月度公示</span>
                      <span className="flex flex-wrap items-center gap-2">
                        <StatusBadge kind="disclosure" value={row.status === 'published' ? '公示中' : '已结束'} />
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {row.startsAt ? formatDateTime(row.startsAt) : ''} ~{' '}
                          {row.endsAt ? formatDateTime(row.endsAt) : ''}
                        </span>
                        {row.status === 'published' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={closeDisclosureMutation.isPending}
                            onClick={() => closeDisclosureMutation.mutate(row.id)}
                          >
                            提前结束
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant={confirmDeleteDisclosure === row.id ? 'destructive' : 'ghost'}
                          className={confirmDeleteDisclosure === row.id ? undefined : 'text-destructive hover:text-destructive'}
                          disabled={deleteDisclosureMutation.isPending}
                          onClick={() => {
                            if (confirmDeleteDisclosure === row.id) deleteDisclosureMutation.mutate(row.id);
                            else setConfirmDeleteDisclosure(row.id);
                          }}
                        >
                          {confirmDeleteDisclosure === row.id ? '确认删除' : '删除'}
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </QueryBoundary>
        </CardContent>
      </Card>

      <LedgerEntryDialog open={entryOpen} onOpenChange={setEntryOpen} />
      <BatchLedgerDialog open={batchImportOpen} onOpenChange={setBatchImportOpen} />
      <HistoryImportDialog open={historyOpen} onOpenChange={setHistoryOpen} />
      <CompetitionImportDialog open={competitionImportOpen} onOpenChange={setCompetitionImportOpen} />
      <MonthlyBatchDialog open={batchOpen} onOpenChange={setBatchOpen} />
      <DisclosureDialog open={disclosureOpen} onOpenChange={setDisclosureOpen} />
    </div>
  );
}

function ClaimsQueue({
  claims,
  onNotice,
  onHandled,
}: {
  claims: ClaimDto[];
  onNotice: (notice: { tone: 'info' | 'error'; text: string } | null) => void;
  onHandled: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [amount, setAmount] = useState('');
  const mutation = useMutation({
    mutationFn: async ({ claimId, decision }: { claimId: string; decision: 'approve' | 'reject' | 'more_info' }) => {
      const { data } = await api.post<{ decided: boolean; reason?: string }>(
        `/admin/claims/${claimId}/decision`,
        {
          decision,
          note: note.trim() || undefined,
          ...(decision === 'approve' && amount ? { amount } : {}),
        },
      );
      return data;
    },
    onSuccess: (result) => {
      if (!result.decided) {
        onNotice({ tone: 'error', text: result.reason ?? '未能处理该申报。' });
        return;
      }
      onNotice({ tone: 'info', text: '申报已处理；通过且填写分值时已同时入账。需要撤销时到「已处理」里撤回。' });
      onHandled();
      setSelectedId(null);
      setNote('');
      setAmount('');
    },
    onError: (error: ApiError) => onNotice({ tone: 'error', text: error.message }),
  });

  if (claims.length === 0) {
    return <EmptyState kind="empty" description="没有待审核的贡献申报。" />;
  }
  const selected = claims.find((claim) => claim.id === selectedId) ?? claims[0] ?? null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardContent className="p-0">
          <ul className="flex flex-col divide-y divide-border">
            {claims.map((claim) => (
              <li key={claim.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(claim.id)}
                  aria-pressed={claim.id === selected?.id}
                  className={`flex w-full flex-col gap-1 p-4 text-left hover:bg-muted/40 ${
                    claim.id === selected?.id ? 'bg-info-subtle' : ''
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{claim.title}</span>
                    <BadgeOfCategory category={claim.category} />
                    {claim.status === 'more_info' && <ClaimStatusTag status={claim.status} />}
                    {claim.assets.length > 0 && (
                      <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-foreground/80 tabular-nums">
                        {claim.assets.length} 图
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {claim.user?.verifiedRealName ?? '—'} · {claim.user?.studentNo ?? '—'} ·{' '}
                    {formatDateTime(claim.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {selected && (
        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            <h3 className="text-sm font-semibold text-foreground">{selected.title}</h3>
            <p className="text-sm leading-[22px] whitespace-pre-wrap text-foreground/90">
              {selected.description}
            </p>
            <p className="text-xs text-muted-foreground">
              {CATEGORY_LABELS[selected.category] ?? selected.category} · 记分月份{' '}
              <span className="tabular-nums">{selected.scoreMonth}</span>
            </p>
            {selected.status === 'more_info' && selected.reviewNote && (
              <p className="rounded-md bg-warning-subtle px-2.5 py-2 text-xs leading-5 text-warning-foreground">
                上次审核要求补充：{selected.reviewNote}
              </p>
            )}
            {selected.evidenceNote && (
              <p className="text-sm leading-[22px] break-words text-foreground/90">
                <span className="text-muted-foreground">佐证说明：</span>
                {selected.evidenceNote}
              </p>
            )}
            {selected.assets.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-muted-foreground">
                  佐证图片（{selected.assets.length} 张，点击查看原图）
                </p>
                <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {selected.assets.map((asset, index) => (
                    <li key={asset.assetId}>
                      <a
                        href={evidenceUrl(asset.assetId, 'full')}
                        target="_blank"
                        rel="noreferrer"
                        className="block aspect-square overflow-hidden rounded-xl border border-border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <img
                          src={evidenceUrl(asset.assetId, 'thumb')}
                          alt={`佐证图 ${index + 1}`}
                          loading="lazy"
                          className="size-full object-cover"
                        />
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="claim-note">审核备注（可选）</Label>
              <Textarea
                id="claim-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
                maxLength={500}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="claim-amount">通过时的入账分值（十进制，如 3 或 2.5）</Label>
              <Input
                id="claim-amount"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="不填则只改状态，不入账"
                inputMode="decimal"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={mutation.isPending || (Boolean(amount) && !/^-?\d+(\.\d+)?$/.test(amount))}
                onClick={() => mutation.mutate({ claimId: selected.id, decision: 'approve' })}
              >
                {mutation.isPending && mutation.variables?.decision === 'approve' && (
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                )}
                通过{amount ? '并入账' : ''}
              </Button>
              <Button size="sm" variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate({ claimId: selected.id, decision: 'reject' })}>
                驳回
              </Button>
              <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => mutation.mutate({ claimId: selected.id, decision: 'more_info' })}>
                要求补充材料
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              通过并填分值时以
              contribution:&lt;userId&gt;:&lt;claimId&gt; 作为 sourceKey 幂等入账。
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function BadgeOfCategory({ category }: { category: string }) {
  return (
    <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-foreground/80">
      {CATEGORY_LABELS[category] ?? category}
    </span>
  );
}

function ProcessedClaimsQueue({
  claims,
  onNotice,
  onHandled,
}: {
  claims: ProcessedClaimDto[];
  onNotice: (notice: { tone: 'info' | 'error'; text: string } | null) => void;
  onHandled: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async (claimId: string) => {
      const { data } = await api.post<{ withdrawn: boolean; reversedEntryId: string | null }>(
        `/admin/claims/${claimId}/withdraw`,
        { reason: reason.trim() },
      );
      return data;
    },
    onSuccess: (result) => {
      onNotice({
        tone: 'info',
        text: result.reversedEntryId
          ? '已撤回审核，原入账分值已自动冲正；申报回到待审核。'
          : '已撤回审核；申报回到待审核。',
      });
      setConfirmId(null);
      setReason('');
      setSelectedId(null);
      onHandled();
    },
    onError: (error: ApiError) => onNotice({ tone: 'error', text: error.message }),
  });

  if (claims.length === 0) {
    return <EmptyState kind="empty" description="还没有已处理的贡献申报。" />;
  }
  const selected = claims.find((claim) => claim.id === selectedId) ?? claims[0] ?? null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardContent className="p-0">
          <ul className="flex flex-col divide-y divide-border">
            {claims.map((claim) => (
              <li key={claim.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(claim.id);
                    setConfirmId(null);
                    setReason('');
                  }}
                  aria-pressed={claim.id === selected?.id}
                  className={`flex w-full flex-col gap-1 p-4 text-left hover:bg-muted/40 ${
                    claim.id === selected?.id ? 'bg-info-subtle' : ''
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{claim.title}</span>
                    <ClaimStatusTag status={claim.status} />
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {claim.user?.verifiedRealName ?? '—'} · {claim.user?.studentNo ?? '—'} ·{' '}
                    {claim.reviewedAt ? formatDateTime(claim.reviewedAt) : formatDateTime(claim.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {selected && (
        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">{selected.title}</h3>
              <ClaimStatusTag status={selected.status} />
            </div>
            <p className="text-sm leading-[22px] whitespace-pre-wrap text-foreground/90">
              {selected.description}
            </p>
            <p className="text-xs text-muted-foreground">
              {CATEGORY_LABELS[selected.category] ?? selected.category} · 记分月份{' '}
              <span className="tabular-nums">{selected.scoreMonth}</span>
              {selected.reviewedAt && ` · 处理于 ${formatDateTime(selected.reviewedAt)}`}
            </p>
            {selected.reviewNote && (
              <p className="rounded-md bg-muted px-2.5 py-2 text-xs leading-5 text-foreground/80">
                审核备注：{selected.reviewNote}
              </p>
            )}
            {selected.ledgerEntry ? (
              <p className="rounded-md bg-success-subtle px-2.5 py-2 text-xs leading-5 text-success-foreground">
                已入账 {Number(selected.ledgerEntry.amount)} 分 · {selected.ledgerEntry.scoreMonth} ·{' '}
                {formatDateTime(selected.ledgerEntry.recordedAt)}
                <span className="mt-0.5 block break-all text-[11px] opacity-80">
                  流水 {selected.ledgerEntry.id}
                </span>
              </p>
            ) : (
              <p className="rounded-md bg-muted px-2.5 py-2 text-xs leading-5 text-muted-foreground">
                当前没有生效的入账记录（通过时未填分值，或流水已被冲正）。
              </p>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="withdraw-reason">撤回原因（3-500 字）</Label>
              <Textarea
                id="withdraw-reason"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  setConfirmId(null);
                }}
                rows={2}
                maxLength={500}
                placeholder="如：佐证材料与申报人不符 / 分值填错"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={confirmId === selected.id ? 'destructive' : 'outline'}
                disabled={mutation.isPending || reason.trim().length < 3}
                onClick={() => {
                  if (confirmId === selected.id) mutation.mutate(selected.id);
                  else setConfirmId(selected.id);
                }}
              >
                {mutation.isPending && mutation.variables === selected.id && (
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                )}
                {confirmId === selected.id ? '确认撤回审核' : '撤回审核'}
              </Button>
              <span className="text-xs text-muted-foreground">
                撤回后申报回到待审核；已入账分值会生成冲正记录，不会直接删除。
              </span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const APPEAL_STATUS_LABELS: Record<string, string> = {
  submitted: '已提交',
  in_review: '受理中',
  resolved: '已采纳结案',
  rejected: '已驳回',
};

type AppealLedgerAction = 'none' | 'reverse' | 'replace' | 'supplement';

function AppealsQueue({
  appeals,
  processedAppeals,
  onNotice,
  onHandled,
}: {
  appeals: AppealDto[];
  processedAppeals: AppealDto[];
  onNotice: (notice: { tone: 'info' | 'error'; text: string } | null) => void;
  onHandled: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [ledgerAction, setLedgerAction] = useState<AppealLedgerAction>('none');
  const [replacementAmount, setReplacementAmount] = useState('');
  const [adjustmentAmount, setAdjustmentAmount] = useState('');
  const [supplementMonth, setSupplementMonth] = useState('');

  const selected = appeals.find((appeal) => appeal.id === selectedId) ?? appeals[0] ?? null;
  const selectedLedger = selected?.ledgerEntry ?? null;
  const canReverseSelected = Boolean(
    selectedLedger &&
      selectedLedger.status === 'approved' &&
      selectedLedger.category !== 'reversal',
  );

  useEffect(() => {
    setResolutionNote(selected?.resolutionNote ?? '');
    setLedgerAction('none');
    setReplacementAmount('');
    setAdjustmentAmount('');
    setSupplementMonth(selected?.ledgerEntry?.scoreMonth ?? currentMonthKey());
  }, [selected?.id]);

  const mutation = useMutation({
    mutationFn: async (input: {
      appealId: string;
      decision: 'in_review' | 'resolved' | 'rejected';
      resolutionNote: string;
      ledgerAction?: AppealLedgerAction;
      replacementAmount?: string;
      adjustmentAmount?: string;
      scoreMonth?: string;
    }) => {
      await api.post(`/admin/appeals/${input.appealId}/decision`, {
        decision: input.decision,
        resolutionNote: input.resolutionNote || undefined,
        ...(input.decision === 'resolved' && input.ledgerAction && input.ledgerAction !== 'none'
          ? {
              ledgerAction: input.ledgerAction,
              ...(input.ledgerAction === 'replace' ? { replacementAmount: input.replacementAmount } : {}),
              ...(input.ledgerAction === 'supplement'
                ? {
                    adjustmentAmount: input.adjustmentAmount,
                    ...(input.scoreMonth ? { scoreMonth: input.scoreMonth } : {}),
                  }
                : {}),
            }
          : {}),
      });
      return input;
    },
    onSuccess: (input) => {
      const actionNote =
        input.decision === 'resolved' && input.ledgerAction === 'replace'
          ? `，并已冲正原流水、替换为 ${input.replacementAmount} 分`
          : input.decision === 'resolved' && input.ledgerAction === 'reverse'
            ? '，并已冲正撤销原流水'
            : input.decision === 'resolved' && input.ledgerAction === 'supplement'
              ? `，并已另行记入 ${input.adjustmentAmount} 分`
              : '';
      onNotice({
        tone: 'info',
        text:
          input.decision === 'in_review'
            ? '已标记申诉为「受理中」，成员端同步可见。'
            : input.decision === 'resolved'
              ? `申诉已采纳并结案${actionNote}，结果已同步至成员端。`
              : '申诉已驳回并结案，说明已同步至成员端。',
      });
      setResolutionNote('');
      setLedgerAction('none');
      setReplacementAmount('');
      setAdjustmentAmount('');
      onHandled();
    },
    onError: (error: ApiError) => onNotice({ tone: 'error', text: error.message }),
  });

  const noteTrimmed = resolutionNote.trim();
  const decimalRe = /^-?\d+(\.\d+)?$/;
  const resolveInvalid =
    noteTrimmed.length < 3 ||
    (ledgerAction === 'replace' && (!canReverseSelected || !decimalRe.test(replacementAmount.trim()))) ||
    (ledgerAction === 'reverse' && !canReverseSelected) ||
    (ledgerAction === 'supplement' &&
      (!decimalRe.test(adjustmentAmount.trim()) || Number(adjustmentAmount.trim()) === 0));

  return (
    <div className="flex flex-col gap-5">
      {appeals.length === 0 ? (
        <EmptyState kind="empty" description="没有待处理的申诉。" />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardContent className="p-0">
              <ul className="flex flex-col divide-y divide-border">
                {appeals.map((appeal) => (
                  <li key={appeal.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(appeal.id)}
                      className={`flex w-full flex-col gap-1.5 p-4 text-left hover:bg-muted/40 ${
                        appeal.id === selected?.id ? 'bg-info-subtle' : ''
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">{appeal.subject}</span>
                        <StatusBadge
                          kind="disclosure"
                          value={appeal.status === 'in_review' ? '待审核' : '待审批'}
                        />
                      </div>
                      {appeal.ledgerEntry && (
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="rounded-sm bg-muted px-1.5 py-0.5 font-medium text-foreground">
                            {appeal.ledgerEntry.eventName}
                          </span>
                          <span className="text-muted-foreground tabular-nums">
                            {appeal.ledgerEntry.scoreMonth}
                          </span>
                          <span
                            className={`font-semibold tabular-nums ${
                              Number(appeal.ledgerEntry.amount) < 0 ? 'text-destructive' : 'text-foreground'
                            }`}
                          >
                            {formatSignedAmount(appeal.ledgerEntry.amount)}
                          </span>
                          <StatusBadge kind="points" value={ledgerStatusBadge(appeal.ledgerEntry.status)} />
                        </div>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {appeal.user?.verifiedRealName ?? '—'} · {appeal.user?.studentNo ?? '—'} ·{' '}
                        {formatDateTime(appeal.createdAt)}
                        {' · '}
                        {APPEAL_STATUS_LABELS[appeal.status] ?? appeal.status}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          {selected && (
            <Card>
              <CardContent className="flex flex-col gap-3.5 p-5">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{selected.subject}</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    申诉人：{selected.user?.verifiedRealName ?? '—'}（{selected.user?.studentNo ?? '—'}）·{' '}
                    {formatDateTime(selected.createdAt)} · 当前状态：{APPEAL_STATUS_LABELS[selected.status] ?? selected.status}
                  </p>
                </div>

                {selectedLedger ? (
                  <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-muted/30 p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-foreground">申诉对应的积分流水</span>
                      <StatusBadge kind="points" value={ledgerStatusBadge(selectedLedger.status)} />
                    </div>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">{selectedLedger.eventName}</span>
                      <span
                        className={`text-base font-semibold tabular-nums ${
                          Number(selectedLedger.amount) < 0 ? 'text-destructive' : 'text-foreground'
                        }`}
                      >
                        {formatSignedAmount(selectedLedger.amount)} 分
                      </span>
                    </div>
                    <p className="text-muted-foreground tabular-nums">
                      {LEDGER_CATEGORY_LABELS[selectedLedger.category] ?? selectedLedger.category} · 计分月份{' '}
                      {selectedLedger.scoreMonth} · 入账于 {formatDateTime(selectedLedger.recordedAt)}
                    </p>
                    {selectedLedger.replacementAmount != null && (
                      <p className="text-primary tabular-nums">
                        该流水已生成替代记录：{formatSignedAmount(selectedLedger.replacementAmount)} 分
                      </p>
                    )}
                    {selectedLedger.reversalReason && (
                      <p className="text-muted-foreground">冲正说明：{selectedLedger.reversalReason}</p>
                    )}
                    <p className="font-mono text-[11px] break-all text-muted-foreground/80">
                      流水 ID：{selectedLedger.id} · sourceKey：{selectedLedger.sourceKey}
                    </p>
                  </div>
                ) : (
                  <p className="rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                    该历史申诉未关联具体积分流水，可在下方选择仅回复结案或另行补录分值。
                  </p>
                )}

                <div className="rounded-xl bg-muted/40 p-3 text-sm leading-[22px] whitespace-pre-wrap text-foreground/90">
                  {selected.materials ?? '（未附材料说明）'}
                </div>

                <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="appeal-ledger-action">采纳结案时的账本处理方式</Label>
                    <Select
                      value={ledgerAction}
                      onValueChange={(value) => setLedgerAction(value as AppealLedgerAction)}
                    >
                      <SelectTrigger id="appeal-ledger-action">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">仅回复结案（不调整积分账本）</SelectItem>
                        <SelectItem value="replace" disabled={!canReverseSelected}>
                          冲正原流水并替换为新分值
                        </SelectItem>
                        <SelectItem value="reverse" disabled={!canReverseSelected}>
                          仅冲正撤销该笔流水（原分值作废）
                        </SelectItem>
                        <SelectItem value="supplement">保留原流水，另行补录 / 扣减分值</SelectItem>
                      </SelectContent>
                    </Select>
                    {selectedLedger && !canReverseSelected && (
                      <p className="text-xs text-muted-foreground">
                        该笔流水当前非生效状态或本身为冲正记录，不可再次冲正，可选择「仅回复结案」或「另行补录 / 扣减」。
                      </p>
                    )}
                  </div>

                  {ledgerAction === 'replace' && (
                    <div className="grid gap-1.5">
                      <Label htmlFor="appeal-replacement-amount">替换后的新分值（带符号十进制，如 4 或 2.5）</Label>
                      <Input
                        id="appeal-replacement-amount"
                        value={replacementAmount}
                        onChange={(event) => setReplacementAmount(event.target.value)}
                        placeholder={selectedLedger ? `原分值 ${selectedLedger.amount}` : '如 4'}
                        inputMode="decimal"
                      />
                    </div>
                  )}

                  {ledgerAction === 'supplement' && (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div className="grid gap-1.5">
                        <Label htmlFor="appeal-adj-amount">补录 / 扣减分值（非零，可负）</Label>
                        <Input
                          id="appeal-adj-amount"
                          value={adjustmentAmount}
                          onChange={(event) => setAdjustmentAmount(event.target.value)}
                          placeholder="如 2 或 -1.5"
                          inputMode="decimal"
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="appeal-adj-month">计分月份</Label>
                        <Input
                          id="appeal-adj-month"
                          type="month"
                          value={supplementMonth}
                          onChange={(event) => setSupplementMonth(event.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="appeal-resolution-note">处理说明 / 结案回复（结案或驳回至少 3 字，将展示给申诉人）</Label>
                  <Textarea
                    id="appeal-resolution-note"
                    rows={3}
                    maxLength={2000}
                    value={resolutionNote}
                    onChange={(event) => setResolutionNote(event.target.value)}
                    placeholder="写明核查结果、调整说明或依据条款"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  {selected.status !== 'in_review' && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={mutation.isPending}
                      onClick={() =>
                        mutation.mutate({
                          appealId: selected.id,
                          decision: 'in_review',
                          resolutionNote: noteTrimmed,
                        })
                      }
                    >
                      标记受理中
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    disabled={mutation.isPending || resolveInvalid}
                    onClick={() =>
                      mutation.mutate({
                        appealId: selected.id,
                        decision: 'resolved',
                        resolutionNote: noteTrimmed,
                        ledgerAction,
                        replacementAmount: replacementAmount.trim() || undefined,
                        adjustmentAmount: adjustmentAmount.trim() || undefined,
                        scoreMonth: supplementMonth || undefined,
                      })
                    }
                  >
                    {mutation.isPending && mutation.variables?.decision === 'resolved' && (
                      <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                    )}
                    {ledgerAction === 'replace'
                      ? '采纳并冲正替换'
                      : ledgerAction === 'reverse'
                        ? '采纳并冲正撤销'
                        : ledgerAction === 'supplement'
                          ? '采纳并补录结案'
                          : '采纳并结案'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={mutation.isPending || noteTrimmed.length < 3}
                    onClick={() =>
                      mutation.mutate({
                        appealId: selected.id,
                        decision: 'rejected',
                        resolutionNote: noteTrimmed,
                      })
                    }
                  >
                    {mutation.isPending && mutation.variables?.decision === 'rejected' && (
                      <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                    )}
                    驳回申诉
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {processedAppeals.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            <h3 className="text-sm font-semibold text-foreground">
              近期已结案申诉（{processedAppeals.length}）
            </h3>
            <ul className="flex flex-col divide-y divide-border">
              {processedAppeals.map((appeal) => (
                <li key={appeal.id} className="flex flex-col gap-1 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{appeal.subject}</span>
                    <StatusBadge
                      kind="disclosure"
                      value={appeal.status === 'resolved' ? '已批准' : '已驳回'}
                    />
                    <span className="text-xs text-muted-foreground">
                      {appeal.user?.verifiedRealName ?? '—'}（{appeal.user?.studentNo ?? '—'}）
                    </span>
                  </div>
                  {appeal.ledgerEntry && (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      关联流水：{appeal.ledgerEntry.eventName} · {appeal.ledgerEntry.scoreMonth} ·{' '}
                      {formatSignedAmount(appeal.ledgerEntry.amount)} 分（{ledgerStatusBadge(appeal.ledgerEntry.status)}
                      {appeal.ledgerEntry.replacementAmount != null
                        ? `，已替换为 ${formatSignedAmount(appeal.ledgerEntry.replacementAmount)} 分`
                        : ''}
                      ）
                    </p>
                  )}
                  {appeal.resolutionNote && (
                    <p className="text-xs leading-5 text-muted-foreground">结论：{appeal.resolutionNote}</p>
                  )}
                  <p className="text-xs text-muted-foreground tabular-nums">
                    提交于 {formatDateTime(appeal.createdAt)}
                    {appeal.closedAt ? ` · 结案于 ${formatDateTime(appeal.closedAt)}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** 批量 / 手动加分与流水台账：展示批量手动加分记录，支持筛选、搜索与直接冲正调分 */
function ManualLedgerRecordsTab({
  principalId,
  onNotice,
  onHandled,
  onOpenBatch,
  onOpenSingle,
}: {
  principalId: string;
  onNotice: (notice: { tone: 'info' | 'error'; text: string } | null) => void;
  onHandled: () => void;
  onOpenBatch: () => void;
  onOpenSingle: () => void;
}) {
  const [scope, setScope] = useState<'manual_batch' | 'manual' | 'all'>('manual_batch');
  const [month, setMonth] = useState('');
  const [status, setStatus] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const [queryText, setQueryText] = useState('');
  const [reverseTarget, setReverseTarget] = useState<AdminLedgerEntryDto | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [replacementAmount, setReplacementAmount] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setQueryText(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const ledgerQuery = usePrivateInfiniteQuery<
    { items: AdminLedgerEntryDto[]; nextCursor?: string },
    ApiError
  >(
    principalId,
    ['admin', 'ledger-entries', scope, month, status, queryText],
    async (cursor) => {
      const params = new URLSearchParams({ scope });
      if (month) params.set('month', month);
      if (status !== 'all') params.set('status', status);
      if (queryText) params.set('q', queryText);
      if (cursor) params.set('cursor', cursor);
      const { data } = await api.get<{ items: AdminLedgerEntryDto[]; nextCursor?: string }>(
        `/admin/ledger-entries?${params.toString()}`,
      );
      return data;
    },
  );

  const reverseMutation = useMutation({
    mutationFn: async (input: { entryId: string; reason: string; replacementAmount?: string }) => {
      await api.post(`/admin/ledger-entries/${input.entryId}/reverse`, {
        reason: input.reason,
        ...(input.replacementAmount ? { replacementAmount: input.replacementAmount } : {}),
      });
    },
    onSuccess: () => {
      onNotice({
        tone: 'info',
        text: replacementAmount.trim()
          ? '已完成冲正并生成替代分值记录。'
          : '已冲正撤销该笔积分流水。',
      });
      setReverseTarget(null);
      setReverseReason('');
      setReplacementAmount('');
      onHandled();
    },
    onError: (error: ApiError) => onNotice({ tone: 'error', text: error.message }),
  });

  const items = ledgerQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const activeApproved = items.filter((item) => item.status === 'approved');
  const batchCount = new Set(items.map((item) => item.batchId).filter(Boolean)).size;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={scope}
                onValueChange={(value) => setScope(value as 'manual_batch' | 'manual' | 'all')}
              >
                <SelectTrigger className="w-40" aria-label="记录范围">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual_batch">批量手动加分</SelectItem>
                  <SelectItem value="manual">全部手动 / 调账</SelectItem>
                  <SelectItem value="all">全部积分流水</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="month"
                value={month}
                onChange={(event) => setMonth(event.target.value)}
                className="w-40"
                aria-label="按月份筛选"
              />
              {month && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setMonth('')}>
                  清除月份
                </Button>
              )}
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-28" aria-label="状态筛选">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="approved">已记分</SelectItem>
                  <SelectItem value="reversed">已冲正</SelectItem>
                </SelectContent>
              </Select>
              <div className="relative">
                <SearchIcon
                  className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="搜学号 / 姓名 / 来源"
                  className="w-48 pl-8"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={onOpenSingle}>
                <CoinsIcon aria-hidden="true" />
                单笔入账
              </Button>
              <Button type="button" size="sm" onClick={onOpenBatch}>
                <ClipboardListIcon aria-hidden="true" />
                批量加分
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground tabular-nums">
            <span>已加载 {items.length} 条记录</span>
            <span>生效 {activeApproved.length} 条</span>
            {scope === 'manual_batch' && batchCount > 0 && <span>涉及 {batchCount} 个批次</span>}
          </div>

          {ledgerQuery.isPending ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2, 3].map((idx) => (
                <div key={idx} className="h-11 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : ledgerQuery.isError ? (
            <Alert variant="destructive">
              <AlertDescription>{ledgerQuery.error.message}</AlertDescription>
            </Alert>
          ) : items.length === 0 ? (
            <EmptyState
              kind="empty"
              description={
                scope === 'manual_batch'
                  ? '暂无批量手动加分记录；点击右上角「批量加分」提交后会立即展示在这里。'
                  : '当前筛选条件下没有积分流水记录。'
              }
            />
          ) : (
            <>
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>成员</TableHead>
                      <TableHead>事件 / 备注</TableHead>
                      <TableHead>类别 / 月份</TableHead>
                      <TableHead className="text-right">分值</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>入账时间</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => {
                      const canReverse = item.status === 'approved' && item.category !== 'reversal';
                      return (
                        <TableRow key={item.id}>
                          <TableCell className="whitespace-nowrap">
                            <span className="block text-sm font-medium text-foreground">
                              {item.user?.verifiedRealName ?? '—'}
                            </span>
                            <span className="block text-xs text-muted-foreground tabular-nums">
                              {item.user?.studentNo ?? '—'}
                            </span>
                          </TableCell>
                          <TableCell className="max-w-72">
                            <span className="block truncate text-sm font-medium text-foreground" title={item.eventName}>
                              {item.eventName}
                            </span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                              {item.batchId && (
                                <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                                  批次 {item.batchId.slice(0, 8)}
                                </span>
                              )}
                              {item.note && item.note !== item.eventName && (
                                <span className="truncate" title={item.note}>
                                  {item.note}
                                </span>
                              )}
                            </span>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                            <span className="block text-foreground">
                              {LEDGER_CATEGORY_LABELS[item.category] ?? item.category}
                            </span>
                            <span className="tabular-nums">{item.scoreMonth}</span>
                          </TableCell>
                          <TableCell
                            className={`text-right font-semibold tabular-nums whitespace-nowrap ${
                              Number(item.amount) < 0 ? 'text-destructive' : 'text-foreground'
                            }`}
                          >
                            {formatSignedAmount(item.amount)}
                          </TableCell>
                          <TableCell>
                            <span className="flex flex-col gap-0.5">
                              <StatusBadge kind="points" value={ledgerStatusBadge(item.status)} />
                              {item.reversalReason && (
                                <span className="max-w-40 truncate text-[11px] text-muted-foreground" title={item.reversalReason}>
                                  {item.reversalReason}
                                </span>
                              )}
                            </span>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                            {formatDateTime(item.recordedAt)}
                          </TableCell>
                          <TableCell className="text-right whitespace-nowrap">
                            {canReverse ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setReverseTarget(item);
                                  setReverseReason('');
                                  setReplacementAmount('');
                                }}
                              >
                                <RotateCcwIcon className="size-3.5" aria-hidden="true" />
                                冲正 / 调分
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <ul className="flex flex-col divide-y divide-border md:hidden">
                {items.map((item) => {
                  const canReverse = item.status === 'approved' && item.category !== 'reversal';
                  return (
                    <li key={item.id} className="flex flex-col gap-1.5 py-3 text-sm">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <span className="font-medium text-foreground">
                            {item.user?.verifiedRealName ?? '—'}
                          </span>
                          <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
                            {item.user?.studentNo ?? '—'}
                          </span>
                          <p className="truncate text-xs text-muted-foreground">{item.eventName}</p>
                        </div>
                        <span
                          className={`shrink-0 font-semibold tabular-nums ${
                            Number(item.amount) < 0 ? 'text-destructive' : 'text-foreground'
                          }`}
                        >
                          {formatSignedAmount(item.amount)}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <StatusBadge kind="points" value={ledgerStatusBadge(item.status)} />
                          <span>{LEDGER_CATEGORY_LABELS[item.category] ?? item.category}</span>
                          <span className="tabular-nums">{item.scoreMonth}</span>
                          {item.batchId && (
                            <span className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px]">
                              批次 {item.batchId.slice(0, 8)}
                            </span>
                          )}
                        </span>
                        {canReverse && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() => {
                              setReverseTarget(item);
                              setReverseReason('');
                              setReplacementAmount('');
                            }}
                          >
                            冲正 / 调分
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <LoadMoreButton
                onClick={() => void ledgerQuery.fetchNextPage()}
                loading={ledgerQuery.isFetchingNextPage}
                hasNext={Boolean(ledgerQuery.data?.pages.at(-1)?.nextCursor)}
                hint="已展示全部记录"
              />
            </>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(reverseTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setReverseTarget(null);
            setReverseReason('');
            setReplacementAmount('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>冲正 / 调整该笔积分</DialogTitle>
            <DialogDescription>
              冲正会保留原始账本记录并生成负向冲正条目；填写替代分值时将同时生成新条目。
            </DialogDescription>
          </DialogHeader>
          {reverseTarget && (
            <div className="flex flex-col gap-3">
              <div className="rounded-xl border border-border bg-muted/30 p-3 text-xs">
                <p className="font-medium text-foreground">
                  {reverseTarget.user?.verifiedRealName ?? '—'}（{reverseTarget.user?.studentNo ?? '—'}）·{' '}
                  {reverseTarget.eventName}
                </p>
                <p className="mt-1 text-muted-foreground tabular-nums">
                  {LEDGER_CATEGORY_LABELS[reverseTarget.category] ?? reverseTarget.category} ·{' '}
                  {reverseTarget.scoreMonth} · 当前分值 {formatSignedAmount(reverseTarget.amount)} 分
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="inline-reverse-reason">冲正原因（3-500 字）</Label>
                <Input
                  id="inline-reverse-reason"
                  value={reverseReason}
                  onChange={(event) => setReverseReason(event.target.value)}
                  placeholder="如：批量录入分值有误 / 重复加分"
                  minLength={3}
                  maxLength={500}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="inline-reverse-amount">替代分值（可选，留空表示仅冲正撤销）</Label>
                <Input
                  id="inline-reverse-amount"
                  value={replacementAmount}
                  onChange={(event) => setReplacementAmount(event.target.value)}
                  placeholder="如 3 或 1.5"
                  inputMode="decimal"
                />
              </div>
              <Button
                type="button"
                disabled={
                  reverseMutation.isPending ||
                  reverseReason.trim().length < 3 ||
                  (Boolean(replacementAmount.trim()) && !/^-?\d+(\.\d+)?$/.test(replacementAmount.trim()))
                }
                onClick={() =>
                  reverseMutation.mutate({
                    entryId: reverseTarget.id,
                    reason: reverseReason.trim(),
                    replacementAmount: replacementAmount.trim() || undefined,
                  })
                }
              >
                {reverseMutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
                {replacementAmount.trim() ? '确认冲正并替换' : '确认冲正撤销'}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CasesQueue({
  cases,
  onNotice,
  onHandled,
}: {
  cases: ReviewCaseDto[];
  onNotice: (notice: { tone: 'info' | 'error'; text: string } | null) => void;
  onHandled: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: async ({ caseId, verdict }: { caseId: string; verdict: 'approve' | 'reject' | 'more_info' }) => {
      const { data } = await api.post<{ resolved: boolean; approvals: number }>(
        `/admin/reviews/${caseId}/votes`,
        { verdict, reason: reason.trim() },
      );
      return data;
    },
    onSuccess: (result) => {
      onNotice({
        tone: 'info',
        text: result.resolved
          ? '已裁决，案件结案。'
          : '意见已记录，案件保持待处理。',
      });
      onHandled();
    },
    onError: (error: ApiError) => onNotice({ tone: 'error', text: error.message }),
  });

  if (cases.length === 0) {
    return <EmptyState kind="empty" description="没有待复核的案件。" />;
  }
  const selected = cases.find((item) => item.id === selectedId) ?? cases[0] ?? null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardContent className="p-0">
          <ul className="flex flex-col divide-y divide-border">
            {cases.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={`flex w-full flex-col gap-1 p-4 text-left hover:bg-muted/40 ${
                    item.id === selected?.id ? 'bg-info-subtle' : ''
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {item.subject ?? item.type}
                    </span>
                    <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-foreground/80">
                      {item.type}
                    </span>
                    {item.teacherRequired && (
                      <span className="text-xs text-warning-foreground">需教师复核</span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(item.createdAt)} · {item.votes.length} 票
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {selected && (
        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            <h3 className="text-sm font-semibold text-foreground">{selected.subject ?? selected.type}</h3>
            {selected.note && (
              <p className="text-sm leading-[22px] whitespace-pre-wrap text-foreground/90">
                {selected.note}
              </p>
            )}
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {selected.votes.map((vote) => (
                <li key={vote.id}>
                  {vote.verdict} · {vote.reason}
                </li>
              ))}
            </ul>
            <div className="grid gap-1.5">
              <Label htmlFor="vote-reason">投票理由（3-500 字）</Label>
              <Textarea
                id="vote-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                maxLength={500}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={mutation.isPending || reason.trim().length < 3}
                onClick={() => mutation.mutate({ caseId: selected.id, verdict: 'approve' })}
              >
                同意
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={mutation.isPending || reason.trim().length < 3}
                onClick={() => mutation.mutate({ caseId: selected.id, verdict: 'reject' })}
              >
                不同意
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={mutation.isPending || reason.trim().length < 3}
                onClick={() => mutation.mutate({ caseId: selected.id, verdict: 'more_info' })}
              >
                需补充信息
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              单人裁决即结案：「通过」或「驳回」直接结案，「需补充信息」只记录意见。
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface ParsedBatchRow {
  /** 学号或姓名 */
  query: string;
  amount: string;
  note?: string;
  error?: string;
}

interface BatchMemberOption {
  userId: string;
  studentNo: string;
  name: string;
  displayName: string | null;
  grade: number | null;
}

interface BatchMemberResolution {
  query: string;
  match: BatchMemberOption | null;
  candidates: BatchMemberOption[];
  error?: string;
}

/** 解析粘贴/CSV 行：`学号或姓名 分数 备注`，分隔符支持逗号（中英）、Tab、空白 */
function parseBatchRows(text: string): ParsedBatchRow[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 200)
    .map((line) => {
      const parts = line.split(/[\t,，;；]+|\s+/).filter((part) => part !== '');
      const query = parts[0] ?? '';
      const amount = parts[1] ?? '';
      const note = parts.slice(2).join(' ') || undefined;
      if (query.length < 2) return { query, amount, note, error: '学号或姓名至少 2 个字符' };
      if (!/^-?\d+(\.\d+)?$/.test(amount)) return { query, amount, note, error: '分数需为十进制数字（可负）' };
      return { query, amount, note };
    });
}

/** 批量加分：粘贴或导入 CSV（学号,分数,备注），可选关联活动（成员端活动详情展示积分） */
function BatchLedgerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const principal = usePrincipal();
  const principalId = principal?.principalId ?? null;
  const queryClient = useQueryClient();
  const [category, setCategory] = useState('activity');
  const [scoreMonth, setScoreMonth] = useState(currentMonthKey());
  const [activityId, setActivityId] = useState('none');
  const [rawText, setRawText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ posted: number; deduplicated: number; failed: Array<{ studentNo: string; error: string }> } | null>(null);
  /** 同名候选：输入值 → 选定的学号 */
  const [memberChoices, setMemberChoices] = useState<Record<string, string>>({});
  const [debouncedQueries, setDebouncedQueries] = useState<string[]>([]);

  const activitiesQuery = usePrivateQuery<Array<{ id: string; title: string; status: string }>, ApiError>(
    principalId,
    ['admin', 'activities', 'for-points'],
    async () => (await api.get<Array<{ id: string; title: string; status: string }>>('/admin/activities')).data,
    { enabled: open && principalId != null },
  );
  const activityOptions = (activitiesQuery.data ?? []).filter((item) => item.status !== 'draft').slice(0, 30);

  const parsed = parseBatchRows(rawText);
  const validRows = parsed.filter((row) => !row.error);
  const invalidRows = parsed.filter((row) => row.error);
  const identifierKey = [...new Set(validRows.map((row) => row.query))].sort().join('\u0000');

  // 输入停顿后再核对，避免每敲一个字都请求；学号或姓名都可作为输入
  useEffect(() => {
    if (!open) {
      setDebouncedQueries([]);
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedQueries(identifierKey ? identifierKey.split('\u0000') : []);
    }, 350);
    return () => clearTimeout(timer);
  }, [identifierKey, open]);

  const resolveQuery = usePrivateQuery<BatchMemberResolution[], ApiError>(
    principalId,
    ['admin', 'members', 'resolve', debouncedQueries.join('\u0000')],
    async () => (await api.post<BatchMemberResolution[]>('/admin/members/resolve', { queries: debouncedQueries })).data,
    { enabled: open && debouncedQueries.length > 0, staleTime: 0 },
  );
  const resolutionByQuery = new Map((resolveQuery.data ?? []).map((item) => [item.query, item]));
  const checking = resolveQuery.isFetching || identifierKey !== debouncedQueries.join('\u0000');

  const resolveBatchRow = (row: ParsedBatchRow): { studentNo: string | null; member: BatchMemberOption | null; error?: string } => {
    if (row.error) return { studentNo: null, member: null, error: row.error };
    const resolution = resolutionByQuery.get(row.query);
    if (!resolution) {
      return { studentNo: null, member: null, error: resolveQuery.isError ? '成员核对失败' : '核对中…' };
    }
    if (resolution.match) return { studentNo: resolution.match.studentNo, member: resolution.match };
    const chosen = memberChoices[row.query];
    if (chosen) {
      return {
        studentNo: chosen,
        member: resolution.candidates.find((candidate) => candidate.studentNo === chosen) ?? null,
      };
    }
    return { studentNo: null, member: null, error: resolution.error ?? '待选择成员' };
  };
  const readyRows = validRows.filter((row) => resolveBatchRow(row).studentNo != null);

  const mutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ batchId: string; posted: number; deduplicated: number; failed: Array<{ studentNo: string; error: string }> }>(
        '/admin/ledger-entries/batch',
        {
          rows: validRows.map((row) => ({
            studentNo: resolveBatchRow(row).studentNo!,
            amount: row.amount,
            note: row.note,
          })),
          category,
          scoreMonth,
          ...(activityId !== 'none' ? { activityId } : {}),
        },
      );
      return data;
    },
    onSuccess: (data) => {
      setResult({ posted: data.posted, deduplicated: data.deduplicated, failed: data.failed });
      setError(null);
      setRawText('');
      setMemberChoices({});
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin'] });
    },
    onError: (cause: ApiError) => {
      setError(cause.message);
      setResult(null);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>批量加分</DialogTitle>
          <DialogDescription>
            每行一条：`学号或姓名 分数 备注`（二选一即可，分隔符支持逗号 / Tab / 空格，最多 200 行）。
            只有姓名且同名多人时，会在下方核对表里请你选择具体成员；关联活动后成员端活动详情会显示本次积分。
            同一批次内按成员幂等，重复提交整批不重复入账。
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {result && (
          <Alert>
            <AlertDescription>
              已入账 {result.posted} 条{result.deduplicated > 0 ? `，幂等跳过 ${result.deduplicated} 条` : ''}
              {result.failed.length > 0 ? `，失败 ${result.failed.length} 条` : ''}。
              {result.failed.length > 0 && (
                <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
                  {result.failed.map((row, index) => (
                    <li key={index}>{row.studentNo}：{row.error}</li>
                  ))}
                </ul>
              )}
            </AlertDescription>
          </Alert>
        )}
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="batch-category">类别</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="batch-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="activity">活动</SelectItem>
                <SelectItem value="contest">比赛</SelectItem>
                <SelectItem value="remote_contest">远程赛</SelectItem>
                <SelectItem value="contribution">贡献</SelectItem>
                <SelectItem value="service">服务</SelectItem>
                <SelectItem value="award">奖励</SelectItem>
                <SelectItem value="penalty">扣分</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="batch-month">计分月份</Label>
            <Input
              id="batch-month"
              type="month"
              value={scoreMonth}
              onChange={(event) => setScoreMonth(event.target.value || currentMonthKey())}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="batch-activity">关联活动（可选）</Label>
            <Select value={activityId} onValueChange={setActivityId}>
              <SelectTrigger id="batch-activity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">不关联</SelectItem>
                {activityOptions.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="batch-raw">粘贴名单（学号或姓名 分数 备注）</Label>
          <Textarea
            id="batch-raw"
            value={rawText}
            onChange={(event) => {
              setRawText(event.target.value);
              setResult(null);
            }}
            rows={6}
            placeholder={'202600001 12 周赛到场\n张三 8.5 周赛到场'}
            className="font-mono text-xs"
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              已解析 <span className="font-medium text-foreground tabular-nums">{validRows.length}</span> 条有效
              {invalidRows.length > 0 && (
                <span className="text-destructive">，{invalidRows.length} 条格式有误</span>
              )}
            </span>
            <label className="cursor-pointer underline-offset-2 hover:underline">
              或上传 CSV 文件
              <input
                type="file"
                accept=".csv,.txt"
                className="hidden"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  const text = await file.text();
                  setRawText(text);
                  setResult(null);
                  event.target.value = '';
                }}
              />
            </label>
          </div>
          {resolveQuery.isError && (
            <Alert variant="destructive">
              <AlertDescription>成员核对失败：{resolveQuery.error.message}</AlertDescription>
            </Alert>
          )}
          {parsed.length > 0 && (
            <div className="max-h-52 overflow-y-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow className="h-8">
                    <TableHead className="pl-3 text-xs">输入</TableHead>
                    <TableHead className="text-xs">成员</TableHead>
                    <TableHead className="text-xs">分数</TableHead>
                    <TableHead className="pr-3 text-xs">备注 / 问题</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsed.map((row, index) => {
                    const resolved = resolveBatchRow(row);
                    const resolution = resolutionByQuery.get(row.query);
                    const needsChoice = !row.error && !resolution?.match && (resolution?.candidates.length ?? 0) > 1;
                    return (
                      <TableRow key={index} className={row.error ? 'bg-destructive-subtle/40' : undefined}>
                        <TableCell className="py-1.5 pl-3 text-xs">{row.query}</TableCell>
                        <TableCell className="py-1.5 text-xs">
                          {needsChoice ? (
                            <div className="flex min-w-36 flex-col gap-1">
                              <Select
                                value={memberChoices[row.query] ?? ''}
                                onValueChange={(value) => setMemberChoices((previous) => ({ ...previous, [row.query]: value }))}
                                disabled={checking}
                              >
                                <SelectTrigger className="h-7 px-2 text-xs" aria-label={`第 ${index + 1} 行选择同名成员`}>
                                  <SelectValue placeholder={`${row.query} · 选择成员`} />
                                </SelectTrigger>
                                <SelectContent>
                                  {resolution?.candidates.map((candidate) => (
                                    <SelectItem key={candidate.userId} value={candidate.studentNo}>
                                      {candidate.studentNo} · {candidate.name}
                                      {candidate.grade != null ? ` · ${candidate.grade} 级` : ''}
                                      {candidate.displayName && candidate.displayName !== candidate.name ? `（${candidate.displayName}）` : ''}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <span className="text-destructive">姓名重复，需选择</span>
                            </div>
                          ) : resolved.member ? (
                            <>
                              <span className="block">{resolved.member.name}</span>
                              <span className="block text-muted-foreground tabular-nums">{resolved.member.studentNo}</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">{checking ? '核对中…' : resolved.error ?? '—'}</span>
                          )}
                        </TableCell>
                        <TableCell className="py-1.5 text-xs tabular-nums">{row.amount}</TableCell>
                        <TableCell className="py-1.5 pr-3 text-xs text-muted-foreground">
                          {row.error ? <span className="text-destructive">{row.error}</span> : row.note ?? '—'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={mutation.isPending || checking || readyRows.length === 0 || readyRows.length !== validRows.length}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            提交 {readyRows.length} 条入账
          </Button>
          {validRows.length > 0 && readyRows.length !== validRows.length && (
            <span className="text-xs text-destructive">请先核对成员并处理同名选择</span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LedgerEntryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const principal = usePrincipal();
  const principalId = principal?.principalId ?? null;
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    userId: '',
    sourceKey: '',
    category: 'activity',
    amount: '',
    scoreMonth: currentMonthKey(),
    detail: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ entryId: string; deduplicated: boolean }>(
        '/admin/ledger-entries',
        {
          userId: form.userId.trim(),
          sourceKey: form.sourceKey.trim(),
          category: form.category,
          amount: form.amount.trim(),
          scoreMonth: form.scoreMonth,
          ...(form.detail.trim() ? { detail: { note: form.detail.trim() } } : {}),
        },
      );
      return data;
    },
    onSuccess: (result) => {
      setNotice(
        result.deduplicated
          ? '该 sourceKey 已有生效记录，幂等返回原条目（未重复入账）。'
          : '已入账。',
      );
      setError(null);
      if (principalId) {
        void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin'] });
      }
    },
    onError: (cause: ApiError) => {
      setError(cause.message);
      setNotice(null);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>积分入账</DialogTitle>
          <DialogDescription>
            sourceKey 为稳定逻辑键（不含活动/地点/规则版本）：同一来源只允许一条生效记录，
            重复提交幂等返回原条目，不静默覆盖。
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {notice && (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="entry-user">成员 userId（UUID）</Label>
            <Input
              id="entry-user"
              value={form.userId}
              onChange={(event) => setForm({ ...form, userId: event.target.value })}
              required
            />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="entry-source">sourceKey</Label>
            <Input
              id="entry-source"
              value={form.sourceKey}
              onChange={(event) => setForm({ ...form, sourceKey: event.target.value })}
              placeholder="如 activity:<activityId>:<userId>"
              required
              minLength={3}
              maxLength={200}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>类别</Label>
            <Select
              value={form.category}
              onValueChange={(value) => setForm({ ...form, category: value })}
            >
              <SelectTrigger aria-label="类别">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="contest">比赛</SelectItem>
                <SelectItem value="remote_contest">远程比赛</SelectItem>
                <SelectItem value="activity">活动</SelectItem>
                <SelectItem value="contribution">贡献</SelectItem>
                <SelectItem value="service">服务</SelectItem>
                <SelectItem value="award">奖项</SelectItem>
                <SelectItem value="initial">初始</SelectItem>
                <SelectItem value="penalty">扣分</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="entry-amount">分值（带符号十进制字符串）</Label>
            <Input
              id="entry-amount"
              value={form.amount}
              onChange={(event) => setForm({ ...form, amount: event.target.value })}
              placeholder="2 / 1.5 / -4"
              required
              pattern="-?\d+(\.\d+)?"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="entry-month">记分月份</Label>
            <Input
              id="entry-month"
              type="month"
              value={form.scoreMonth}
              onChange={(event) => setForm({ ...form, scoreMonth: event.target.value })}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="entry-detail">备注（可选）</Label>
            <Input
              id="entry-detail"
              value={form.detail}
              onChange={(event) => setForm({ ...form, detail: event.target.value })}
              maxLength={200}
            />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
              入账
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MonthlyBatchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [month, setMonth] = useState(currentMonthKey());
  const [result, setResult] = useState<{
    batchId: string;
    blocked: boolean;
    blockedReason?: string;
    users: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reverseId, setReverseId] = useState('');
  const [reverseReason, setReverseReason] = useState('');
  const [reverseAmount, setReverseAmount] = useState('');
  const [reverseNotice, setReverseNotice] = useState<string | null>(null);

  const batchMutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{
        batchId: string;
        blocked: boolean;
        blockedReason?: string;
        users: number;
      }>('/admin/scoring-batches', { month });
      return data;
    },
    onSuccess: (data) => {
      setResult(data);
      setError(null);
    },
    onError: (cause: ApiError) => setError(cause.message),
  });

  const reverseMutation = useMutation({
    mutationFn: async () => {
      await api.post(`/admin/ledger-entries/${reverseId.trim()}/reverse`, {
        reason: reverseReason.trim(),
        ...(reverseAmount.trim() ? { replacementAmount: reverseAmount.trim() } : {}),
      });
      return true;
    },
    onSuccess: () => {
      setReverseNotice('已冲正（如填写替代分值则同时生成替代条目）。');
      setReverseId('');
      setReverseReason('');
      setReverseAmount('');
    },
    onError: (cause: ApiError) => setReverseNotice(cause.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>月度结算批次与冲正</DialogTitle>
          <DialogDescription>
            生成月度批次预览；R01 取整口径未确认时正式发布被阻塞。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="batch-month">月份</Label>
            <Input
              id="batch-month"
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
            />
          </div>
          <Button
            disabled={batchMutation.isPending || !month}
            onClick={() => batchMutation.mutate()}
          >
            {batchMutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            生成预览
          </Button>
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {result && (
          <Alert variant={result.blocked ? 'destructive' : 'info'}>
            <AlertTitle>{result.blocked ? '正式发布被阻塞' : '批次已生成'}</AlertTitle>
            <AlertDescription>
              批次 {result.batchId.slice(0, 8)} · 覆盖 {result.users} 人
              {result.blocked ? `；原因：${result.blockedReason ?? 'R01 取整口径未确认'}` : '（预览态，不发布正式 M）。'}
            </AlertDescription>
          </Alert>
        )}

        <div className="border-t border-border pt-3">
          <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            <RotateCcwIcon className="size-4 text-input" aria-hidden="true" />
            冲正流水
          </h4>
          {reverseNotice && (
            <Alert className="mb-2">
              <AlertDescription>{reverseNotice}</AlertDescription>
            </Alert>
          )}
          <form
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              reverseMutation.mutate();
            }}
          >
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="reverse-id">原流水 ID（UUID）</Label>
              <Input
                id="reverse-id"
                value={reverseId}
                onChange={(event) => setReverseId(event.target.value)}
                required
              />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="reverse-reason">冲正原因（3-500 字）</Label>
              <Input
                id="reverse-reason"
                value={reverseReason}
                onChange={(event) => setReverseReason(event.target.value)}
                required
                minLength={3}
                maxLength={500}
              />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="reverse-amount">替代分值（可选）</Label>
              <Input
                id="reverse-amount"
                value={reverseAmount}
                onChange={(event) => setReverseAmount(event.target.value)}
                placeholder="留空只冲正；填写则同时生成替代条目"
                pattern="-?\d+(\.\d+)?"
              />
            </div>
            <div className="sm:col-span-2">
              <Button
                type="submit"
                disabled={
                  reverseMutation.isPending ||
                  reverseId.trim().length < 8 ||
                  reverseReason.trim().length < 3
                }
              >
                {reverseMutation.isPending && (
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                )}
                冲正
              </Button>
            </div>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">
            冲正不改历史：保留原记录并生成负值条目。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DisclosureDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [month, setMonth] = useState(currentMonthKey());
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      await api.post('/admin/disclosures', {
        month,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
      });
      return true;
    },
    onSuccess: () => {
      setNotice('公示已发布；快照行与 revision 已固化。');
      setError(null);
    },
    onError: (cause: ApiError) => {
      setError(cause.message);
      setNotice(null);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>发布月度公示</DialogTitle>
          <DialogDescription>公示期原则上至少 48 小时；期间成员可发起申诉。</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertTitle>发布失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {notice && (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        <form
          className="grid grid-cols-1 gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="disclosure-month">月份</Label>
            <Input
              id="disclosure-month"
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="disclosure-start">开始时间</Label>
            <Input
              id="disclosure-start"
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="disclosure-end">结束时间（≥48 小时）</Label>
            <Input
              id="disclosure-end"
              type="datetime-local"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
              required
            />
          </div>
          <Button
            type="submit"
            disabled={mutation.isPending || !month || !startsAt || !endsAt}
          >
            {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            发布公示
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
