/**
 * 成员端 · 积分：GET /me/points/overview + GET /me/points?month=&cursor=。
 * 上半 E 主卡 + 六个月构成（SVG 柱图 + 等价数据表）；下半流水表（含冲正标记）；
 * 申诉入口 POST /me/appeals。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRightIcon,
  ExternalLinkIcon,
  FileTextIcon,
  LoaderCircleIcon,
  ScaleIcon,
  TrendingDownIcon,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrivateInfiniteQuery } from '@/lib/private-infinite';
import { usePrincipal } from '@/lib/session';
import { LoadMoreButton } from '@/lib/hooks';
import {
  activityTypeLabel,
  currentMonthKey,
  formatDateTime,
  formatSignedAmount,
  ledgerStatusBadge,
  monthLabel,
  platformLabel,
} from '@/lib/format';
import { PanelHeader } from '@/components/club/PanelHeader';
import { MemberGate, QueryBoundary } from '@/components/club/QueryBoundary';
import { MonthBars } from '@/components/club/MonthBars';
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
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResponsiveDetail } from '@/components/club/ResponsiveDetail';

interface PointsOverviewDto {
  e: string;
  eComponents: Array<{ month: string; m: number; weight: number; contribution: number }>;
  /** raw 为当月积分（不含入社基础分），initial 为该月计入的入社基础分 */
  months: Array<{ month: string; raw: number; initial?: number; m: number | null }>;
  /** 入社基础分（第八条）：单独展示，按计入月份的权重计入 E */
  initial?: InitialPointsDto | null;
  roundingPending: boolean;
  roundingNote: string | null;
}

interface InitialPointsDto {
  amount: number;
  month: string;
  weight: number;
  contribution: number;
}

