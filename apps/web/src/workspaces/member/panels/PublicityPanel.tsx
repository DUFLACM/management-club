import { useState } from 'react';
import { Link, useMatch, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownWideNarrowIcon, CalendarDaysIcon, ClipboardListIcon, Clock3Icon, ExternalLinkIcon,
  FlagIcon, GraduationCapIcon, HandHeartIcon, Layers3Icon, LockKeyholeIcon, MedalIcon, SearchIcon,
  TicketPlusIcon, TrophyIcon, type LucideIcon,
} from 'lucide-react';

import { EmptyState } from '@/components/club/EmptyState';
import { MemberAvatar } from '@/components/club/MemberAvatar';
import { QueryBoundary } from '@/components/club/QueryBoundary';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiError } from '@/lib/api';
import { formatTime, LEDGER_CATEGORY_LABELS, monthLabel } from '@/lib/format';
import { LoadMoreButton } from '@/lib/hooks';
import { usePrivateInfiniteQuery, type CursorPage } from '@/lib/private-infinite';
import { usePrincipalQuery } from '@/lib/session';
import { startCasLogin } from '@/features/auth/cas';
import { cn } from '@/lib/utils';
import './PublicityPanel.css';

interface PublicSemesters {
  semesters: Array<{ id: string; code: string; name: string }>;
  defaultSemesterId: string | null;
}

interface EvaluationRow {
  rank: number;
  displayName: string;
  hScore: number;
  tier: 'A' | 'B' | 'C';
  suggestedScore: number;
  needsManual: boolean;
  isMe?: boolean;
}

interface BonusEntry {
  id: string;
  displayName: string;
  eventName: string;
  category: string;
  amount: string;
  scoreMonth: string;
  recordedAt: string;
}

const liveQueryOptions = { staleTime: 0, refetchOnWindowFocus: true, refetchInterval: 60_000 };
const evaluationWeights = [
  { label: '学期积分', weight: 70 },
  { label: '竞赛', weight: 20 },
  { label: '服务', weight: 10 },
];

