import { useSearchParams } from 'react-router';

import { EmptyState } from '@/components/club/EmptyState';
import { PanelHeader } from '@/components/club/PanelHeader';
import { MemberGate, QueryBoundary } from '@/components/club/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { formatDateTime, LEDGER_CATEGORY_LABELS, monthLabel } from '@/lib/format';
import { LoadMoreButton } from '@/lib/hooks';
import { usePrivateInfiniteQuery, type CursorPage } from '@/lib/private-infinite';
import { usePrivateQuery } from '@/lib/query';
import { usePrincipal } from '@/lib/session';

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
  isMe: boolean;
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

export default function PublicityPanel() {
  const principal = usePrincipal();
  return (
    <MemberGate principal={principal}>
      {(memberId) => <PublicityBody memberId={memberId} />}
    </MemberGate>
  );
}

function PublicityBody({ memberId }: { memberId: string }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'bonus' ? 'bonus' : 'evaluation';
  const semesters = usePrivateQuery(
    memberId,
    ['me', 'evaluation', 'semesters'],
    async () => (await api.get<PublicSemesters>('/me/evaluation/semesters')).data,
    { refetchOnWindowFocus: true },
  );
  function selectParam(key: string, value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set(key, value);
      return next;
    });
  }
  return (
    <div className="flex flex-col gap-4">
      <PanelHeader title="公示" />
      <QueryBoundary query={semesters}>
        {({ semesters: choices, defaultSemesterId }) => {
          const semesterId = choices.find((s) => s.id === params.get('semester'))?.id ?? defaultSemesterId;
          if (!semesterId) {
            return <EmptyState title="暂无可查看的学期" description="学期开始后，可在这里查看综测和加分记录。" />;
          }
          return (
            <Tabs value={tab} onValueChange={(value) => selectParam('tab', value)}>
              <div className="flex flex-col gap-3 sm:flex-row-reverse sm:items-center">
                <Select value={semesterId} onValueChange={(id) => selectParam('semester', id)}>
                  <SelectTrigger aria-label="公示学期" className="w-full sm:w-auto sm:max-w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {choices.map((semester) => (
                      <SelectItem key={semester.id} value={semester.id}>{semester.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <TabsList aria-label="公示类型">
                  <TabsTrigger value="evaluation">实时综测</TabsTrigger>
                  <TabsTrigger value="bonus">加分公示</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="evaluation" className="mt-4">
                <EvaluationBoard memberId={memberId} semesterId={semesterId} />
              </TabsContent>
              <TabsContent value="bonus" className="mt-4">
                <BonusBoard memberId={memberId} semesterId={semesterId} />
              </TabsContent>
            </Tabs>
          );
        }}
      </QueryBoundary>
    </div>
  );
}

type BoardProps = { memberId: string; semesterId: string };

function EvaluationBoard({ memberId, semesterId }: BoardProps) {
  const query = usePrivateQuery(
    memberId,
    ['me', 'evaluation', 'leaderboard', semesterId],
    async () => (await api.get<{ rows: EvaluationRow[] }>(`/me/evaluation/semesters/${semesterId}/leaderboard`)).data,
    liveQueryOptions,
  );
  return (
    <QueryBoundary
      query={query}
      isEmpty={({ rows }) => rows.length === 0}
      emptyNode={<EmptyState title="本学期暂无综测名次" description="有成员符合定档条件后，这里会显示名次和建议加分。" />}
    >
      {({ rows }) => (
        <Card className="overflow-hidden">
          <p className="px-4 py-3 text-sm text-muted-foreground">
            学期积分、竞赛和服务三项标准分分别占 70%、20% 和 10%，扣除纪律分后，按综合分 H 排名定档。
          </p>
          <Table aria-label="学期实时综测排名">
            <TableHeader>
              <TableRow>
                <TableHead className="px-2 sm:pl-4">名次</TableHead>
                <TableHead className="px-2">成员</TableHead>
                <TableHead className="px-2 text-right">综合分 H</TableHead>
                <TableHead className="hidden text-center sm:table-cell">档位</TableHead>
                <TableHead className="px-2 text-right sm:pr-4">建议加分</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.rank} data-state={row.isMe ? 'selected' : undefined}>
                  <TableCell className="px-2 font-medium tabular-nums sm:pl-4">{row.rank}</TableCell>
                  <TableCell className="max-w-44 px-2">
                    <span className="break-words font-medium">{row.displayName}</span>
                    {row.isMe && <span className="ml-1 text-xs text-primary">（我）</span>}
                    {row.needsManual && <span className="mt-1 block text-xs text-muted-foreground">并列待认定</span>}
                    <span className="mt-1 block text-xs text-muted-foreground sm:hidden">{row.tier} 档</span>
                  </TableCell>
                  <TableCell className="px-2 text-right tabular-nums">{row.hScore.toFixed(2)}</TableCell>
                  <TableCell className="hidden text-center sm:table-cell"><Badge variant="outline">{row.tier} 档</Badge></TableCell>
                  <TableCell className="px-2 text-right font-medium tabular-nums sm:pr-4">{row.suggestedScore.toFixed(3)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </QueryBoundary>
  );
}

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
    <QueryBoundary
      query={query}
      isEmpty={({ pages }) => pages.every((page) => page.items.length === 0)}
      emptyNode={<EmptyState title="本学期暂无公示的加分记录" description="已生效并公开的加分条目会显示在这里。" />}
    >
      {({ pages }) => (
        <Card>
          <ul className="divide-y divide-border" aria-label="加分公示明细">
            {pages.flatMap((page) => page.items).map((entry) => (
              <li key={entry.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium">{entry.eventName}</p>
                  <p className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs leading-5 text-muted-foreground">
                    <span className="break-words text-foreground">{entry.displayName}</span>
                    <span>{LEDGER_CATEGORY_LABELS[entry.category] ?? entry.category}</span>
                    <span>计入{monthLabel(entry.scoreMonth)}</span>
                  </p>
                  <p className="text-xs leading-5 text-muted-foreground">入账于 {formatDateTime(entry.recordedAt)}</p>
                </div>
                <span className="shrink-0 font-semibold text-primary tabular-nums">+{entry.amount}</span>
              </li>
            ))}
          </ul>
          {query.hasNextPage && (
            <LoadMoreButton hasNext loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} />
          )}
        </Card>
      )}
    </QueryBoundary>
  );
}