interface LedgerEntryDto {
  id: string;
  sourceKey: string;
  category: string;
  amount: string;
  scoreMonth: string;
  recordedAt: string;
  status: string;
  ruleVersionId: string | null;
  reversesEntryId: string | null;
  replacedByEntryId: string | null;
  reversalReason: string | null;
  detail: Record<string, unknown> | null;
  eventName?: string;
  eventTime?: string | null;
  eventKind?: 'activity' | 'competition' | 'claim' | 'reversal' | 'initial' | 'manual';
  eventLink?: string | null;
  eventMeta?: Record<string, unknown> | null;
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

interface MyAppealDto {
  id: string;
  ledgerEntryId: string | null;
  ledgerEntry: AppealLedgerSummaryDto | null;
  subject: string;
  materials: string | null;
  status: string;
  resolutionNote: string | null;
  createdAt: string;
  closedAt: string | null;
}

const APPEAL_STATUS_LABELS: Record<string, string> = {
  submitted: '已提交',
  in_review: '受理中',
  resolved: '已采纳结案',
  rejected: '已驳回',
};

const CATEGORY_LABELS: Record<string, string> = {
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

export default function PointsPanel() {
  const principal = usePrincipal();
  return (
    <MemberGate principal={principal}>
      {(principalId) => <PointsBody principalId={principalId} />}
    </MemberGate>
  );
}

function PointsBody({ principalId }: { principalId: string }) {
  const [monthFilter, setMonthFilter] = useState<string>('all');
  const [appealOpen, setAppealOpen] = useState(false);
  const [appealPreset, setAppealPreset] = useState<{ entry?: LedgerEntryDto; ledgerEntryId?: string; subject?: string } | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<LedgerEntryDto | null>(null);

  const overviewQuery = usePrivateQuery<PointsOverviewDto, ApiError>(
    principalId,
    ['me', 'points', 'overview'],
    async () => (await api.get<PointsOverviewDto>('/me/points/overview')).data,
  );

  const ledgerQuery = usePrivateInfiniteQuery<
    { items: LedgerEntryDto[]; nextCursor?: string | null },
    ApiError
  >(
    principalId,
    ['me', 'points', 'ledger', monthFilter],
    async (cursor) => {
      const params = new URLSearchParams();
      if (monthFilter !== 'all') params.set('month', monthFilter);
      if (cursor) params.set('cursor', cursor);
      const { data } = await api.get<{ items: LedgerEntryDto[]; nextCursor?: string | null }>(
        `/me/points?${params.toString()}`,
      );
      return data;
    },
  );

  const entries = ledgerQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const monthOptions = useMemo(() => {
    const months = new Set<string>((overviewQuery.data?.months ?? []).map((m) => m.month));
    for (const entry of entries) months.add(entry.scoreMonth);
    months.add(currentMonthKey());
    return [...months].sort().reverse();
  }, [overviewQuery.data, entries]);

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="积分"
        description="有效积分 E、月度构成与逐笔流水；对认定结果有疑问可发起申诉。"
        actions={
          <Button
            variant="outline"
            onClick={() => {
              setAppealPreset(null);
              setAppealOpen(true);
            }}
          >
            <ScaleIcon aria-hidden="true" />
            发起申诉
          </Button>
        }
      />

      <QueryBoundary query={overviewQuery}>
        {(overview) => (
          <>
            {overview.roundingPending && (
              <Alert>
                <AlertTitle>正式月结算待 R01 口径确认，当前为预览</AlertTitle>
                <AlertDescription>
                  {overview.roundingNote ?? 'M 取整策略未确认前，月度 M 不发布正式值。'}
                </AlertDescription>
              </Alert>
            )}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <div className="flex flex-col gap-4 lg:col-span-4">
                <Card>
                  <CardContent className="flex flex-col gap-2 p-5">
                    <p className="text-sm text-muted-foreground">有效积分 E</p>
                    <p className="text-[40px] leading-[48px] font-semibold tracking-tight text-foreground tabular-nums">
                      {overview.e}
                    </p>
                    <p className="text-xs leading-5 text-muted-foreground">
                      近六个月 M 按当月 ×1、往前 ×0.85 / ×0.7 / ×0.55 / ×0.4 / ×0.25 加权求和{overview.initial ? '（含入社基础分）' : ''}。
                    </p>
                    <NextMonthDecayHint components={overview.eComponents} currentE={Number(overview.e)} />
                  </CardContent>
                </Card>
                {overview.initial && <InitialPointsCard initial={overview.initial} />}
              </div>
              <CompositionCard overview={overview} className="lg:col-span-8" />
            </div>
          </>
        )}
      </QueryBoundary>

      <Card>
        <CardContent className="flex flex-col gap-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">积分流水</h2>
            <Select value={monthFilter} onValueChange={setMonthFilter}>
              <SelectTrigger className="w-40" aria-label="按月份筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部月份</SelectItem>
                {monthOptions.map((month) => (
                  <SelectItem key={month} value={month}>
                    {month}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {ledgerQuery.isPending ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} className="h-12" />
              ))}
            </div>
          ) : ledgerQuery.isError ? (
            <div className="py-6 text-center">
              <p className="text-sm text-muted-foreground">{ledgerQuery.error.message}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void ledgerQuery.refetch()}
              >
                重试
              </Button>
            </div>
          ) : entries.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              还没有积分流水；参加活动、比赛或提交贡献申报后会出现记录。
            </p>
          ) : (
            <>
              <LedgerTable entries={entries} onSelect={setSelectedEntry} />
              <LoadMoreButton
                onClick={() => {
                  void ledgerQuery.fetchNextPage();
                }}
                loading={ledgerQuery.isFetchingNextPage}
                hasNext={Boolean(ledgerQuery.data?.pages.at(-1)?.nextCursor)}
                hint="已展示全部流水"
              />
            </>
          )}
        </CardContent>
      </Card>

      <MyAppealsCard
        principalId={principalId}
        onNewAppeal={() => {
          setAppealPreset(null);
          setAppealOpen(true);
        }}
      />

      <LedgerDetailDrawer
        entry={selectedEntry}
        onOpenChange={(open) => {
          if (!open) setSelectedEntry(null);
        }}
        onAppeal={(entry) => {
          const name = displayEventName(entry);
          setSelectedEntry(null);
          setAppealPreset({
            entry,
            ledgerEntryId: entry.id,
            subject: `对「${name}」（${entry.scoreMonth}，${formatSignedAmount(entry.amount)} 分）积分有疑问`,
          });
          setAppealOpen(true);
        }}
      />

      <AppealDrawer
        principalId={principalId}
        open={appealOpen}
        preset={appealPreset}
        onOpenChange={(next) => {
          setAppealOpen(next);
          if (!next) setAppealPreset(null);
        }}
      />
    </div>
  );
}

