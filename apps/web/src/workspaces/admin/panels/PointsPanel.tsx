/**
 * 管理端 · 积分审核（points.review / points.propose / claims.review）。
 * - 审核队列 GET /admin/reviews（cases / claims / appeals 三 Tab，宽屏左右分栏队列+详情）；
 * - claims 决定 POST /admin/claims/:id/decision（涉及本人返回 reason 显示回避）；
 * - 复核投票 POST /admin/reviews/:id/votes；
 * - 入账 POST /admin/ledger-entries（sourceKey 幂等）；冲正 POST /admin/ledger-entries/:id/reverse；
 * - 月度批次 POST /admin/scoring-batches（blocked=R01 提示）；
 * - 公示 POST /admin/disclosures（48h 校验错误显示）+ GET /admin/disclosures 列表。
 */
import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpenIcon, ClipboardListIcon, CoinsIcon, LoaderCircleIcon, RotateCcwIcon } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrincipal } from '@/lib/session';
import { currentMonthKey, formatDateTime } from '@/lib/format';
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
  assets: Array<{ assetId: string }>;
  user: { verifiedRealName: string | null; studentNo: string | null } | null;
}

/** 佐证图读取入口：thumb 供列表缩略，full 为原图（已剥除 EXIF/GPS） */
function evidenceUrl(assetId: string, size: 'thumb' | 'full'): string {
  return `/api/v1/me/claim-evidence/${assetId}?size=${size}`;
}

interface AppealDto {
  id: string;
  subject: string;
  materials: string | null;
  status: string;
  createdAt: string;
  user: { verifiedRealName: string | null; studentNo: string | null } | null;
}

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

export default function PointsPanel() {
  const principal = usePrincipal();
  return (
    <PrincipalGate principal={principal}>
      {(principalId) => <PointsBody principalId={principalId} />}
    </PrincipalGate>
  );
}