export default function PublicityPanel() {
  const session = usePrincipalQuery();
  const memberId = session.data?.authenticated ? session.data.userId : null;
  const shared = useMatch('/publicity') !== null;
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'bonus' ? 'bonus' : 'evaluation';
  const semesters = useQuery<PublicSemesters, ApiError>({
    queryKey: ['public', 'evaluation', 'semesters'],
    queryFn: async () => (await api.get<PublicSemesters>('/public/evaluation/semesters')).data,
    refetchOnWindowFocus: true,
  });
  function selectParam(key: string, value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set(key, value);
      return next;
    });
  }
  return (
    <div className="mx-auto w-full max-w-[1260px]">
      <QueryBoundary query={semesters}>
        {({ semesters: choices, defaultSemesterId }) => {
          const semesterId = choices.find((s) => s.id === params.get('semester'))?.id ?? defaultSemesterId;
          if (!semesterId) {
            return (
              <section>
                <h1 className="text-2xl font-semibold">学期公示</h1>
                <EmptyState title="暂无可查看的学期" description="学期开始后，可在这里查看综测和加分记录。" />
              </section>
            );
          }
          const selected = choices.find((s) => s.id === semesterId);
          const shareUrl = '/publicity?' + new URLSearchParams({ semester: semesterId, tab });
          return (
            <Tabs value={tab} activationMode="manual" onValueChange={(value) => selectParam('tab', value)}>
              <header className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 sm:mb-6">
                <h1 className="text-[26px] leading-tight font-semibold tracking-tight sm:text-[34px]">学期公示</h1>
                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                  {!shared && <Button asChild size="sm" variant="ghost" className="px-2 text-muted-foreground">
                    <Link to={shareUrl} target="_blank" rel="noreferrer"><ExternalLinkIcon aria-hidden="true" />公示链接</Link>
                  </Button>}
                  {choices.length === 1 ? (
                    <span className="inline-flex min-w-0 max-w-full items-center gap-2 text-sm text-muted-foreground" title={selected?.name}>
                      <CalendarDaysIcon className="size-4 shrink-0" aria-hidden="true" /><span className="truncate">{selected?.name}</span>
                    </span>
                  ) : (
                    <Select value={semesterId} onValueChange={(id) => selectParam('semester', id)}>
                      <SelectTrigger
                        aria-label="公示学期" title={selected?.name}
                        className="h-9 w-max max-w-full shrink-0 gap-2 whitespace-nowrap rounded-xl border-border px-3 text-left shadow-xs"
                      >
                        <CalendarDaysIcon aria-hidden="true" />
                        <span className="min-w-0 truncate"><SelectValue /></span>
                      </SelectTrigger>
                      <SelectContent>
                        {choices.map((semester) => (
                          <SelectItem key={semester.id} value={semester.id}>{semester.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </header>
              <TabsList aria-label="公示类型" className="pub-tabs">
                <TabsTrigger value="evaluation"><GraduationCapIcon aria-hidden="true" />实时综测</TabsTrigger>
                <TabsTrigger value="bonus"><ClipboardListIcon aria-hidden="true" />加分公示</TabsTrigger>
              </TabsList>
              <TabsContent value="evaluation" className="mt-4 sm:mt-5">
                <EvaluationBoard key={semesterId} memberId={shared ? null : memberId} semesterId={semesterId} />
              </TabsContent>
              <TabsContent value="bonus" className="mt-4 sm:mt-5">
                {memberId ? <BonusBoard memberId={memberId} semesterId={semesterId} />
                  : session.isPending ? <p role="status" className="py-8 text-center text-muted-foreground">正在确认登录状态…</p>
                  : <BonusLogin returnTarget={shareUrl} authenticated={session.data?.authenticated === true} />}
              </TabsContent>
            </Tabs>
          );
        }}
      </QueryBoundary>
    </div>
  );
}

type BoardProps = { memberId: string; semesterId: string };

function BonusLogin({ returnTarget, authenticated }: { returnTarget: string; authenticated: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function login() {
    setBusy(true);
    setError('');
    try {
      await startCasLogin({ returnTarget });
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : '登录暂时不可用，请重试。');
    }
  }
  return (
    <section className="pub-sheet flex flex-col items-center gap-3 px-5 py-14 text-center">
      <span className="rounded-2xl bg-secondary p-3 text-primary"><LockKeyholeIcon aria-hidden="true" /></span>
      <h2 className="text-xl font-semibold">{authenticated ? '仅在册成员可查看加分公示' : '登录后查看加分公示'}</h2>
      <p className="text-sm text-muted-foreground">加分明细向已登录的在册社团成员开放。</p>
      {!authenticated && <Button onClick={() => void login()} disabled={busy}>{busy ? '正在跳转…' : '使用校园账号登录'}</Button>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </section>
  );
}

function EvaluationBoard({ memberId, semesterId }: { memberId: string | null; semesterId: string }) {
  const query = useQuery<{ rows: EvaluationRow[] }, ApiError>({
    queryKey: memberId ? ['principal', memberId, 'me', 'evaluation', 'leaderboard', semesterId]
      : ['public', 'evaluation', 'leaderboard', semesterId],
    queryFn: async () => {
      const path = `/evaluation/semesters/${semesterId}/leaderboard`;
      if (memberId) {
        try {
          return (await api.get<{ rows: EvaluationRow[] }>(`/me${path}`)).data;
        } catch (cause) {
          if (!(cause instanceof ApiError && cause.status === 403)) throw cause;
        }
      }
      return (await api.get<{ rows: EvaluationRow[] }>(`/public${path}`)).data;
    },
    ...liveQueryOptions,
  });
  return (
    <QueryBoundary query={query}
      isEmpty={({ rows }) => rows.length === 0}
      emptyNode={<div className="pub-sheet"><EmptyState title="本学期暂无综测名次" description="有成员符合定档条件后，这里会显示名次和建议加分。" /></div>}>
      {({ rows }) => (
        <div className="grid gap-4 sm:gap-5">
          <div className="grid gap-3 lg:grid-cols-[1.27fr_1fr] lg:gap-5">
            <EvaluationSummary rows={rows} />
            <div className="pub-sheet pub-weights">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><Layers3Icon className="size-4 text-primary" aria-hidden="true" />综合分构成</h2>
              <div className="pub-weight-bar" aria-hidden="true">
                {evaluationWeights.map(({ label, weight }) => <i key={label} style={{ flexGrow: weight }} />)}
              </div>
              <ul className="grid grid-cols-3 gap-2 text-xs">
                {evaluationWeights.map(({ label, weight }) => (
                  <li key={label}><span className="block text-muted-foreground">{label}</span>
                    <strong className="mt-0.5 block text-base font-semibold tabular-nums">{weight}<small>%</small></strong>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">各项按参评成员中的百分位折算，加权后扣除纪律分。</p>
            </div>
          </div>
          <RankingList rows={rows} updatedAt={query.dataUpdatedAt} />
        </div>
      )}
    </QueryBoundary>
  );
}

const tierColors = { A: 'bg-success-subtle text-success', B: 'bg-info-subtle text-info', C: 'bg-muted text-muted-foreground' };

function EvaluationSummary({ rows }: { rows: EvaluationRow[] }) {
  const mine = rows.find((r) => r.isMe);
  const stats = mine
    ? [{ label: '学期名次', value: `${mine.rank} / ${rows.length}` }, { label: '建议加分', value: mine.suggestedScore.toFixed(3) }]
    : (['A', 'B', 'C'] as const).map((tier) => ({ label: `${tier} 档`, value: String(rows.filter((r) => r.tier === tier).length) }));
  return (
    <section className="pub-scorecard">
      <div className="relative z-10 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium"><GraduationCapIcon className="size-[19px]" aria-hidden="true" />{mine ? '我的学期综测' : '学期参评概览'}</h2>
        {mine && <span className="rounded-full border border-white/25 px-2.5 text-xs leading-6">{mine.tier} 档{mine.needsManual && ' · 并列待认定'}</span>}
      </div>
      <div className="relative z-10 mt-4 flex flex-wrap items-end gap-x-7 gap-y-3 sm:mt-6">
        <div className="mr-auto">
          <p className="mb-0.5 text-xs text-white/80">{mine ? '综合分 H' : '参评成员'}</p>
          <p className="text-[38px] leading-none font-semibold tracking-tight tabular-nums sm:text-[48px]">{mine ? mine.hScore.toFixed(2) : rows.length}
            {!mine && <span className="ml-1.5 text-sm font-medium">人</span>}
          </p>
        </div>
        <dl className="flex gap-4 border-l border-white/25 pl-4 sm:gap-6 sm:pl-6">
          {stats.map((s) => <div key={s.label}><dt className="text-xs text-white/80">{s.label}</dt><dd className="mt-1 text-lg leading-none font-semibold tabular-nums sm:text-xl">{s.value}</dd></div>)}
        </dl>
      </div>
    </section>
  );
}

function RankingList({ rows, updatedAt }: { rows: EvaluationRow[]; updatedAt: number }) {
  const [name, setName] = useState('');
  const needle = name.trim().toLocaleLowerCase();
  const matches = needle ? rows.filter((row) => row.displayName.toLocaleLowerCase().includes(needle)) : rows;
  return (
    <section className="pub-sheet overflow-hidden">
      <div className="pub-sheet-heading">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-lg font-semibold tracking-tight">综测排名</h2>
          <span className="text-xs text-muted-foreground">{rows.length} 人</span>
        </div>
        <label className="pub-search"><SearchIcon className="size-4 shrink-0" aria-hidden="true" />
          <input type="search" aria-label="搜索成员" placeholder="搜索成员" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
      </div>
      <Table aria-label="学期实时综测排名" className="pub-table">
        <TableHeader><TableRow>
          <TableHead className="pub-rank-cell">名次</TableHead><TableHead>成员</TableHead>
          <TableHead className="text-right">综合分 H</TableHead>
          <TableHead className="hidden text-center sm:table-cell">档位</TableHead>
          <TableHead className="pub-last-cell text-right">建议加分</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {matches.map((row) => (
            <TableRow key={row.rank} data-mine={row.isMe || undefined}>
              <TableCell className="pub-rank-cell"><span className={cn('font-mono text-sm', row.rank <= 3 ? 'font-bold text-primary' : 'text-muted-foreground')}>{row.rank}</span></TableCell>
              <TableCell className="pub-name-cell">
                <div className="flex items-center gap-2.5">
                  <span aria-hidden="true" className="hidden sm:block"><MemberAvatar name={row.displayName} className="rounded-xl ring-0" /></span>
                  <div className="min-w-0">
                    <span className="font-medium [overflow-wrap:anywhere]">{row.displayName}</span>
                    {row.isMe && <span className="ml-1.5 text-xs text-primary">我</span>}
                    <div className="flex flex-wrap items-center gap-x-2 text-xs leading-5">
                      <span className="text-muted-foreground sm:hidden">{row.tier} 档</span>
                      {row.needsManual && <span className="text-warning">并列待认定</span>}
                    </div>
                  </div>
                </div>
              </TableCell>
              <TableCell className="text-right font-semibold tabular-nums">{row.hScore.toFixed(2)}</TableCell>
              <TableCell className="hidden text-center sm:table-cell"><span className={cn('inline-flex rounded-md px-2 py-0.5 text-xs font-semibold', tierColors[row.tier])}>{row.tier} 档</span></TableCell>
              <TableCell className="pub-last-cell text-right tabular-nums">{row.suggestedScore.toFixed(3)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {matches.length === 0 && <div className="py-6 text-center"><p className="text-sm text-muted-foreground">没有匹配的成员</p><Button variant="link" onClick={() => setName('')}>清除搜索</Button></div>}
      <p className="flex items-center gap-1.5 border-t border-border px-4 py-2.5 text-xs text-muted-foreground sm:px-6"><Clock3Icon className="size-3.5" aria-hidden="true" />更新于 {formatTime(new Date(updatedAt))}</p>
    </section>
  );
}

const postingDay = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
const bonusIcons: Record<string, LucideIcon> = {
  contest: TrophyIcon, remote_contest: TrophyIcon, award: MedalIcon,
  contribution: HandHeartIcon, service: HandHeartIcon, activity: FlagIcon,
};

function BonusBoard({ memberId, semesterId }: BoardProps) {
  const query = usePrivateInfiniteQuery<CursorPage<BonusEntry>>(
    memberId,
    ['me', 'bonus-records', semesterId],
    async (cursor) => {
      const params = new URLSearchParams({ semesterId });
      if (cursor) params.set('cursor', cursor);
      return (await api.get<CursorPage<BonusEntry>>(`/me/bonus-records?${params}`)).data;
    },
    liveQueryOptions,
  );
  return (
    <QueryBoundary query={query}
      isEmpty={({ pages }) => pages.every((page) => page.items.length === 0)}
      emptyNode={<div className="pub-sheet"><EmptyState title="本学期暂无公示的加分记录" description="已生效并公开的加分条目会显示在这里。" /></div>}>
      {({ pages }) => {
        const byDay = new Map<string, BonusEntry[]>();
        for (const page of pages) {
          for (const entry of page.items) {
            const day = postingDay.format(new Date(entry.recordedAt));
            if (!byDay.has(day)) byDay.set(day, []);
            byDay.get(day)!.push(entry);
          }
        }
        return (
          <section className="pub-sheet overflow-hidden">
            <div className="pub-sheet-heading">
              <h2 className="text-lg font-semibold tracking-tight">加分记录</h2>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><ArrowDownWideNarrowIcon className="size-4" aria-hidden="true" />按入账时间</span>
            </div>
            <div aria-label="加分公示明细">
              {[...byDay].map(([day, entries]) => (
                <section key={day}>
                  <h3 className="flex items-center gap-2 border-y border-border/70 bg-muted/55 px-4 py-2 text-xs font-medium text-muted-foreground sm:px-6">
                    <CalendarDaysIcon className="size-3.5" aria-hidden="true" />{day}
                  </h3>
                  <ul className="divide-y divide-border/70 px-4 sm:px-6">
                    {entries.map((entry) => {
                      const Icon = bonusIcons[entry.category] ?? TicketPlusIcon;
                      return (
                        <li key={entry.id} className="flex items-center gap-3 py-4">
                          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-secondary text-primary"><Icon className="size-[17px]" aria-hidden="true" /></span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold [overflow-wrap:anywhere]">{entry.eventName}</p>
                            <p className="mt-1 flex flex-wrap gap-x-2 text-xs leading-5 text-muted-foreground">
                              <span className="text-foreground [overflow-wrap:anywhere]">{entry.displayName}</span>
                              <span>{LEDGER_CATEGORY_LABELS[entry.category] ?? entry.category}</span>
                              <span>计入{monthLabel(entry.scoreMonth)}</span>
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="font-semibold text-success tabular-nums">+{entry.amount}</p>
                            <time dateTime={entry.recordedAt} className="text-xs text-muted-foreground tabular-nums">{formatTime(entry.recordedAt)}</time>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
            {query.hasNextPage && <LoadMoreButton hasNext loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} />}
          </section>
        );
      }}
    </QueryBoundary>
  );
}