/** 下月衰减预览：按 6 个月权重顺移一格，预估下月基础 E 与自然衰减量 */
function NextMonthDecayHint({
  components,
  currentE,
}: {
  components: PointsOverviewDto['eComponents'];
  currentE: number;
}) {
  if (components.length === 0 || Number.isNaN(currentE)) return null;
  const shiftedWeights = [0.85, 0.7, 0.55, 0.4, 0.25, 0];
  // components 按月份倒序或正序均可，按 month 降序排列确保最新月对应 0.85
  const ordered = [...components].sort((a, b) => b.month.localeCompare(a.month));
  const nextBaseE = ordered.reduce((sum, item, index) => sum + item.m * (shiftedWeights[index] ?? 0), 0);
  const delta = nextBaseE - currentE;
  return (
    <div className="mt-1 flex items-start gap-2 rounded-xl bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground">
      <TrendingDownIcon className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
      <span>
        下月换月基线约 <strong className="font-semibold text-foreground tabular-nums">{nextBaseE.toFixed(1)}</strong>
        {delta < -0.05 ? (
          <>
            （自然衰减 <span className="tabular-nums">{Math.abs(delta).toFixed(1)}</span> 分，下月新获同等积分即可保持当前排名水位）
          </>
        ) : (
          '（下月暂无明显自然衰减）'
        )}
      </span>
    </div>
  );
}