function PointsBody({ principalId }: { principalId: string }) {
  const [tab, setTab] = useState('claims');
  const [entryOpen, setEntryOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchImportOpen, setBatchImportOpen] = useState(false);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const queryClient = useQueryClient();
  const [queueNotice, setQueueNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const queueQuery = usePrivateQuery<
    { cases: ReviewCaseDto[]; claims: ClaimDto[]; appeals: AppealDto[] },
    ApiError
  >(principalId, ['admin', 'reviews', 'queue'], async () => {
    const { data } = await api.get<{ cases: ReviewCaseDto[]; claims: ClaimDto[]; appeals: AppealDto[] }>(
      '/admin/reviews',
    );
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
  }, [principalId, queryClient]);

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="积分审核"
        description="贡献申报、申诉与复核案件；入账/冲正与月度公示。"
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
            <TabsList aria-label="审核队列">
              <TabsTrigger value="claims">贡献申报（{queue.claims.length}）</TabsTrigger>
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
            <TabsContent value="appeals" className="mt-4">
              <AppealsQueue appeals={queue.appeals} />
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
    mutationFn: async (decision: 'approve' | 'reject' | 'more_info') => {
      const { data } = await api.post<{ decided: boolean; reason?: string }>(
        `/admin/claims/${selectedId}/decision`,
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
      onNotice({ tone: 'info', text: '申报已处理；通过且填写分值时已同时入账。' });
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
                onClick={() => mutation.mutate('approve')}
              >
                {mutation.isPending && mutation.variables === 'approve' && (
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                )}
                通过{amount ? '并入账' : ''}
              </Button>
              <Button size="sm" variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate('reject')}>
                驳回
              </Button>
              <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => mutation.mutate('more_info')}>
                要求补充材料
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              涉及本人的申报接口会返回回避提示；通过并填分值时以
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

function AppealsQueue({ appeals }: { appeals: AppealDto[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (appeals.length === 0) {
    return <EmptyState kind="empty" description="没有待处理的申诉。" />;
  }
  const selected = appeals.find((appeal) => appeal.id === selectedId) ?? appeals[0] ?? null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardContent className="p-0">
          <ul className="flex flex-col divide-y divide-border">
            {appeals.map((appeal) => (
              <li key={appeal.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(appeal.id)}
                  className={`flex w-full flex-col gap-1 p-4 text-left hover:bg-muted/40 ${
                    appeal.id === selected?.id ? 'bg-info-subtle' : ''
                  }`}
                >
                  <span className="text-sm font-medium text-foreground">{appeal.subject}</span>
                  <span className="text-xs text-muted-foreground">
                    {appeal.user?.verifiedRealName ?? '—'} · {appeal.user?.studentNo ?? '—'} ·{' '}
                    {formatDateTime(appeal.createdAt)}
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
            <h3 className="text-sm font-semibold text-foreground">{selected.subject}</h3>
            <p className="text-sm leading-[22px] whitespace-pre-wrap text-foreground/90">
              {selected.materials ?? '（未附材料说明）'}
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              申诉处理流程：核对流水与出勤记录 → 需要更正时通过「入账 / 冲正」落账（保留审计
              痕迹）→ 结论在公示期结束前告知申诉人。涉及本人积分时必须回避。
            </p>
          </CardContent>
        </Card>
      )}
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
    mutationFn: async (verdict: 'approve' | 'reject' | 'more_info') => {
      const { data } = await api.post<{ resolved: boolean; approvals: number }>(
        `/admin/reviews/${selectedId ?? cases[0]?.id}/votes`,
        { verdict, reason: reason.trim() },
      );
      return data;
    },
    onSuccess: (result) => {
      onNotice({
        tone: 'info',
        text: result.resolved
          ? '投票完成；案件已按双人复核规则结案。'
          : `投票已记录（当前不同通过人 ${result.approvals}/2）。`,
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
                onClick={() => mutation.mutate('approve')}
              >
                同意
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={mutation.isPending || reason.trim().length < 3}
                onClick={() => mutation.mutate('reject')}
              >
                不同意
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={mutation.isPending || reason.trim().length < 3}
                onClick={() => mutation.mutate('more_info')}
              >
                需补充信息
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              两名不同负责人同意即结案；涉及本人或重复投票会被拒绝（RECUSED / DOUBLE_VOTE）。
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface ParsedBatchRow {
  studentNo: string;
  amount: string;
  note?: string;
  error?: string;
}

/** 解析粘贴/CSV 行：`学号 分数 备注`，分隔符支持逗号（中英）、Tab、空白 */
function parseBatchRows(text: string): ParsedBatchRow[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 200)
    .map((line) => {
      const parts = line.split(/[\t,，;；]+|\s+/).filter((part) => part !== '');
      const studentNo = parts[0] ?? '';
      const amount = parts[1] ?? '';
      const note = parts.slice(2).join(' ') || undefined;
      if (studentNo.length < 3) return { studentNo, amount, note, error: '学号无效' };
      if (!/^-?\d+(\.\d+)?$/.test(amount)) return { studentNo, amount, note, error: '分数需为十进制数字（可负）' };
      return { studentNo, amount, note };
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

  const mutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ batchId: string; posted: number; deduplicated: number; failed: Array<{ studentNo: string; error: string }> }>(
        '/admin/ledger-entries/batch',
        {
          rows: validRows.map((row) => ({ studentNo: row.studentNo, amount: row.amount, note: row.note })),
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
            每行一条：`学号 分数 备注`（分隔符支持逗号 / Tab / 空格，最多 200 行）；
            关联活动后成员端活动详情会显示本次积分。同一批次内按学号幂等，重复提交整批不重复入账。
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
          <Label htmlFor="batch-raw">粘贴名单（学号 分数 备注）</Label>
          <Textarea
            id="batch-raw"
            value={rawText}
            onChange={(event) => {
              setRawText(event.target.value);
              setResult(null);
            }}
            rows={6}
            placeholder={'202600001 12 周赛到场\n202600002 8.5 周赛到场'}
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
          {parsed.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow className="h-8">
                    <TableHead className="pl-3 text-xs">学号</TableHead>
                    <TableHead className="text-xs">分数</TableHead>
                    <TableHead className="pr-3 text-xs">备注 / 问题</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsed.map((row, index) => (
                    <TableRow key={index} className={row.error ? 'bg-destructive-subtle/40' : undefined}>
                      <TableCell className="py-1.5 pl-3 text-xs tabular-nums">{row.studentNo}</TableCell>
                      <TableCell className="py-1.5 text-xs tabular-nums">{row.amount}</TableCell>
                      <TableCell className="py-1.5 pr-3 text-xs text-muted-foreground">
                        {row.error ? <span className="text-destructive">{row.error}</span> : row.note ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
        <Button
          disabled={mutation.isPending || validRows.length === 0}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
          提交 {validRows.length} 条入账
        </Button>
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
            冲正不改历史：保留原记录并生成负值条目；不能冲正本人积分（利益回避）。
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
