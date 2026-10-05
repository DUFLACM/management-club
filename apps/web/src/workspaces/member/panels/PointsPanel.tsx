/**
 * 成员端 · 积分：GET /me/points/overview + GET /me/points?month=&cursor=。
 * 上半 E 主卡 + 六个月构成（SVG 柱图 + 等价数据表）；下半流水表（含冲正标记）；
 * 申诉入口 POST /me/appeals。
 */
import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { FileTextIcon, LoaderCircleIcon, ScaleIcon } from 'lucide-react';

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
  monthLabel,
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
  months: Array<{ month: string; raw: number; m: number | null }>;
  roundingPending: boolean;
  roundingNote: string | null;
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
}

const CATEGORY_LABELS: Record<string, string> = {
  contest: '比赛',
  remote_contest: '远程比赛',
  activity: '活动',
  contribution: '贡献',
  service: '服务',
  award: '奖项',
  initial: '初始',
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
          <Button variant="outline" onClick={() => setAppealOpen(true)}>
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
              <Card className="lg:col-span-4">
                <CardContent className="flex flex-col gap-2 p-5">
                  <p className="text-sm text-muted-foreground">有效积分 E</p>
                  <p className="text-[40px] leading-[48px] font-semibold tracking-tight text-foreground tabular-nums">
                    {overview.e}
                  </p>
                  <p className="text-xs leading-5 text-muted-foreground">
                    近六个月 M 按当月 ×1、往前 ×0.85 / ×0.7 / ×0.55 / ×0.4 / ×0.25 加权求和。
                  </p>
                </CardContent>
              </Card>
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
              <LedgerTable entries={entries} />
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

      <AppealDrawer open={appealOpen} onOpenChange={setAppealOpen} />
    </div>
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
                <th scope="col" className="py-2 text-right font-medium">原始积分</th>
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
              正式月度 M 待 R01 取整口径确认；柱图为各月原始积分，月下系数为有效权重。
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function LedgerTable({ entries }: { entries: LedgerEntryDto[] }) {
  return (
    <>
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>月份</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>类别</TableHead>
              <TableHead className="text-right">分值</TableHead>
              <TableHead>规则版本</TableHead>
              <TableHead>记录时间</TableHead>
              <TableHead>状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="tabular-nums">{entry.scoreMonth}</TableCell>
                <TableCell className="max-w-64 truncate text-muted-foreground" title={entry.sourceKey}>
                  <span className="flex items-center gap-1.5">
                    <FileTextIcon className="size-3.5 shrink-0 text-input" aria-hidden="true" />
                    {entry.sourceKey}
                  </span>
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
                  {entry.ruleVersionId ? entry.ruleVersionId.slice(0, 8) : '默认'}
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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col divide-y divide-border md:hidden">
        {entries.map((entry) => (
          <li key={entry.id} className="flex flex-col gap-1 py-3">
            <span className="flex items-center justify-between gap-2">
              <span className="text-sm text-foreground">
                {CATEGORY_LABELS[entry.category] ?? entry.category} ·{' '}
                <span className="tabular-nums">{entry.scoreMonth}</span>
              </span>
              <span
                className={`text-sm font-semibold tabular-nums ${
                  Number(entry.amount) < 0 ? 'text-destructive' : 'text-foreground'
                }`}
              >
                {formatSignedAmount(entry.amount)}
              </span>
            </span>
            <span className="truncate text-xs text-muted-foreground" title={entry.sourceKey}>
              {entry.sourceKey}
            </span>
            <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <StatusBadge kind="points" value={ledgerStatusBadge(entry.status)} />
              {entry.reversesEntryId && <span>冲正</span>}
              <span className="tabular-nums">{formatDateTime(entry.recordedAt)}</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function AppealDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [subject, setSubject] = useState('');
  const [materials, setMaterials] = useState('');
  const mutation = useMutation({
    mutationFn: async (input: { subject: string; materials?: string }) =>
      (await api.post<{ appealId: string }>('/me/appeals', input)).data,
  });

  return (
    <ResponsiveDetail
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          mutation.reset();
          setSubject('');
          setMaterials('');
        }
        onOpenChange(next);
      }}
      title="积分申诉"
      description="对公示结果或某笔流水有疑问时提交；请写明申诉对象与依据。"
      footer={
        <Button
          onClick={() => {
            mutation.mutate({
              subject: subject.trim(),
              materials: materials.trim() || undefined,
            });
          }}
          disabled={mutation.isPending || subject.trim().length < 5}
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
            <AlertDescription>负责人会在公示期内处理，结果会在此反馈。</AlertDescription>
          </Alert>
        )}
        {mutation.isError && (
          <Alert variant="destructive">
            <AlertTitle>提交失败</AlertTitle>
            <AlertDescription>{(mutation.error as ApiError).message}</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="appeal-subject">申诉事项（5-500 字）</Label>
          <Input
            id="appeal-subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="如：10 月 8 日周赛的出勤认定缺少我的签退"
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
            placeholder="凭证描述、时间点、可联系的证明人等"
          />
        </div>
      </div>
    </ResponsiveDetail>
  );
}