function MyAppealsCard({
  principalId,
  onNewAppeal,
}: {
  principalId: string;
  onNewAppeal: () => void;
}) {
  const appealsQuery = usePrivateQuery<MyAppealDto[], ApiError>(
    principalId,
    ['me', 'appeals'],
    async () => (await api.get<MyAppealDto[]>('/me/appeals')).data,
  );
  const items = appealsQuery.data ?? [];
  if (appealsQuery.isPending || appealsQuery.isError) return null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">我的申诉记录</h2>
            <p className="text-xs text-muted-foreground">查看提交过的积分申诉与负责人处理回复。</p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={onNewAppeal}>
            <ScaleIcon aria-hidden="true" />
            发起新申诉
          </Button>
        </div>
        {items.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted-foreground">暂无申诉记录。</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {items.map((appeal) => (
              <li key={appeal.id} className="flex flex-col gap-1.5 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{appeal.subject}</span>
                  <StatusBadge
                    kind="disclosure"
                    value={
                      appeal.status === 'resolved'
                        ? '已批准'
                        : appeal.status === 'rejected'
                          ? '已驳回'
                          : appeal.status === 'in_review'
                            ? '待审核'
                            : '待审批'
                    }
                  />
                </div>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {APPEAL_STATUS_LABELS[appeal.status] ?? appeal.status} · 提交于 {formatDateTime(appeal.createdAt)}
                  {appeal.closedAt ? ` · 结案于 ${formatDateTime(appeal.closedAt)}` : ''}
                </p>
                {appeal.ledgerEntry && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-2.5 py-1.5 text-xs">
                    <span className="text-muted-foreground">关联流水：</span>
                    <span className="font-medium text-foreground">{appeal.ledgerEntry.eventName}</span>
                    <span className="text-muted-foreground tabular-nums">{appeal.ledgerEntry.scoreMonth}</span>
                    <span
                      className={`font-semibold tabular-nums ${
                        Number(appeal.ledgerEntry.amount) < 0 ? 'text-destructive' : 'text-foreground'
                      }`}
                    >
                      {formatSignedAmount(appeal.ledgerEntry.amount)}
                    </span>
                    <StatusBadge kind="points" value={ledgerStatusBadge(appeal.ledgerEntry.status)} />
                    {appeal.ledgerEntry.replacementAmount != null && (
                      <span className="text-primary tabular-nums">
                        已替换为 {formatSignedAmount(appeal.ledgerEntry.replacementAmount)}
                      </span>
                    )}
                  </div>
                )}
                {appeal.resolutionNote && (
                  <div className="rounded-xl bg-muted/50 px-3 py-2 text-xs leading-5 text-foreground">
                    <span className="font-medium text-muted-foreground">处理回复：</span>
                    {appeal.resolutionNote}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** 入社基础分卡：不并入「当月积分」，单独显示分值、计入月份与当前计入 E 的部分 */
function InitialPointsCard({ initial }: { initial: InitialPointsDto }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1.5 p-5">
        <p className="text-sm text-muted-foreground">入社基础分</p>
        <p className="text-[28px] leading-9 font-semibold text-foreground tabular-nums">{initial.amount.toFixed(2)}</p>
        <p className="text-xs leading-5 text-muted-foreground">
          {initial.weight > 0
            ? `${monthLabel(initial.month)}入社时一次性获得，按该月权重 ×${initial.weight} 计入 E：${initial.contribution.toFixed(2)}，之后逐月衰减。`
            : `${monthLabel(initial.month)}入社时一次性获得，已超出近六个月，不再计入 E。`}
        </p>
      </CardContent>
    </Card>
  );
}

function CompositionCard({
  overview,
  className,
}: {
  overview: PointsOverviewDto;
  className?: string;
}) {
  const [showTable, setShowTable] = useState(false);
  const hasInitial = overview.months.some((row) => row.initial);
  return (
    <Card className={className}>
      <CardContent className="flex h-full flex-col gap-3 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">六个月积分构成</h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={showTable}
            onClick={() => setShowTable((value) => !value)}
          >
            {showTable ? '显示柱图' : '显示数据表'}
          </Button>
        </div>
        {overview.eComponents.length === 0 ? (
          <p className="text-sm leading-[22px] text-muted-foreground">尚无积分记录。</p>
        ) : showTable ? (
          <table className="w-full text-sm">
            <caption className="sr-only">六个月积分构成等价数据表</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 font-medium">月份</th>
                <th scope="col" className="py-2 text-right font-medium">当月积分</th>
                {hasInitial && <th scope="col" className="py-2 text-right font-medium">入社基础分</th>}
                <th scope="col" className="py-2 text-right font-medium">系数</th>
                <th scope="col" className="py-2 text-right font-medium">计入 E</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {overview.months.map((row) => {
                const component = overview.eComponents.find((c) => c.month === row.month);
                return (
                  <tr key={row.month}>
                    <td className="py-2">{monthLabel(row.month)}</td>
                    <td className="py-2 text-right tabular-nums">{row.raw}</td>
                    {hasInitial && <td className="py-2 text-right tabular-nums text-muted-foreground">{row.initial ? row.initial : '—'}</td>}
                    <td className="py-2 text-right text-muted-foreground tabular-nums">
                      {component ? `×${component.weight}` : '—'}
                    </td>
                    <td className="py-2 text-right font-medium tabular-nums">
                      {component ? component.contribution : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <>
            <MonthBars
              data={overview.months.map((m) => ({
                month: m.month,
                raw: m.raw,
                weight: overview.eComponents.find((c) => c.month === m.month)?.weight ?? null,
              }))}
              ariaLabel="六个月积分构成柱状图"
            />
            <p className="text-xs leading-5 text-muted-foreground">
              正式月度 M 待 R01 取整口径确认；柱图为各月积分（不含入社基础分），月下系数为有效权重。
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function displayEventName(entry: LedgerEntryDto): string {
  if (entry.eventName && entry.eventName.trim().length > 0) return entry.eventName;
  const d = entry.detail;
  const fromDetail =
    (typeof d?.activityTitle === 'string' && d.activityTitle.trim()) ||
    (typeof d?.eventTitle === 'string' && d.eventTitle.trim()) ||
    (typeof d?.title === 'string' && d.title.trim()) ||
    (typeof d?.note === 'string' && d.note.trim());
  if (fromDetail) return fromDetail;
  if (entry.category === 'initial') return `入社基础分（${entry.scoreMonth}）`;
  return `${CATEGORY_LABELS[entry.category] ?? entry.category}（${entry.scoreMonth}）`;
}

function eventLinkLabel(kind: LedgerEntryDto['eventKind']): string {
  if (kind === 'activity') return '查看对应活动';
  if (kind === 'competition') return '查看对应赛事';
  if (kind === 'claim') return '查看贡献申报';
  return '查看对应内容';
}

function LedgerTable({
  entries,
  onSelect,
}: {
  entries: LedgerEntryDto[];
  onSelect: (entry: LedgerEntryDto) => void;
}) {
  return (
    <>
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>月份</TableHead>
              <TableHead>事件名称</TableHead>
              <TableHead>类别</TableHead>
              <TableHead className="text-right">分值</TableHead>
              <TableHead>记录时间</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="w-20 text-right">详情</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => {
              const name = displayEventName(entry);
              return (
                <TableRow
                  key={entry.id}
                  onClick={() => onSelect(entry)}
                  className="cursor-pointer transition-colors hover:bg-muted/40"
                >
                  <TableCell className="tabular-nums">{entry.scoreMonth}</TableCell>
                  <TableCell className="max-w-72" title={name}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(entry);
                      }}
                      className="group flex max-w-full items-center gap-1.5 text-left font-medium text-foreground hover:text-primary"
                    >
                      <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground group-hover:text-primary" aria-hidden="true" />
                      <span className="truncate">{name}</span>
                    </button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {CATEGORY_LABELS[entry.category] ?? entry.category}
                  </TableCell>
                  <TableCell
                    className={`text-right font-medium tabular-nums ${
                      Number(entry.amount) < 0 ? 'text-destructive' : 'text-foreground'
                    }`}
                  >
                    {formatSignedAmount(entry.amount)}
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {formatDateTime(entry.recordedAt)}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <StatusBadge kind="points" value={ledgerStatusBadge(entry.status)} />
                      {entry.reversesEntryId && (
                        <span className="text-xs text-muted-foreground">冲正历史记录</span>
                      )}
                      {entry.replacedByEntryId && (
                        <span className="text-xs text-muted-foreground">已被替代</span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(entry);
                      }}
                    >
                      查看
                      <ChevronRightIcon className="size-3.5" aria-hidden="true" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col divide-y divide-border md:hidden">
        {entries.map((entry) => {
          const name = displayEventName(entry);
          return (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => onSelect(entry)}
                className="flex w-full flex-col gap-1 py-3 text-left transition-colors hover:bg-muted/30"
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{name}</span>
                  <span
                    className={`shrink-0 text-sm font-semibold tabular-nums ${
                      Number(entry.amount) < 0 ? 'text-destructive' : 'text-foreground'
                    }`}
                  >
                    {formatSignedAmount(entry.amount)}
                  </span>
                </span>
                <span className="flex flex-wrap items-center justify-between gap-1.5 text-xs text-muted-foreground">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge kind="points" value={ledgerStatusBadge(entry.status)} />
                    <span>{CATEGORY_LABELS[entry.category] ?? entry.category}</span>
                    <span className="tabular-nums">{entry.scoreMonth}</span>
                    {entry.reversesEntryId && <span>冲正</span>}
                  </span>
                  <span className="inline-flex items-center gap-0.5 text-primary">
                    查看详情
                    <ChevronRightIcon className="size-3.5" aria-hidden="true" />
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** 积分流水详情抽屉：展示事件完整信息、竞赛计分公式、关联活动/贡献说明与快捷跳转/申诉入口 */
function LedgerDetailDrawer({
  entry,
  onOpenChange,
  onAppeal,
}: {
  entry: LedgerEntryDto | null;
  onOpenChange: (open: boolean) => void;
  onAppeal: (entry: LedgerEntryDto) => void;
}) {
  const navigate = useNavigate();
  if (!entry) return null;

  const name = displayEventName(entry);
  const detail = entry.detail ?? {};
  const meta = entry.eventMeta ?? {};
  const formula =
    detail.formula && typeof detail.formula === 'object' && !Array.isArray(detail.formula)
      ? (detail.formula as Record<string, unknown>)
      : null;
  const note = typeof detail.note === 'string' && detail.note.trim() ? detail.note.trim() : null;
  const bonusLabel = typeof detail.bonusLabel === 'string' && detail.bonusLabel.trim() ? detail.bonusLabel.trim() : null;
  const teamName =
    (typeof meta.teamName === 'string' && meta.teamName.trim()) ||
    (typeof detail.teamName === 'string' && detail.teamName.trim()) ||
    null;
  const awardText =
    (typeof meta.awardText === 'string' && meta.awardText.trim()) ||
    (typeof detail.awardText === 'string' && detail.awardText.trim()) ||
    null;
  const rankText =
    (typeof meta.rankText === 'string' && meta.rankText.trim()) ||
    (typeof detail.rankText === 'string' && detail.rankText.trim()) ||
    null;
  const venue = typeof meta.venue === 'string' && meta.venue.trim() ? meta.venue.trim() : null;
  const activityType = typeof meta.activityType === 'string' ? meta.activityType : null;
  const platform =
    (typeof meta.platform === 'string' && meta.platform) ||
    (typeof detail.platform === 'string' && detail.platform) ||
    null;
  const claimDesc = typeof meta.description === 'string' && meta.description.trim() ? meta.description.trim() : null;
  const claimReviewNote = typeof meta.reviewNote === 'string' && meta.reviewNote.trim() ? meta.reviewNote.trim() : null;
  const reversalReason =
    entry.reversalReason ??
    (typeof meta.reversalReason === 'string' ? meta.reversalReason : null) ??
    (typeof detail.reason === 'string' ? detail.reason : null);
  const originalTitle = typeof meta.originalTitle === 'string' ? meta.originalTitle : null;

  return (
    <ResponsiveDetail
      open={Boolean(entry)}
      onOpenChange={onOpenChange}
      title={name}
      description={`${CATEGORY_LABELS[entry.category] ?? entry.category} · 计入 ${entry.scoreMonth}`}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onAppeal(entry)}
          >
            <ScaleIcon aria-hidden="true" />
            对此笔积分申诉
          </Button>
          {entry.eventLink && (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                const target = entry.eventLink!;
                onOpenChange(false);
                navigate(target);
              }}
            >
              <ExternalLinkIcon aria-hidden="true" />
              {eventLinkLabel(entry.eventKind)}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between rounded-xl border border-border bg-muted/30 p-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">变动分值</span>
            <span
              className={`text-2xl font-semibold tabular-nums ${
                Number(entry.amount) < 0 ? 'text-destructive' : 'text-foreground'
              }`}
            >
              {formatSignedAmount(entry.amount)}
            </span>
          </div>
          <div className="flex flex-col items-end gap-1">
            <StatusBadge kind="points" value={ledgerStatusBadge(entry.status)} />
            <span className="text-xs text-muted-foreground tabular-nums">
              计入月份 {entry.scoreMonth}
            </span>
          </div>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">事件类别</dt>
          <dd className="text-foreground">
            {CATEGORY_LABELS[entry.category] ?? entry.category}
            {activityType ? ` · ${activityTypeLabel(activityType)}` : ''}
            {bonusLabel ? ` · ${bonusLabel}` : ''}
          </dd>
          {entry.eventTime && (
            <>
              <dt className="text-muted-foreground">事件时间</dt>
              <dd className="text-foreground tabular-nums">{formatDateTime(entry.eventTime)}</dd>
            </>
          )}
          <dt className="text-muted-foreground">入账时间</dt>
          <dd className="text-foreground tabular-nums">{formatDateTime(entry.recordedAt)}</dd>
          {venue && (
            <>
              <dt className="text-muted-foreground">活动地点</dt>
              <dd className="text-foreground">{venue}</dd>
            </>
          )}
          {platform && (
            <>
              <dt className="text-muted-foreground">比赛平台</dt>
              <dd className="text-foreground">{platformLabel(platform)}</dd>
            </>
          )}
          {teamName && (
            <>
              <dt className="text-muted-foreground">所属队伍</dt>
              <dd className="text-foreground">{teamName}</dd>
            </>
          )}
          {awardText && (
            <>
              <dt className="text-muted-foreground">奖项 / 成绩</dt>
              <dd className="text-foreground">{awardText}</dd>
            </>
          )}
          {rankText && (
            <>
              <dt className="text-muted-foreground">比赛排名</dt>
              <dd className="text-foreground tabular-nums">{rankText}</dd>
            </>
          )}
          <dt className="text-muted-foreground">规则版本</dt>
          <dd className="text-foreground tabular-nums">
            {entry.ruleVersionId ? entry.ruleVersionId.slice(0, 8) : '默认规则'}
          </dd>
        </dl>

        {formula && (
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/20 p-3.5">
            <h3 className="text-xs font-semibold text-foreground">竞赛计分明细</h3>
            <div className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-6">
              {[
                { k: 'B', label: '到场分' },
                { k: 'lambda', label: 'λ 系数' },
                { k: 'S', label: '题数分 S' },
                { k: 'R', label: '社内排名 R' },
                { k: 'X', label: '外部奖 X' },
                { k: 'W', label: '总计 W' },
              ].map(({ k, label }) =>
                formula[k] != null ? (
                  <div key={k} className="rounded-lg bg-card px-2 py-1.5 text-center ring-1 ring-border">
                    <div className="text-[10px] text-muted-foreground">{label}</div>
                    <div className="font-semibold text-foreground tabular-nums">{String(formula[k])}</div>
                  </div>
                ) : null,
              )}
            </div>
            {typeof detail.lambdaSource === 'string' && (
              <p className="text-[11px] text-muted-foreground">λ 档来源：{detail.lambdaSource}</p>
            )}
          </div>
        )}

        {claimDesc && (
          <div className="flex flex-col gap-1 rounded-xl bg-muted/30 p-3.5 text-xs leading-5">
            <span className="font-medium text-foreground">申报内容</span>
            <p className="whitespace-pre-wrap text-muted-foreground">{claimDesc}</p>
            {claimReviewNote && (
              <p className="mt-1 text-foreground">审核意见：{claimReviewNote}</p>
            )}
          </div>
        )}

        {note && (
          <div className="flex flex-col gap-1 rounded-xl bg-muted/30 p-3.5 text-xs leading-5">
            <span className="font-medium text-foreground">说明 / 备注</span>
            <p className="whitespace-pre-wrap text-muted-foreground">{note}</p>
          </div>
        )}

        {(reversalReason || originalTitle) && (
          <Alert>
            <AlertTitle>{entry.category === 'reversal' ? '冲正说明' : '记录已冲正'}</AlertTitle>
            <AlertDescription>
              {originalTitle && <span>原事件：{originalTitle}；</span>}
              {reversalReason ?? '已按制度完成冲正处理。'}
            </AlertDescription>
          </Alert>
        )}

        <p className="border-t border-border pt-2 font-mono text-[11px] break-all text-muted-foreground/75">
          溯源编号：{entry.sourceKey}
        </p>
      </div>
    </ResponsiveDetail>
  );
}

function AppealDrawer({
  principalId,
  open,
  preset,
  onOpenChange,
}: {
  principalId: string;
  open: boolean;
  preset?: { entry?: LedgerEntryDto; ledgerEntryId?: string; subject?: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [selectedLedgerId, setSelectedLedgerId] = useState('');
  const [entrySearch, setEntrySearch] = useState('');
  const [subject, setSubject] = useState('');
  const [autoSubject, setAutoSubject] = useState('');
  const [materials, setMaterials] = useState('');

  const ledgerOptionsQuery = usePrivateQuery<
    { items: LedgerEntryDto[]; nextCursor?: string | null },
    ApiError
  >(
    principalId,
    ['me', 'points', 'appeal-options'],
    async () => (await api.get<{ items: LedgerEntryDto[]; nextCursor?: string | null }>('/me/points')).data,
    { enabled: open },
  );

  const ledgerOptions = useMemo(() => {
    const base = ledgerOptionsQuery.data?.items ?? [];
    if (preset?.entry && !base.some((item) => item.id === preset.entry!.id)) {
      return [preset.entry, ...base];
    }
    return base;
  }, [ledgerOptionsQuery.data, preset?.entry]);

  const filteredOptions = useMemo(() => {
    const keyword = entrySearch.trim().toLowerCase();
    if (!keyword) return ledgerOptions;
    return ledgerOptions.filter((entry) => {
      const name = displayEventName(entry).toLowerCase();
      const cat = (CATEGORY_LABELS[entry.category] ?? entry.category).toLowerCase();
      return (
        name.includes(keyword) ||
        cat.includes(keyword) ||
        entry.scoreMonth.includes(keyword) ||
        formatSignedAmount(entry.amount).includes(keyword)
      );
    });
  }, [ledgerOptions, entrySearch]);

  const selectedEntry = useMemo(
    () => ledgerOptions.find((item) => item.id === selectedLedgerId) ?? null,
    [ledgerOptions, selectedLedgerId],
  );

  useEffect(() => {
    if (!open) return;
    if (preset?.ledgerEntryId) {
      setSelectedLedgerId(preset.ledgerEntryId);
      const nextSubject = preset.subject ?? '';
      setSubject(nextSubject);
      setAutoSubject(nextSubject);
    } else {
      setSelectedLedgerId('');
      setSubject('');
      setAutoSubject('');
    }
    setEntrySearch('');
  }, [open, preset]);

  const selectEntry = (entry: LedgerEntryDto) => {
    setSelectedLedgerId(entry.id);
    const defaultSubject = `对「${displayEventName(entry)}」（${entry.scoreMonth}，${formatSignedAmount(entry.amount)} 分）积分有疑问`;
    if (!subject.trim() || subject === autoSubject) {
      setSubject(defaultSubject);
      setAutoSubject(defaultSubject);
    }
  };

  const mutation = useMutation({
    mutationFn: async (input: { subject: string; materials?: string; ledgerEntryId: string }) =>
      (await api.post<{ appealId: string }>('/me/appeals', input)).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'me', 'appeals'] });
    },
  });

  const canSubmit = !mutation.isPending && Boolean(selectedLedgerId) && subject.trim().length >= 5;

  return (
    <ResponsiveDetail
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          mutation.reset();
          setSelectedLedgerId('');
          setEntrySearch('');
          setSubject('');
          setAutoSubject('');
          setMaterials('');
        }
        onOpenChange(next);
      }}
      title="积分申诉"
      description="请选择有异议的对应积分流水后提交申诉，管理端可直接联动核查与调账。"
      footer={
        <Button
          onClick={() => {
            if (!selectedLedgerId) return;
            mutation.mutate({
              subject: subject.trim(),
              materials: materials.trim() || undefined,
              ledgerEntryId: selectedLedgerId,
            });
          }}
          disabled={!canSubmit}
          className="w-full sm:w-auto"
        >
          {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
          提交申诉
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {mutation.isSuccess && (
          <Alert>
            <AlertTitle>申诉已提交</AlertTitle>
            <AlertDescription>负责人会在工作台结合对应流水核查处理，结果将同步在此反馈。</AlertDescription>
          </Alert>
        )}
        {mutation.isError && (
          <Alert variant="destructive">
            <AlertTitle>提交失败</AlertTitle>
            <AlertDescription>{(mutation.error as ApiError).message}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="appeal-ledger-search">选择对应积分流水（必选）</Label>
            {selectedEntry && (
              <span className="text-xs text-primary">已选 1 笔流水</span>
            )}
          </div>
          {ledgerOptionsQuery.isPending ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : ledgerOptions.length === 0 ? (
            <Alert>
              <AlertTitle>暂无可申诉的积分流水</AlertTitle>
              <AlertDescription>
                当前账号还没有积分流水记录；如存在漏记活动或贡献，请前往「贡献申报」提交申报。
              </AlertDescription>
            </Alert>
          ) : (
            <>
              {ledgerOptions.length > 5 && (
                <Input
                  id="appeal-ledger-search"
                  value={entrySearch}
                  onChange={(event) => setEntrySearch(event.target.value)}
                  placeholder="按活动名称、月份或分值筛选流水…"
                />
              )}
              <div
                role="radiogroup"
                aria-label="选择要申诉的积分流水"
                className="flex max-h-56 flex-col gap-1.5 overflow-y-auto rounded-xl border border-border bg-muted/20 p-2"
              >
                {filteredOptions.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">没有匹配的积分流水。</p>
                ) : (
                  filteredOptions.map((entry) => {
                    const active = entry.id === selectedLedgerId;
                    const name = displayEventName(entry);
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => selectEntry(entry)}
                        className={`flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                          active
                            ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                            : 'border-border/60 bg-card hover:bg-muted/40'
                        }`}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-sm font-medium text-foreground">
                            {name}
                          </span>
                          <span
                            className={`shrink-0 text-sm font-semibold tabular-nums ${
                              Number(entry.amount) < 0 ? 'text-destructive' : 'text-foreground'
                            }`}
                          >
                            {formatSignedAmount(entry.amount)}
                          </span>
                        </span>
                        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <StatusBadge kind="points" value={ledgerStatusBadge(entry.status)} />
                          <span>{CATEGORY_LABELS[entry.category] ?? entry.category}</span>
                          <span className="tabular-nums">{entry.scoreMonth}</span>
                          <span className="tabular-nums">{formatDateTime(entry.recordedAt)}</span>
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="appeal-subject">申诉事项（5-500 字）</Label>
          <Input
            id="appeal-subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="选择上方流水后将自动带出，也可补充具体疑问"
            required
            minLength={5}
            maxLength={500}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="appeal-materials">材料说明（可选）</Label>
          <Textarea
            id="appeal-materials"
            value={materials}
            onChange={(event) => setMaterials(event.target.value)}
            rows={5}
            maxLength={4000}
            placeholder="凭证描述、时间点、期望更正分值、可联系的证明人等"
          />
        </div>
      </div>
    </ResponsiveDetail>
  );
}
