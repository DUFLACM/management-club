/**
 * 成员端 · 竞赛。
 * Tabs：平台记录（绑定 + 成绩 + 申请刷新）/ 指定与备案 / 正式赛报名 / 组队广场。
 * 贡献申报已拆为独立 section（ContributionsPanel）。
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BookOpenIcon,
  ExternalLinkIcon,
  FilterIcon,
  LoaderCircleIcon,
  PlusIcon,
  MegaphoneIcon,
  RefreshCwIcon,
  SearchIcon,
  SnowflakeIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrivateInfiniteQuery } from '@/lib/private-infinite';
import { usePrincipal } from '@/lib/session';
import { LoadMoreButton, useDebouncedValue } from '@/lib/hooks';
import { formatDateTime, platformAccountBadge, platformLabel, memberName, memberAvatarId } from '@/lib/format';
import {
  competitionsApi,
  contestTierLabel,
  entryStatusLabel,
  LAMBDA_LABELS,
  type CompetitionEventDetailDto,
  type CompetitionMaterialDto,
  type EligibleEventDto,
  type InvitableMemberDto,
  type MemberCompetitionEventDto,
  type MemberShortlistBoardDto,
  type MyJoinRequestDto,
  type TeamDto,
  type TeamInviteDto,
  type TeamRecruitmentDto,
} from '@/lib/competitions';
import { PanelHeader } from '@/components/club/PanelHeader';
import { BindPlatformAccountDialog } from '@/components/club/BindPlatformAccountDialog';
import { MemberGate, QueryBoundary } from '@/components/club/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/club/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { MemberAvatar } from '@/components/club/MemberAvatar';

interface PlatformAccountDto {
  id: string;
  platform: string;
  externalId: string;
  displayHandle: string;
  status: string;
  verifiedAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
}

interface CompetitionResultDto {
  platform: string;
  contestId: string;
  contestName: string;
  startTime: string;
  participationType: string;
  score: number | null;
  fullScore: number | null;
  acceptedCount: number | null;
  problemCount: number | null;
  rank: number | null;
  rankTotal: number | null;
  status: string;
  verifiedBinding: boolean;
}

/** 平台徽标配色：牛客橙 / CF 蓝 / AtCoder 中性 / 校内 OJ 绿 */
const PLATFORM_CHIP: Record<string, string> = {
  nowcoder: 'bg-warning-subtle text-warning-foreground',
  codeforces: 'bg-info-subtle text-info-foreground',
  atcoder: 'bg-muted text-foreground',
  hydro: 'bg-success-subtle text-success-foreground',
};

const PLATFORM_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'all', label: '全部平台' },
  { value: 'nowcoder', label: '牛客' },
  { value: 'codeforces', label: 'Codeforces' },
  { value: 'atcoder', label: 'AtCoder' },
  { value: 'hydro', label: '校内 OJ' },
];

const PERIOD_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'all', label: '全部时间' },
  { value: '30', label: '近 30 天' },
  { value: '90', label: '近 3 个月' },
  { value: '180', label: '近半年' },
  { value: '365', label: '近一年' },
];

const PLATFORM_BADGES: Record<string, string> = {
  nowcoder: '牛客',
  codeforces: 'Codeforces',
  atcoder: 'AtCoder',
  hydro: '校内 OJ',
};

function platformChip(platform: string): string {
  return PLATFORM_CHIP[platform] ?? 'bg-muted text-muted-foreground';
}

const TABS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'records', label: '平台记录' },
  { value: 'designated', label: '指定与备案' },
  { value: 'entry', label: '正式赛报名' },
  { value: 'teams', label: '组队广场' },
];

export default function ContestsPanel() {
  const principal = usePrincipal();
  return (
    <MemberGate principal={principal}>
      {(principalId) => <ContestsBody principalId={principalId} />}
    </MemberGate>
  );
}

