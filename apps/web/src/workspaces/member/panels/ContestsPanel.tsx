/**
 * 成员端 · 竞赛与贡献。
 * Tabs：平台记录（绑定 + 成绩 + 申请刷新）/ 指定与备案（说明）/ 正式赛报名（冻结榜说明）/
 * 贡献申报（类别卡片 + 表单）。
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BookOpenIcon,
  FileSignatureIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  SnowflakeIcon,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrivateInfiniteQuery } from '@/lib/private-infinite';
import { usePrincipal } from '@/lib/session';
import { LoadMoreButton } from '@/lib/hooks';
import {
  CLAIM_CATEGORIES,
  formatDateTime,
  platformAccountBadge,
  platformLabel,
} from '@/lib/format';
import { PanelHeader } from '@/components/club/PanelHeader';
import { BindPlatformAccountDialog } from '@/components/club/BindPlatformAccountDialog';
import { MemberGate, QueryBoundary } from '@/components/club/QueryBoundary';
import { StatusBadge } from '@/components/club/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

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

const TABS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'records', label: '平台记录' },
  { value: 'designated', label: '指定与备案' },
  { value: 'entry', label: '正式赛报名' },
  { value: 'claims', label: '贡献申报' },
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
        title="竞赛与贡献"
        description="平台账号绑定、比赛成绩同步与贡献成果申报。"
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
        <TabsList aria-label="竞赛与贡献子页">
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
          <FrozenEntryInfo />
        </TabsContent>
        <TabsContent value="claims" className="mt-4">
          <ClaimForm principalId={principalId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PlatformRecords({ principalId }: { principalId: string }) {
  const [bindOpen, setBindOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const accountsQuery = usePrivateQuery<PlatformAccountDto[], ApiError>(
    principalId,
    ['me', 'platform-accounts'],
    async () => (await api.get<PlatformAccountDto[]>('/me/platform-accounts')).data,
  );

  const resultsQuery = usePrivateInfiniteQuery<
    { items: CompetitionResultDto[]; nextCursor?: string | null },
    ApiError
  >(principalId, ['profiles', 'competition-results', principalId], async (cursor) => {
    const params = new URLSearchParams();
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
            <h2 className="text-sm font-semibold text-foreground">比赛成绩（同步记录）</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              来源为平台公开数据同步；非本人绑定账号的成绩不会出现。
            </p>
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
            <p className="px-5 pb-4 text-sm text-muted-foreground">
              暂无同步到的比赛成绩；绑定并核验账号后点击「申请刷新」。
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
                  <span className="text-xs text-muted-foreground">
                    {platformLabel(row.platform)} · {row.participationType}
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
            <span className="text-xs text-muted-foreground">
              {platformLabel(row.platform)} · {formatDateTime(row.startTime)}
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

function DesignatedInfo() {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <BookOpenIcon className="size-4 text-input" aria-hidden="true" />
          指定比赛与备案
        </h2>
        <div className="flex flex-col gap-2 text-sm leading-[22px] text-foreground/90">
          <p>
            「指定比赛」由主席团按学期在公告中公布（社内赛、网络赛、区域赛等），指定范围决定
            E 分中比赛类积分的认定口径；目录认定与备案条款的专项映射（R13）尚未定稿。
          </p>
          <p>
            参加非指定但希望纳入记录的比赛，请在活动公告发布前向主席团备案：比赛名称、时间、
            参赛名单与成绩凭证。备案通过后成绩计入个人档案，是否计分按当期规则执行。
          </p>
          <p className="text-muted-foreground">
            当前指定目录与备案记录由负责人通过公告发布；本页后续接入接口后会展示实时列表。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function FrozenEntryInfo() {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <SnowflakeIcon className="size-4 text-input" aria-hidden="true" />
          正式赛报名与冻结榜
        </h2>
        <div className="flex flex-col gap-2 text-sm leading-[22px] text-foreground/90">
          <p>
            正式赛的报名在对应平台（牛客 / Codeforces / AtCoder）进行，社团侧通过「活动」页的
            平台赛记录到场与出勤；两边分别办理。
          </p>
          <p>
            报名截止前一日 22:00 生成赛事冻结榜：名单锁定后回填成绩不改变出场资格。冻结榜在
            「榜单」面板的「赛事冻结榜」页签查看（含锁定标记，不随当前分变化）。
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => {
            window.location.assign('/app?section=ranking&tab=frozen');
          }}
        >
          前往榜单 · 赛事冻结榜
        </Button>
      </CardContent>
    </Card>
  );
}

function ClaimForm({ principalId }: { principalId: string }) {
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [evidenceNote, setEvidenceNote] = useState('');

  const mutation = useMutation({
    mutationFn: async (input: {
      category: string;
      title: string;
      description: string;
      evidenceNote?: string;
    }) => (await api.post<{ claimId: string }>('/me/claims', input)).data,
    onSuccess: () => {
      setCategory(null);
      setTitle('');
      setDescription('');
      setEvidenceNote('');
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'me'] });
    },
  });

  if (category == null) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {CLAIM_CATEGORIES.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => setCategory(item.value)}
            className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-5 text-left transition-colors hover:border-primary/50"
          >
            <FileSignatureIcon className="size-5 text-input" aria-hidden="true" />
            <span className="text-sm font-semibold text-foreground">{item.title}</span>
            <span className="text-xs leading-5 text-muted-foreground">{item.description}</span>
          </button>
        ))}
      </div>
    );
  }

  const meta = CLAIM_CATEGORIES.find((item) => item.value === category);
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">
            贡献申报 · {meta?.title ?? category}
          </h2>
          <Button size="sm" variant="ghost" onClick={() => setCategory(null)}>
            返回类别
          </Button>
        </div>
        {mutation.isSuccess && (
          <Alert>
            <AlertTitle>已提交</AlertTitle>
            <AlertDescription>
              申报已进入审核队列，审核通过后按规则计入贡献类积分。
            </AlertDescription>
          </Alert>
        )}
        {mutation.isError && (
          <Alert variant="destructive">
            <AlertTitle>提交失败</AlertTitle>
            <AlertDescription>{(mutation.error as ApiError).message}</AlertDescription>
          </Alert>
        )}
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate({
              category,
              title: title.trim(),
              description: description.trim(),
              evidenceNote: evidenceNote.trim() || undefined,
            });
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="claim-title">标题（2-120 字）</Label>
            <Input
              id="claim-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              minLength={2}
              maxLength={120}
              placeholder="如：10-12 例会讲题 CF1234E"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="claim-desc">说明（5-2000 字）</Label>
            <Textarea
              id="claim-desc"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              required
              minLength={5}
              maxLength={2000}
              rows={5}
              placeholder="做了什么、在哪可以看到、涉及哪场比赛或活动"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="claim-evidence">佐证说明（可选）</Label>
            <Input
              id="claim-evidence"
              value={evidenceNote}
              onChange={(event) => setEvidenceNote(event.target.value)}
              maxLength={500}
              placeholder="如博客链接、仓库链接"
            />
          </div>
          <Button type="submit" disabled={mutation.isPending || title.trim().length < 2 || description.trim().length < 5}>
            {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            提交申报
          </Button>
        </form>
      </CardContent>
    </Card>
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