function ContestsBody({ principalId }: { principalId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') ?? 'records';

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="竞赛"
        description="平台账号绑定、比赛成绩同步、正式赛报名与组队。"
      />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          setSearchParams((previous) => {
            const next = new URLSearchParams(previous);
            if (value === 'records') next.delete('tab');
            else next.set('tab', value);
            return next;
          })
        }
      >
        <TabsList aria-label="竞赛子页">
          {TABS.map((option) => (
            <TabsTrigger key={option.value} value={option.value}>
              {option.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="records" className="mt-4">
          <PlatformRecords principalId={principalId} />
        </TabsContent>
        <TabsContent value="designated" className="mt-4">
          <DesignatedInfo />
        </TabsContent>
        <TabsContent value="entry" className="mt-4">
          <FormalEntrySection principalId={principalId} />
        </TabsContent>
        <TabsContent value="teams" className="mt-4">
          <TeamPlazaSection principalId={principalId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PlatformRecords({ principalId }: { principalId: string }) {
  const [bindOpen, setBindOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [platformFilter, setPlatformFilter] = useState('all');
  const [periodFilter, setPeriodFilter] = useState('all');

  const fromDate = periodFilter === 'all'
    ? null
    : new Date(Date.now() - Number(periodFilter) * 24 * 3600_000).toISOString();
  const hasFilter = platformFilter !== 'all' || periodFilter !== 'all';

  const accountsQuery = usePrivateQuery<PlatformAccountDto[], ApiError>(
    principalId,
    ['me', 'platform-accounts'],
    async () => (await api.get<PlatformAccountDto[]>('/me/platform-accounts')).data,
  );

  const resultsQuery = usePrivateInfiniteQuery<
    { items: CompetitionResultDto[]; nextCursor?: string | null },
    ApiError
  >(principalId, ['profiles', 'competition-results', principalId, platformFilter, periodFilter], async (cursor) => {
    const params = new URLSearchParams();
    if (platformFilter !== 'all') params.set('platform', platformFilter);
    if (fromDate) params.set('from', fromDate);
    if (cursor) params.set('cursor', cursor);
    const { data } = await api.get<{ items: CompetitionResultDto[]; nextCursor?: string | null }>(
      `/profiles/${principalId}/competition-results?${params.toString()}`,
    );
    return data;
  });

  const syncMutation = useMutation({
    mutationFn: async (accountId: string) => {
      await api.post('/me/platform-syncs', { accountId });
      return true;
    },
    onSuccess: () => {
      setNotice({ tone: 'info', text: '同步任务已排队（202），稍后回来刷新查看结果。' });
    },
    onError: (error: ApiError) => setNotice({ tone: 'error', text: error.message }),
  });

  const results = resultsQuery.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      {notice && (
        <Alert variant={notice.tone === 'error' ? 'destructive' : 'info'}>
          <AlertTitle>{notice.tone === 'error' ? '操作未完成' : '已提交'}</AlertTitle>
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="flex flex-col gap-3 p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">平台账号绑定</h2>
            <Button size="sm" variant="outline" onClick={() => setBindOpen(true)}>
              <PlusIcon aria-hidden="true" />
              绑定账号
            </Button>
          </div>
          <QueryBoundary
            query={accountsQuery}
            skeleton={<Skeleton className="h-16 rounded-xl" />}
            isEmpty={(accounts) => accounts.length === 0}
            emptyNode={
              <p className="text-sm leading-[22px] text-muted-foreground">
                还没有绑定平台账号。绑定牛客 / Codeforces / AtCoder 账号后，比赛成绩会自动汇入。
              </p>
            }
          >
            {(accounts) => (
              <ul className="flex flex-col divide-y divide-border">
                {accounts.map((account) => (
                  <li key={account.id} className="flex flex-wrap items-center gap-3 py-2.5">
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">
                        {platformLabel(account.platform)} · {account.displayHandle}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {account.lastSyncAt
                          ? `上次同步 ${formatDateTime(account.lastSyncAt)}${
                              account.lastSyncStatus === 'failed' ? '（失败）' : ''
                            }`
                          : '尚未同步'}
                        {account.lastSyncError ? `：${account.lastSyncError}` : ''}
                      </span>
                    </span>
                    <span className="ml-auto flex items-center gap-2">
                      <StatusBadge kind="sync" value={platformAccountBadge(account.status)} />
                      {account.status === 'verified' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={syncMutation.isPending}
                          onClick={() => syncMutation.mutate(account.id)}
                        >
                          {syncMutation.isPending && syncMutation.variables === account.id ? (
                            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                          ) : (
                            <RefreshCwIcon aria-hidden="true" />
                          )}
                          申请刷新
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </QueryBoundary>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0 pb-2">
          <div className="p-5 pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-foreground">比赛成绩（同步记录）</h2>
              <span className="text-xs text-muted-foreground tabular-nums">
                按比赛时间倒序{!resultsQuery.isPending && !resultsQuery.isError ? ` · ${results.length} 条` : ''}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              来源为平台公开数据同步；非本人绑定账号的成绩不会出现。
            </p>
          </div>
          {/* 筛选栏：平台 + 时间段 */}
          <div className="flex flex-wrap items-center gap-2 border-y border-border bg-muted/30 px-5 py-3">
            <FilterIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Select value={platformFilter} onValueChange={setPlatformFilter}>
              <SelectTrigger className="h-9 w-32" aria-label="按平台筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORM_FILTERS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={periodFilter} onValueChange={setPeriodFilter}>
              <SelectTrigger className="h-9 w-32" aria-label="按时间段筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIOD_FILTERS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hasFilter && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9 px-2 text-muted-foreground"
                onClick={() => {
                  setPlatformFilter('all');
                  setPeriodFilter('all');
                }}
              >
                <XIcon aria-hidden="true" />
                清除筛选
              </Button>
            )}
          </div>
          {resultsQuery.isPending ? (
            <div className="flex flex-col gap-2 px-5">
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} className="h-10" />
              ))}
            </div>
          ) : resultsQuery.isError ? (
            <div className="p-5">
              <ErrorInline message={resultsQuery.error.message} onRetry={() => void resultsQuery.refetch()} />
            </div>
          ) : results.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              {hasFilter
                ? '当前筛选条件下没有比赛成绩，试试放宽平台或时间段。'
                : '暂无同步到的比赛成绩；绑定并核验账号后点击「申请刷新」。'}
            </p>
          ) : (
            <>
              {/* 手机卡片 / 桌面表格 */}
              <ResultsTable results={results} />
              <div className="px-5">
                <LoadMoreButton
                  onClick={() => {
                    void resultsQuery.fetchNextPage();
                  }}
                  loading={resultsQuery.isFetchingNextPage}
                  hasNext={Boolean(resultsQuery.data?.pages.at(-1)?.nextCursor)}
                  hint="已展示全部成绩"
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <BindPlatformAccountDialog
        principalId={principalId}
        open={bindOpen}
        onOpenChange={setBindOpen}
        onSuccess={() =>
          setNotice({ tone: 'info', text: '绑定申请已提交，等待管理员核验账号持有证明。' })
        }
      />
    </div>
  );
}

function ResultsTable({ results }: { results: CompetitionResultDto[] }) {
  return (
    <>
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>平台 / 比赛</TableHead>
              <TableHead>时间</TableHead>
              <TableHead className="text-right">分数</TableHead>
              <TableHead className="text-right">通过/题数</TableHead>
              <TableHead className="text-right">排名</TableHead>
              <TableHead>绑定</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((row, index) => (
              <TableRow key={`${row.platform}-${row.contestId}-${index}`}>
                <TableCell>
                  <span className="block text-sm">{row.contestName}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={`rounded px-1.5 py-0.5 font-medium ${platformChip(row.platform)}`}>
                      {platformLabel(row.platform)}
                    </span>
                    {row.participationType}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {formatDateTime(row.startTime)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.score ?? '—'}
                  {row.fullScore != null && (
                    <span className="text-muted-foreground"> / {row.fullScore}</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.acceptedCount ?? '—'}/{row.problemCount ?? '—'}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.rank ?? '—'}
                  {row.rankTotal != null && (
                    <span className="text-muted-foreground"> / {row.rankTotal}</span>
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge
                    kind="sync"
                    value={row.verifiedBinding ? '已核验' : '待持有核验'}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col divide-y divide-border md:hidden">
        {results.map((row, index) => (
          <li key={`${row.platform}-${row.contestId}-m-${index}`} className="flex flex-col gap-1 p-4">
            <span className="text-sm font-medium text-foreground">{row.contestName}</span>
            <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className={`rounded px-1.5 py-0.5 font-medium ${platformChip(row.platform)}`}>
                {platformLabel(row.platform)}
              </span>
              {formatDateTime(row.startTime)}
            </span>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
              <span>分数 {row.score ?? '—'}</span>
              <span>
                通过 {row.acceptedCount ?? '—'}/{row.problemCount ?? '—'}
              </span>
              <span>排名 {row.rank ?? '—'}</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

interface DesignatedContestDto {
  id: string;
  category: 'A' | 'B' | 'C';
  groupName: string;
  name: string;
  platform: string | null;
  lambdaKey: 'A' | 'B' | 'C' | null;
  note: string | null;
  evidenceRef: string | null;
  effectiveFrom: string;
}

const DESIGNATED_CATEGORY_META: Record<string, { title: string; description: string; chip: string }> = {
  A: {
    title: 'A 类 · 学校配额统一管理',
    description: '以学校名义报名、占用学校配额或统一推荐的赛事，由协会统一组织报名与名额管理。',
    chip: 'bg-info-subtle text-info-foreground',
  },
  B: {
    title: 'B 类 · 纳入积分认定（非配额）',
    description: '平台赛须赛前公告为指定场次并统一组织线下核验；官方认证赛事赛后凭证书/公示核验。',
    chip: 'bg-success-subtle text-success-foreground',
  },
  C: {
    title: 'C 类 · 原则上不予认定',
    description: '以下情形不计入积分；对认定结果有异议请按备案条款向主席团申诉。',
    chip: 'bg-muted text-muted-foreground',
  },
};

const LAMBDA_LABEL: Record<string, string> = { A: '甲类 λ1.2', B: '乙类 λ1.0', C: '丙类 λ0.8' };

/** 指定与备案：附录一认定目录（A/B/C 分组卡片） */
function DesignatedInfo() {
  const principal = usePrincipal();
  const principalId = principal?.principalId ?? null;
  const query = usePrivateQuery<DesignatedContestDto[], ApiError>(
    principalId,
    ['me', 'designated-contests'],
    async () => (await api.get<DesignatedContestDto[]>('/me/designated-contests')).data,
  );

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-5">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <BookOpenIcon className="size-4 text-input" aria-hidden="true" />
            指定比赛与备案
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            认定目录依据附录一（基础清单，协会可按年度调整并提前 ≥3 日公示）；
            参加非指定但希望纳入记录的比赛，请在公告前向主席团备案（比赛名称、时间、名单与成绩凭证）。
          </p>
        </div>

        {/* 比赛分计算公式 */}
        <div className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-gradient-to-br from-primary/10 via-card to-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">比赛分怎么算</h3>
            <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              活动结束后 5 分钟由引擎自动结算入账
            </span>
          </div>
          <p className="text-center font-mono text-base font-medium text-primary">
            W = B + λ × (4S + 6R) + X
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs leading-5">
            <dt className="font-mono font-semibold text-foreground">W</dt>
            <dd className="text-muted-foreground">单场比赛总得分（保留两位小数，计入当月 M）</dd>
            <dt className="font-mono font-semibold text-foreground">B</dt>
            <dd className="text-muted-foreground">
              到场基础分：线下到场 <span className="text-foreground">+2</span>，公告指定月赛 +3，远程 B=0
              <br />
              前提：现场签到（或人工复核补签）；未到场则整场不计竞赛分
            </dd>
            <dt className="font-mono font-semibold text-foreground">λ</dt>
            <dd className="text-muted-foreground">
              类别系数（按下表目录档位）：<span className="text-foreground">甲 1.2</span> ·{' '}
              <span className="text-foreground">乙 1.0</span> · <span className="text-foreground">丙 0.8</span>；
              赛前公告可上浮 +0.2（或 B→3，二选一）
            </dd>
            <dt className="font-mono font-semibold text-foreground">S</dt>
            <dd className="text-muted-foreground">
              过题比例 = 过题数 ÷ 总题数（分数制为 得分 ÷ 满分），上限 1；
              引擎从平台榜单自动获取
            </dd>
            <dt className="font-mono font-semibold text-foreground">R</dt>
            <dd className="text-muted-foreground">
              社内名次分 = 1 − (社内名次 − 1) ÷ (有效参赛人数 − 1)；
              有效参赛 &lt; 3 人时减半（单人 R = 0.5）
            </dd>
            <dt className="font-mono font-semibold text-foreground">X</dt>
            <dd className="text-muted-foreground">
              外部排名分：平台总排名前 5% → 3 分 · 前 10% → 2 · 前 30% → 1 · 其余 0
            </dd>
          </dl>
          <div className="flex flex-col gap-1 border-t border-border/60 pt-2 text-xs leading-5 text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">有效提交：</span>
              引擎从平台榜单自动核验（有通过 / 得分 / 提交记录即有效，判题集合 AC/WA/TLE/MLE/RE/PE）；
              仅编译错误或证据不足时转人工审核窗口。
            </p>
            <p>
              <span className="font-medium text-foreground">远程参赛：</span>W = 0.5 × [λ(4S+6R) + X]，B=0，
              上限为线下场的 50%，每自然月最多认定 1 次，须赛前申请获批。
            </p>
            <p>
              <span className="font-medium text-foreground">上限与月度：</span>
              单场常规上限 20（公告特定场 ≤25）；所有分数按类别月上限汇总后月末四舍五入为 M，
              近六个月 M 加权（1/0.85/0.7/0.55/0.4/0.25）为有效积分 E。
            </p>
          </div>
        </div>

        {query.isPending ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : query.isError ? (
          <p className="text-sm text-muted-foreground">{query.error.message}</p>
        ) : (
          (['A', 'B', 'C'] as const).map((category) => {
            const rows = query.data.filter((row) => row.category === category);
            if (rows.length === 0) return null;
            const meta = DESIGNATED_CATEGORY_META[category]!;
            const groups = [...new Set(rows.map((row) => row.groupName))];
            return (
              <section key={category} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground">{meta.title}</h3>
                  <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${meta.chip} tabular-nums`}>
                    {rows.length} 项
                  </span>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">{meta.description}</p>
                {groups.map((group) => (
                  <div key={group} className="flex flex-col gap-1.5 rounded-xl border border-border p-3">
                    <p className="text-xs font-medium text-foreground/80">{group}</p>
                    <ul className="flex flex-col gap-1.5">
                      {rows
                        .filter((row) => row.groupName === group)
                        .map((row) => (
                          <li key={row.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                            <span className="min-w-0 flex-1 text-foreground">{row.name}</span>
                            {row.platform && (
                              <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${platformChip(row.platform)}`}>
                                {PLATFORM_BADGES[row.platform] ?? row.platform}
                              </span>
                            )}
                            {row.lambdaKey && (
                              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                                {LAMBDA_LABEL[row.lambdaKey]}
                              </span>
                            )}
                            {category === 'B' && !row.lambdaKey && (
                              <span className="rounded bg-warning-subtle px-1.5 py-0.5 text-[11px] font-medium text-warning-foreground">
                                λ 待赛前公告
                              </span>
                            )}
                            {row.note && (
                              <span className="w-full text-xs leading-5 text-muted-foreground" title={row.evidenceRef ?? undefined}>
                                {row.note}
                              </span>
                            )}
                          </li>
                        ))}
                    </ul>
                  </div>
                ))}
              </section>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 正式赛报名：开放中的赛事列表 → 展开后查看公告、入围情况与我的报名。
 * 个人赛在此直接报名；团队赛转到「组队广场」以队为单位提交。
 */
function FormalEntrySection({ principalId }: { principalId: string }) {
  const [openId, setOpenId] = useState<string | null>(null);

  const listQuery = usePrivateQuery<MemberCompetitionEventDto[], ApiError>(
    principalId,
    ['me', 'competition-events'],
    () => competitionsApi.listOpenEvents(),
  );

  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <SnowflakeIcon aria-hidden="true" />
        <AlertTitle>报名与资格</AlertTitle>
        <AlertDescription>
          A 类赛事占用学校配额，按积分冻结时点的有效积分 E（或专项选拔 Q）排序取前 N 名入围，
          名单锁定后回填成绩不再改变出场资格；B 类赛事按公告条件自由报名。
        </AlertDescription>
      </Alert>

      <QueryBoundary
        query={listQuery}
        isEmpty={(list) => list.length === 0}
        emptyNode={
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              当前没有开放报名的正式赛事。
            </CardContent>
          </Card>
        }
      >
        {(list) => (
          <ul className="flex flex-col gap-3">
            {list.map((event) => (
              <li key={event.id}>
                <Card>
                  <CardContent className="flex flex-col gap-3 p-4 sm:p-5">
                    <button
                      type="button"
                      className="flex flex-col gap-1 text-left"
                      aria-expanded={openId === event.id}
                      onClick={() => setOpenId(openId === event.id ? null : event.id)}
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge variant={event.category === 'A' ? 'info' : 'success'}>
                          {event.category} 类
                        </Badge>
                        <span className="text-sm font-medium text-foreground">{event.title}</span>
                        {event.teamSize && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                            {event.teamSize} 人团队赛
                          </span>
                        )}
                        {event.myStatus && (
                          <Badge
                            variant={
                              event.myStatus === 'rejected'
                                ? 'destructive'
                                : event.myStatus === 'approved' || event.myStatus === 'confirmed'
                                  ? 'success'
                                  : 'warning'
                            }
                          >
                            {entryStatusLabel(event.myStatus)}
                          </Badge>
                        )}
                      </span>
                      <span className="text-xs leading-5 text-muted-foreground tabular-nums">
                        报名截止 {formatDateTime(event.registerDeadline)} · 赛期{' '}
                        {formatDateTime(event.startAt)}
                      </span>
                    </button>
                    {openId === event.id && (
                      <EventEntryDetail principalId={principalId} eventId={event.id} />
                    )}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </div>
  );
}

function EventEntryDetail({
  principalId,
  eventId,
}: {
  principalId: string;
  eventId: string;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [accountId, setAccountId] = useState('auto');
  const [error, setError] = useState<string | null>(null);
  const [showBoard, setShowBoard] = useState(false);

  const detailQuery = usePrivateQuery<CompetitionEventDetailDto, ApiError>(
    principalId,
    ['me', 'competition-event', eventId],
    () => competitionsApi.eventDetail(eventId),
  );

  const accountsQuery = usePrivateQuery<PlatformAccountDto[], ApiError>(
    principalId,
    ['me', 'platform-accounts'],
    async () => (await api.get<PlatformAccountDto[]>('/me/platform-accounts')).data,
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ['principal', principalId, 'me', 'competition-event', eventId],
    });
    void queryClient.invalidateQueries({
      queryKey: ['principal', principalId, 'me', 'competition-events'],
    });
  };

  const registerMutation = useMutation({
    mutationFn: () =>
      competitionsApi.register(eventId, {
        ...(accountId !== 'auto' ? { platformAccountId: accountId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (cause: ApiError) => setError(cause.message),
  });

  const resubmitMutation = useMutation({
    mutationFn: (registrationId: string) =>
      competitionsApi.resubmit(registrationId, note.trim() || undefined),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (cause: ApiError) => setError(cause.message),
  });

  return (
    <QueryBoundary query={detailQuery} skeleton={<Skeleton className="h-32 rounded-xl" />}>
      {({ event, contestUrl, myShortlist, myRegistration, myTeamEntries }) => {
        const verified = (accountsQuery.data ?? []).filter(
          (account) => account.status === 'verified' && account.platform === event.platform,
        );
        const needsBind = event.scoringMode === 'platform_auto' && verified.length === 0;
        const deadlinePassed = new Date(event.registerDeadline).getTime() < Date.now();
        const blockedByShortlist =
          event.category === 'A' && (!myShortlist || !myShortlist.shortlisted);

        return (
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">
              {event.announcement}
            </p>

            <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
              <div className="flex gap-2">
                <dt className="text-muted-foreground">积分方式</dt>
                <dd className="text-foreground">
                  {event.scoringMode === 'platform_auto'
                    ? `平台自动结算（${LAMBDA_LABELS[event.lambdaKey ?? 'B']}）`
                    : `人工审核 · ${contestTierLabel(event.contestTier)}`}
                </dd>
              </div>
              {event.quota != null && (
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">学校配额</dt>
                  <dd className="text-foreground tabular-nums">{event.quota} 人</dd>
                </div>
              )}
              {event.freezeAt && (
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">积分冻结时点</dt>
                  <dd className="text-foreground tabular-nums">{formatDateTime(event.freezeAt)}</dd>
                </div>
              )}
              {event.teamFormDeadline && (
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">自主组队截止</dt>
                  <dd className="text-foreground tabular-nums">
                    {formatDateTime(event.teamFormDeadline)}
                  </dd>
                </div>
              )}
            </dl>

            <div className="flex flex-wrap items-center gap-2">
              {contestUrl && (
                <Button size="sm" variant="outline" asChild>
                  <a href={contestUrl} target="_blank" rel="noreferrer noopener">
                    <ExternalLinkIcon aria-hidden="true" />
                    前往比赛页
                  </a>
                </Button>
              )}
              {event.category === 'A' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowBoard((previous) => !previous)}
                >
                  {showBoard ? '收起资格名单' : '查看资格名单'}
                </Button>
              )}
            </div>

            {myShortlist && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-muted/40 p-3 text-xs">
                <Badge variant={myShortlist.shortlisted ? 'success' : 'neutral'}>
                  {myShortlist.shortlisted ? '已入围' : '未入围'}
                </Badge>
                <span className="text-muted-foreground tabular-nums">
                  名次 {myShortlist.position} · E 快照 {Number(myShortlist.eSnapshot).toFixed(2)}
                  {myShortlist.qScore != null &&
                    ` · Q ${Number(myShortlist.qScore).toFixed(2)}`}
                </span>
                {!myShortlist.eligible && (
                  <span className="text-muted-foreground">当前不具备出场资格</span>
                )}
              </div>
            )}

            {showBoard && <ShortlistBoard principalId={principalId} eventId={eventId} />}

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {event.teamSize != null ? (
              <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border p-3">
                <p className="text-sm text-foreground/90">
                  这是 {event.teamSize} 人团队赛，报名以队伍为单位提交；请在「组队广场」建队、
                  邀请队员满员后报名。逾期未成队的由管理员按均衡分组矩阵法强制编组。
                </p>
                {myTeamEntries.length > 0 ? (
                  <ul className="flex flex-col gap-2">
                    {myTeamEntries.map((entry) => (
                      <li key={entry.id} className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-medium text-foreground">{entry.team.name}</span>
                        <Badge
                          variant={
                            entry.status === 'rejected'
                              ? 'destructive'
                              : entry.status === 'approved' || entry.status === 'confirmed'
                                ? 'success'
                                : 'warning'
                          }
                        >
                          {entryStatusLabel(entry.status)}
                        </Badge>
                        {entry.resultScore && (
                          <span className="text-muted-foreground tabular-nums">
                            每人 {entry.resultScore} 分
                          </span>
                        )}
                        {entry.reviewNote && (
                          <span className="text-muted-foreground">{entry.reviewNote}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Button size="sm" variant="outline" className="w-fit" asChild>
                    <Link to="/app?section=contests&tab=teams">前往组队广场</Link>
                  </Button>
                )}
              </div>
            ) : myRegistration && myRegistration.status !== 'rejected' ? (
              <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={
                      myRegistration.status === 'approved' || myRegistration.status === 'confirmed'
                        ? 'success'
                        : 'warning'
                    }
                  >
                    {entryStatusLabel(myRegistration.status)}
                  </Badge>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    报名于 {formatDateTime(myRegistration.registeredAt)}
                  </span>
                  {myRegistration.platformAccount && (
                    <span className="text-xs text-muted-foreground">
                      {platformLabel(myRegistration.platformAccount.platform)} ·{' '}
                      {myRegistration.platformAccount.displayHandle}
                    </span>
                  )}
                  {myRegistration.resultScore && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      已入账 {myRegistration.resultScore} 分
                    </span>
                  )}
                </div>
                {event.scoringMode === 'manual_review' && (
                  <MaterialUploader
                    principalId={principalId}
                    eventId={eventId}
                    registrationId={myRegistration.id}
                    materials={myRegistration.materials}
                  />
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
                {myRegistration?.status === 'rejected' && (
                  <Alert variant="destructive">
                    <AlertTitle>报名被驳回</AlertTitle>
                    <AlertDescription>
                      {myRegistration.reviewNote ?? '未说明原因'}；补充说明后可重新提交。
                    </AlertDescription>
                  </Alert>
                )}
                {needsBind && (
                  <Alert>
                    <AlertDescription>
                      本场按平台成绩自动结算，请先在「平台记录」页绑定并核验
                      {platformLabel(event.platform ?? '')}账号。
                    </AlertDescription>
                  </Alert>
                )}
                {blockedByShortlist && (
                  <Alert>
                    <AlertDescription>
                      A 类赛事仅入围名单内的成员可报名；名单生成后在此查看自己的名次。
                    </AlertDescription>
                  </Alert>
                )}
                {verified.length > 1 && (
                  <div className="grid gap-1.5 sm:max-w-xs">
                    <Label htmlFor={`entry-account-${eventId}`}>参赛平台账号</Label>
                    <Select value={accountId} onValueChange={setAccountId}>
                      <SelectTrigger id={`entry-account-${eventId}`} aria-label="参赛平台账号">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">自动选择已核验账号</SelectItem>
                        {verified.map((account) => (
                          <SelectItem key={account.id} value={account.id}>
                            {account.displayHandle}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="grid gap-1.5">
                  <Label htmlFor={`entry-note-${eventId}`}>报名备注（可选，≤500 字）</Label>
                  <Textarea
                    id={`entry-note-${eventId}`}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={500}
                    rows={2}
                    placeholder="如需说明的参赛信息、同行队员、特殊安排"
                  />
                </div>
                <Button
                  size="sm"
                  className="w-fit"
                  disabled={
                    registerMutation.isPending ||
                    resubmitMutation.isPending ||
                    needsBind ||
                    blockedByShortlist ||
                    deadlinePassed
                  }
                  onClick={() => {
                    if (myRegistration?.status === 'rejected') {
                      resubmitMutation.mutate(myRegistration.id);
                    } else {
                      registerMutation.mutate();
                    }
                  }}
                >
                  {(registerMutation.isPending || resubmitMutation.isPending) && (
                    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  )}
                  {deadlinePassed
                    ? '报名已截止'
                    : myRegistration?.status === 'rejected'
                      ? '重新提交'
                      : '提交报名'}
                </Button>
              </div>
            )}
          </div>
        );
      }}
    </QueryBoundary>
  );
}

/** 资格名单：成员端按名次与成员引用展示，不公开他人姓名 */
function ShortlistBoard({ principalId, eventId }: { principalId: string; eventId: string }) {
  const query = usePrivateQuery<MemberShortlistBoardDto, ApiError>(
    principalId,
    ['me', 'competition-shortlist', eventId],
    () => competitionsApi.shortlistBoard(eventId),
  );

  return (
    <QueryBoundary
      query={query}
      skeleton={<Skeleton className="h-24 rounded-xl" />}
      isEmpty={(board) => board.rows.length === 0}
      emptyNode={
        <p className="py-4 text-center text-xs text-muted-foreground">
          资格名单尚未生成（通常在报名截止前一日 22:00 冻结）。
        </p>
      }
    >
      {(board) => (
        <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <p className="text-xs text-muted-foreground tabular-nums">
            配额 {board.event.quota ?? '不限'} · 冻结时点 {formatDateTime(board.event.freezeAt)}
          </p>
          <ol className="flex flex-col divide-y divide-border">
            {board.rows.map((row) => (
              <li
                key={row.userId}
                className={`flex items-center gap-3 py-1.5 text-xs ${
                  row.isMe ? 'font-medium text-foreground' : 'text-muted-foreground'
                }`}
              >
                <span className="w-8 shrink-0 tabular-nums">{row.position}</span>
                <span className="min-w-0 flex-1 truncate">
                  {row.isMe ? '我' : `成员 #${row.userId.slice(0, 6)}`}
                </span>
                <span className="shrink-0 tabular-nums">
                  {Number(row.qScore ?? row.eSnapshot).toFixed(2)}
                </span>
                <Badge variant={row.shortlisted ? 'success' : 'neutral'}>
                  {row.shortlisted ? '入围' : '候补'}
                </Badge>
              </li>
            ))}
          </ol>
        </div>
      )}
    </QueryBoundary>
  );
}

const MATERIAL_ACCEPT =
  '.pdf,.zip,.md,.txt,.pptx,.docx,.png,.jpg,.jpeg';

/** 报名材料：pdf/zip/md/txt/pptx/docx/png/jpeg，单个 ≤20 MiB */
function MaterialUploader({
  principalId,
  eventId,
  registrationId,
  materials,
}: {
  principalId: string;
  eventId: string;
  registrationId: string;
  materials: CompetitionMaterialDto[];
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      if (!file) throw new ApiError('INVALID_INPUT', '请选择要上传的文件。');
      return competitionsApi.uploadRegistrationMaterial(registrationId, file, title.trim());
    },
    onSuccess: () => {
      setError(null);
      setTitle('');
      setFile(null);
      void queryClient.invalidateQueries({
        queryKey: ['principal', principalId, 'me', 'competition-event', eventId],
      });
    },
    onError: (cause: ApiError) => setError(cause.message),
  });

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-foreground">报名材料</p>
      {materials.length > 0 && (
        <ul className="flex flex-wrap gap-3">
          {materials.map((material) => (
            <li key={material.id}>
              <a
                className="text-xs text-primary underline-offset-2 hover:underline"
                href={competitionsApi.registrationMaterialUrl(registrationId, material.id)}
                download
              >
                {material.title}
              </a>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="grid flex-1 gap-1.5">
          <Label htmlFor={`material-title-${registrationId}`}>材料标题</Label>
          <Input
            id={`material-title-${registrationId}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="如：参赛承诺书"
          />
        </div>
        <div className="grid flex-1 gap-1.5">
          <Label htmlFor={`material-file-${registrationId}`}>选择文件（≤20 MiB）</Label>
          <Input
            id={`material-file-${registrationId}`}
            type="file"
            accept={MATERIAL_ACCEPT}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={mutation.isPending || !file || title.trim().length === 0}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
          上传
        </Button>
      </div>
    </div>
  );
}

function ErrorInline({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

/**
 * 组队广场（办法第十二~十七条）：常驻小队，一人可属多队。
 * 建队 → 检索并邀请队员 → 满员后在可报名赛事中提交；A 类团队赛要求全体队员均已入围。
 */
function TeamPlazaSection({ principalId }: { principalId: string }) {
  const [view, setView] = useState<'board' | 'mine'>('board');
  return (
    <Tabs value={view} onValueChange={(value) => setView(value as 'board' | 'mine')}>
      <TabsList aria-label="组队广场分区">
        <TabsTrigger value="board">招募广场</TabsTrigger>
        <TabsTrigger value="mine">我的小队</TabsTrigger>
      </TabsList>
      <TabsContent value="board" className="mt-4">
        <RecruitmentBoard principalId={principalId} />
      </TabsContent>
      <TabsContent value="mine" className="mt-4">
        <MyTeamsSection principalId={principalId} />
      </TabsContent>
    </Tabs>
  );
}

/** 我的小队：建队、处理邀请、管理队员与招募 */
function MyTeamsSection({ principalId }: { principalId: string }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [teamSize, setTeamSize] = useState('3');
  const [error, setError] = useState<string | null>(null);

  const teamsQuery = usePrivateQuery<TeamDto[], ApiError>(
    principalId,
    ['me', 'teams'],
    () => competitionsApi.myTeams(),
  );

  const invitesQuery = usePrivateQuery<TeamInviteDto[], ApiError>(
    principalId,
    ['me', 'team-invites'],
    () => competitionsApi.myInvites(),
  );

  const invalidateTeams = () => {
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'me', 'teams'] });
    void queryClient.invalidateQueries({
      queryKey: ['principal', principalId, 'me', 'team-invites'],
    });
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'me', 'team-recruitments'] });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      competitionsApi.createTeam({ name: teamName.trim(), teamSize: Number(teamSize) }),
    onSuccess: () => {
      setError(null);
      setTeamName('');
      setCreateOpen(false);
      invalidateTeams();
    },
    onError: (cause: ApiError) => setError(cause.message),
  });

  const respondMutation = useMutation({
    mutationFn: (input: { inviteId: string; decision: 'accept' | 'decline' }) =>
      competitionsApi.respondInvite(input.inviteId, input.decision),
    onSuccess: () => {
      setError(null);
      invalidateTeams();
    },
    onError: (cause: ApiError) => setError(cause.message),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm leading-[22px] text-muted-foreground">
          常驻小队不与单场比赛强绑定；满员后可在「可报名赛事」中以队为单位提交。
        </p>
        <Button size="sm" onClick={() => setCreateOpen((previous) => !previous)}>
          <UsersIcon aria-hidden="true" />
          {createOpen ? '收起' : '建立小队'}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {createOpen && (
        <Card>
          <CardContent className="flex flex-col gap-3 p-4 sm:p-5">
            <form
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                createMutation.mutate();
              }}
            >
              <div className="grid flex-1 gap-1.5">
                <Label htmlFor="team-name">队名（2-80 字）</Label>
                <Input
                  id="team-name"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  minLength={2}
                  maxLength={80}
                  required
                />
              </div>
              <div className="grid gap-1.5 sm:w-36">
                <Label htmlFor="team-size">队伍人数</Label>
                <Input
                  id="team-size"
                  type="number"
                  min={2}
                  max={10}
                  value={teamSize}
                  onChange={(e) => setTeamSize(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={createMutation.isPending || teamName.trim().length < 2}>
                {createMutation.isPending && (
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                )}
                建立
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">
              人数需与目标赛事要求一致（如 ICPC/CCPC 为 3 人）；建队后你是队长。
            </p>
          </CardContent>
        </Card>
      )}

      <QueryBoundary
        query={invitesQuery}
        skeleton={<Skeleton className="h-16 rounded-xl" />}
        isEmpty={(list) => list.length === 0}
        emptyNode={null}
      >
        {(invites) => (
          <Card>
            <CardContent className="flex flex-col gap-2 p-4 sm:p-5">
              <h2 className="text-sm font-semibold text-foreground">待处理邀请</h2>
              <ul className="flex flex-col divide-y divide-border">
                {invites.map((invite) => (
                  <li
                    key={invite.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <span className="text-sm text-foreground">
                      {invite.team.name}
                      <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                        {invite.team.teamSize} 人队 · {formatDateTime(invite.createdAt)}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Button
                        size="sm"
                        disabled={respondMutation.isPending}
                        onClick={() =>
                          respondMutation.mutate({ inviteId: invite.id, decision: 'accept' })
                        }
                      >
                        接受
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={respondMutation.isPending}
                        onClick={() =>
                          respondMutation.mutate({ inviteId: invite.id, decision: 'decline' })
                        }
                      >
                        拒绝
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </QueryBoundary>

      <QueryBoundary
        query={teamsQuery}
        isEmpty={(list) => list.length === 0}
        emptyNode={
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              还没有小队；点击「建立小队」后邀请队友。
            </CardContent>
          </Card>
        }
      >
        {(teams) => (
          <ul className="flex flex-col gap-3">
            {teams.map((team) => (
              <li key={team.id}>
                <TeamCard principalId={principalId} team={team} onChanged={invalidateTeams} />
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </div>
  );
}

/**
 * 招募广场：浏览各队招募帖并申请加入（附留言），由队长审批；满员后招募自动关闭。
 * 手机单列、平板两列、宽屏三列。
 */
function RecruitmentBoard({ principalId }: { principalId: string }) {
  const [keyword, setKeyword] = useState('');
  const debounced = useDebouncedValue(keyword.trim());

  const boardQuery = usePrivateQuery<TeamRecruitmentDto[], ApiError>(
    principalId,
    ['me', 'team-recruitments', debounced],
    () => competitionsApi.recruitments(debounced),
  );
  const requestsQuery = usePrivateQuery<MyJoinRequestDto[], ApiError>(
    principalId,
    ['me', 'team-join-requests'],
    () => competitionsApi.myJoinRequests(),
  );
  const recentRequests = (requestsQuery.data ?? []).filter(
    (request) => request.status !== 'cancelled',
  ).slice(0, 5);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm leading-[22px] text-muted-foreground">
          各队队长在这里发布招募，申请后等待队长审批；想自己招人，到「我的小队」里发布招募。
        </p>
        <div className="relative sm:w-64">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索队名"
            aria-label="搜索队名"
            className="pl-9"
          />
        </div>
      </div>

      {recentRequests.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-2 p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-foreground">我的入队申请</h2>
            <ul className="flex flex-col divide-y divide-border">
              {recentRequests.map((request) => (
                <MyJoinRequestRow key={request.id} principalId={principalId} request={request} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <QueryBoundary
        query={boardQuery}
        skeleton={
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-48 rounded-xl" />
            ))}
          </div>
        }
        isEmpty={(list) => list.length === 0}
        emptyNode={
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              {debounced ? '没有匹配的招募。' : '暂时没有队伍在招募；你可以在「我的小队」建队并发布招募。'}
            </CardContent>
          </Card>
        }
      >
        {(list) => (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((recruitment) => (
              <li key={recruitment.id} className="min-w-0">
                <RecruitmentCard principalId={principalId} recruitment={recruitment} />
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </div>
  );
}

const JOIN_REQUEST_LABELS: Record<MyJoinRequestDto['status'], { label: string; variant: 'warning' | 'success' | 'destructive' | 'neutral' }> = {
  pending: { label: '待队长审批', variant: 'warning' },
  approved: { label: '已入队', variant: 'success' },
  rejected: { label: '未通过', variant: 'destructive' },
  cancelled: { label: '已撤回', variant: 'neutral' },
};

function MyJoinRequestRow({ principalId, request }: { principalId: string; request: MyJoinRequestDto }) {
  const queryClient = useQueryClient();
  const cancelMutation = useMutation({
    mutationFn: () => competitionsApi.cancelJoinRequest(request.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'me', 'team-join-requests'] });
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'me', 'team-recruitments'] });
    },
  });
  const meta = JOIN_REQUEST_LABELS[request.status];
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-foreground">
        <span className="truncate">{request.team.name}</span>
        <Badge variant={meta.variant}>{meta.label}</Badge>
        <span className="text-xs text-muted-foreground tabular-nums">{formatDateTime(request.createdAt)}</span>
      </span>
      {request.status === 'pending' && (
        <Button size="sm" variant="ghost" disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>
          撤回
        </Button>
      )}
    </li>
  );
}

function RecruitmentCard({ principalId, recruitment }: { principalId: string; recruitment: TeamRecruitmentDto }) {
  const queryClient = useQueryClient();
  const [applyOpen, setApplyOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pending = recruitment.myRequest?.status === 'pending';

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'me', 'team-recruitments'] });
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'me', 'team-join-requests'] });
  };
  const applyMutation = useMutation({
    mutationFn: () => competitionsApi.applyToTeam(recruitment.teamId, message.trim() || undefined),
    onSuccess: () => {
      setError(null);
      setApplyOpen(false);
      setMessage('');
      invalidate();
    },
    onError: (cause: ApiError) => setError(cause.message),
  });
  const cancelMutation = useMutation({
    mutationFn: () => competitionsApi.cancelJoinRequest(recruitment.myRequest!.id),
    onSuccess: invalidate,
    onError: (cause: ApiError) => setError(cause.message),
  });

  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col gap-3 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 truncate text-[15px] font-semibold text-foreground">{recruitment.teamName}</h3>
          <Badge variant="warning" className="shrink-0 tabular-nums">
            缺 {recruitment.slotsLeft} 人
          </Badge>
        </div>
        {recruitment.activity && (
          <Link
            to={`/app?section=activities&activity=${recruitment.activity.id}`}
            className="flex min-w-0 items-center gap-1.5 text-xs text-primary hover:underline"
          >
            <MegaphoneIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">为「{recruitment.activity.title}」招募</span>
          </Link>
        )}
        <p className="line-clamp-4 text-sm leading-[22px] break-words whitespace-pre-wrap text-foreground/90">
          {recruitment.description}
        </p>
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {recruitment.members.map((member) => (
            <li key={member.userId} className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <MemberAvatar assetId={member.avatarAssetId} name={member.name} size="xs" />
              <span className="max-w-[8rem] truncate">{member.name}</span>
              {member.role === 'captain' && <span className="text-primary">队长</span>}
            </li>
          ))}
          {Array.from({ length: recruitment.slotsLeft }, (_, index) => (
            <li
              key={`slot-${index}`}
              aria-label="空缺位置"
              className="size-6 rounded-full border border-dashed border-muted-foreground/40"
            />
          ))}
        </ul>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {applyOpen && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              applyMutation.mutate();
            }}
          >
            <Label htmlFor={`apply-${recruitment.id}`}>给队长的留言（可选）</Label>
            <Textarea
              id={`apply-${recruitment.id}`}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={3}
              maxLength={500}
              placeholder="比如擅长的方向、能投入的时间"
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={applyMutation.isPending}>
                {applyMutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
                提交申请
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setApplyOpen(false)}>
                取消
              </Button>
            </div>
          </form>
        )}

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-3">
          <span className="text-xs text-muted-foreground tabular-nums">
            {recruitment.teamSize} 人队 · 更新于 {formatDateTime(recruitment.updatedAt)}
          </span>
          {recruitment.isMember ? (
            <Badge variant="info">你在本队</Badge>
          ) : pending ? (
            <Button size="sm" variant="outline" disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>
              已申请 · 撤回
            </Button>
          ) : (
            !applyOpen && (
              <Button size="sm" onClick={() => setApplyOpen(true)}>
                申请加入
              </Button>
            )
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** 队长发布/编辑/关闭招募；可关联一个人数相同的团队活动 */
function RecruitmentEditor({
  principalId,
  team,
  onChanged,
}: {
  principalId: string;
  team: TeamDto;
  onChanged: () => void;
}) {
  const recruitment = team.recruitment;
  const isOpen = recruitment?.status === 'open';
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(recruitment?.description ?? '');
  const [activityId, setActivityId] = useState(recruitment?.activityId ?? 'none');
  const [error, setError] = useState<string | null>(null);

  const activitiesQuery = usePrivateQuery<{ items: Array<{ id: string; title: string; teamSize: number | null }> }, ApiError>(
    principalId,
    ['activities', 'list', 'open-team', team.teamSize],
    async () => (await api.get<{ items: Array<{ id: string; title: string; teamSize: number | null }> }>('/activities?tab=open')).data,
    { enabled: editing },
  );
  const teamActivities = (activitiesQuery.data?.items ?? []).filter((item) => item.teamSize === team.teamSize);

  const saveMutation = useMutation({
    mutationFn: () =>
      competitionsApi.upsertRecruitment(team.id, {
        description: description.trim(),
        activityId: activityId === 'none' ? null : activityId,
      }),
    onSuccess: () => {
      setError(null);
      setEditing(false);
      onChanged();
    },
    onError: (cause: ApiError) => setError(cause.message),
  });
  const closeMutation = useMutation({
    mutationFn: () => competitionsApi.closeRecruitment(team.id),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (cause: ApiError) => setError(cause.message),
  });

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-medium text-foreground">
          <MegaphoneIcon className="size-3.5" aria-hidden="true" />
          广场招募
          <Badge variant={isOpen ? 'success' : 'neutral'}>{isOpen ? '招募中' : '未招募'}</Badge>
        </p>
        {!editing && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDescription(recruitment?.description ?? '');
                setActivityId(recruitment?.activityId ?? 'none');
                setEditing(true);
              }}
            >
              {isOpen ? '编辑招募' : '发布招募'}
            </Button>
            {isOpen && (
              <Button size="sm" variant="ghost" disabled={closeMutation.isPending} onClick={() => closeMutation.mutate()}>
                关闭招募
              </Button>
            )}
          </div>
        )}
      </div>
      {isOpen && !editing && recruitment && (
        <p className="line-clamp-3 text-xs leading-5 break-words whitespace-pre-wrap text-muted-foreground">
          {recruitment.activity ? `为「${recruitment.activity.title}」招募 · ` : ''}
          {recruitment.description}
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {editing && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            saveMutation.mutate();
          }}
        >
          <Label htmlFor={`recruit-${team.id}`}>招募说明（至少 5 字）</Label>
          <Textarea
            id={`recruit-${team.id}`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="想找什么方向的队友、训练节奏、目标比赛等"
          />
          <Label htmlFor={`recruit-activity-${team.id}`}>关联团队活动（可选）</Label>
          <Select value={activityId} onValueChange={setActivityId}>
            <SelectTrigger id={`recruit-activity-${team.id}`} className="w-full">
              <SelectValue placeholder="不关联" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">不关联</SelectItem>
              {teamActivities.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={saveMutation.isPending || description.trim().length < 5}>
              {saveMutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
              {isOpen ? '保存' : '发布到广场'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              取消
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** 待处理的入队申请：全队可见，队长审批 */
function JoinRequestsList({ team, isCaptain, onChanged }: { team: TeamDto; isCaptain: boolean; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const decideMutation = useMutation({
    mutationFn: (input: { requestId: string; decision: 'approve' | 'reject' }) =>
      competitionsApi.decideJoinRequest(input.requestId, input.decision),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (cause: ApiError) => setError(cause.message),
  });
  if (team.joinRequests.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3">
      <p className="text-xs font-medium text-foreground">入队申请（{team.joinRequests.length}）</p>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <ul className="flex flex-col divide-y divide-border">
        {team.joinRequests.map((request) => (
          <li key={request.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <MemberAvatar assetId={memberAvatarId(request.user)} name={memberName(request.user)} size="sm" />
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground">{memberName(request.user)}</p>
                <p className="text-xs break-words text-muted-foreground">
                  {request.message ? request.message : '（无留言）'} · {formatDateTime(request.createdAt)}
                </p>
              </div>
            </div>
            {isCaptain && (
              <div className="flex gap-2 sm:shrink-0">
                <Button
                  size="sm"
                  disabled={decideMutation.isPending}
                  onClick={() => decideMutation.mutate({ requestId: request.id, decision: 'approve' })}
                >
                  同意
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={decideMutation.isPending}
                  onClick={() => decideMutation.mutate({ requestId: request.id, decision: 'reject' })}
                >
                  拒绝
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TeamCard({
  principalId,
  team,
  onChanged,
}: {
  principalId: string;
  team: TeamDto;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const isCaptain = team.captainUserId === principalId;
  const isFull = team.members.length >= team.teamSize;

  const leaveMutation = useMutation({
    mutationFn: () => competitionsApi.leaveTeam(team.id),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (cause: ApiError) => setError(cause.message),
  });

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
              {team.name}
              <Badge variant={isFull ? 'success' : 'warning'}>
                {team.members.length}/{team.teamSize} 人
              </Badge>
              {isCaptain && <Badge variant="info">我是队长</Badge>}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              建队于 {formatDateTime(team.createdAt)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!isFull && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setInviteOpen((previous) => !previous)}
              >
                {inviteOpen ? '收起邀请' : '邀请队员'}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={leaveMutation.isPending}
              onClick={() => leaveMutation.mutate()}
            >
              退出小队
            </Button>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {team.members.map((member) => (
            <li key={member.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <MemberAvatar assetId={memberAvatarId(member.user)} name={memberName(member.user, '队员')} size="xs" />
              {memberName(member.user, '队员')}
              {member.role === 'captain' && <span className="ml-1 text-primary">队长</span>}
            </li>
          ))}
        </ul>

        {inviteOpen && (
          <InvitePicker
            principalId={principalId}
            teamId={team.id}
            onInvited={() => {
              setInviteOpen(false);
              onChanged();
            }}
          />
        )}

        {isCaptain && team.status === 'forming' && (!isFull || team.recruitment?.status === 'open') && (
          <RecruitmentEditor principalId={principalId} team={team} onChanged={onChanged} />
        )}

        <JoinRequestsList team={team} isCaptain={isCaptain} onChanged={onChanged} />

        {team.entries.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-border pt-3">
            <p className="text-xs font-medium text-foreground">已报名赛事</p>
            <ul className="flex flex-col gap-1">
              {team.entries.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-foreground">{entry.event.title}</span>
                  <Badge
                    variant={
                      entry.status === 'rejected'
                        ? 'destructive'
                        : entry.status === 'approved' || entry.status === 'confirmed'
                          ? 'success'
                          : 'warning'
                    }
                  >
                    {entryStatusLabel(entry.status)}
                  </Badge>
                  {entry.resultScore && (
                    <span className="text-muted-foreground tabular-nums">
                      每人 {entry.resultScore} 分
                    </span>
                  )}
                  {entry.reviewNote && (
                    <span className="text-muted-foreground">{entry.reviewNote}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <EligibleEventsForTeam principalId={principalId} team={team} onRegistered={onChanged} />
      </CardContent>
    </Card>
  );
}

/** 队员检索：输入 2 字以上按昵称/实名/学号匹配，学号仅显示后四位用于同名消歧 */
function InvitePicker({
  principalId,
  teamId,
  onInvited,
}: {
  principalId: string;
  teamId: string;
  onInvited: () => void;
}) {
  const [keyword, setKeyword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const searchQuery = usePrivateQuery<InvitableMemberDto[], ApiError>(
    principalId,
    ['me', 'invitable-members', keyword],
    () => competitionsApi.searchInvitableMembers(keyword),
    { enabled: keyword.trim().length >= 2 },
  );

  const inviteMutation = useMutation({
    mutationFn: (inviteeUserId: string) => competitionsApi.invite(teamId, inviteeUserId),
    onSuccess: () => {
      setError(null);
      onInvited();
    },
    onError: (cause: ApiError) => setError(cause.message),
  });

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border p-3">
      <div className="grid gap-1.5">
        <Label htmlFor={`invite-q-${teamId}`}>检索队员（昵称 / 姓名 / 学号，≥2 字）</Label>
        <Input
          id={`invite-q-${teamId}`}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="输入后自动检索"
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {keyword.trim().length < 2 ? (
        <p className="text-xs text-muted-foreground">请至少输入 2 个字符。</p>
      ) : searchQuery.isPending ? (
        <Skeleton className="h-10 rounded-lg" />
      ) : searchQuery.isError ? (
        <p className="text-xs text-destructive">{searchQuery.error.message}</p>
      ) : searchQuery.data.length === 0 ? (
        <p className="text-xs text-muted-foreground">没有匹配的在册成员。</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {searchQuery.data.map((candidate) => (
            <li
              key={candidate.userId}
              className="flex items-center justify-between gap-2 py-1.5 text-xs"
            >
              <span className="flex min-w-0 items-center gap-2 truncate text-foreground">
                <MemberAvatar assetId={candidate.avatarAssetId} name={candidate.displayName} size="xs" />
                {candidate.displayName}
                <span className="ml-2 font-mono text-muted-foreground">
                  {candidate.studentNoMasked}
                </span>
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={inviteMutation.isPending}
                onClick={() => inviteMutation.mutate(candidate.userId)}
              >
                邀请
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EligibleEventsForTeam({
  principalId,
  team,
  onRegistered,
}: {
  principalId: string;
  team: TeamDto;
  onRegistered: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const query = usePrivateQuery<EligibleEventDto[], ApiError>(
    principalId,
    ['me', 'team-eligible-events', team.id],
    () => competitionsApi.eligibleEvents(team.id),
  );

  const registerMutation = useMutation({
    mutationFn: (eventId: string) => competitionsApi.registerTeam(team.id, eventId),
    onSuccess: () => {
      setError(null);
      onRegistered();
    },
    onError: (cause: ApiError) => setError(cause.message),
  });

  const registeredIds = new Set(team.entries.map((entry) => entry.eventId));
  const isFull = team.members.length >= team.teamSize;

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <p className="text-xs font-medium text-foreground">可报名赛事</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {query.isPending ? (
        <Skeleton className="h-12 rounded-lg" />
      ) : query.isError ? (
        <p className="text-xs text-muted-foreground">{query.error.message}</p>
      ) : query.data.filter((row) => !registeredIds.has(row.event.id)).length === 0 ? (
        <p className="text-xs text-muted-foreground">
          暂无与 {team.teamSize} 人队匹配且仍在报名期的赛事。
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {query.data
            .filter((row) => !registeredIds.has(row.event.id))
            .map((row) => (
              <li
                key={row.event.id}
                className="flex flex-wrap items-center justify-between gap-2 text-xs"
              >
                <span className="min-w-0">
                  <span className="text-foreground">{row.event.title}</span>
                  <span className="ml-2 text-muted-foreground tabular-nums">
                    截止 {formatDateTime(row.event.registerDeadline)}
                  </span>
                  {!row.eligible && row.reason && (
                    <span className="ml-2 text-muted-foreground">（{row.reason}）</span>
                  )}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={registerMutation.isPending || !row.eligible || !isFull}
                  onClick={() => registerMutation.mutate(row.event.id)}
                >
                  {!isFull ? '需满员' : row.eligible ? '报名' : '不符合条件'}
                </Button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
