/**
 * 成员端 · 榜单：GET /me/leaderboard?kind=current|disclosure|frozen&ref=。
 * 当前榜显示范围与计算截至时间；公示/冻结快照需要引用（引用列表对有权限的账号
 * 自动拉取，否则说明并支持从公告粘贴引用）。本人行淡蓝底 + 「我」+ 定位到我。
 */
import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { CrosshairIcon } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrincipal } from '@/lib/session';
import { formatDateTime, membershipLabel } from '@/lib/format';
import { PanelHeader } from '@/components/club/PanelHeader';
import { MemberGate, QueryBoundary } from '@/components/club/QueryBoundary';
import { EmptyState } from '@/components/club/EmptyState';
import { StatusBadge } from '@/components/club/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface CurrentRow {
  rank: number;
  userId: string;
  displayName: string;
  membership: string;
  e: string;
  isMe: boolean;
}
interface DisclosureRow {
  rank: number;
  userId: string;
  displayName: string;
  studentNo: string;
  membership: string;
  currentE: string;
  monthAdded: string;
  isMe: boolean;
}
interface FrozenRow {
  position: number;
  userId: string;
  eSnapshot: string;
  qScore: string | null;
  eligible: boolean;
  isMe: boolean;
}

interface DisclosureRef {
  id: string;
  monthKey: string;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
}
interface FreezeRef {
  id: string;
  contestKey: string;
  title: string;
  freezeAt: string;
  status: string;
}

export default function RankingPanel() {
  const principal = usePrincipal();
  return (
    <MemberGate principal={principal}>
      {(principalId) => <RankingBody principalId={principalId} />}
    </MemberGate>
  );
}

function RankingBody({ principalId }: { principalId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') ?? 'current';

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader title="榜单" description="当前有效榜、月度公示快照与赛事冻结榜。" />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          setSearchParams((previous) => {
            const next = new URLSearchParams(previous);
            if (value === 'current') next.delete('tab');
            else next.set('tab', value);
            next.delete('ref');
            return next;
          })
        }
      >
        <TabsList aria-label="榜单类型">
          <TabsTrigger value="current">当前有效榜</TabsTrigger>
          <TabsTrigger value="disclosure">月度公示快照</TabsTrigger>
          <TabsTrigger value="frozen">赛事冻结榜</TabsTrigger>
        </TabsList>
        <TabsContent value="current" className="mt-4">
          <CurrentBoard principalId={principalId} />
        </TabsContent>
        <TabsContent value="disclosure" className="mt-4">
          <DisclosureBoard principalId={principalId} />
        </TabsContent>
        <TabsContent value="frozen" className="mt-4">
          <FrozenBoard principalId={principalId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function useMyRowScroll() {
  const rowRef = useRef<HTMLTableRowElement | null>(null);
  const scrollToMe = () => {
    rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  return { rowRef, scrollToMe };
}

function CurrentBoard({ principalId }: { principalId: string }) {
  const query = usePrivateQuery<
    { kind: string; rows: CurrentRow[] },
    ApiError
  >(principalId, ['me', 'leaderboard', 'current'], async () => {
    const { data } = await api.get<{ kind: string; rows: CurrentRow[] }>(
      '/me/leaderboard?kind=current',
    );
    return data;
  });
  const { rowRef, scrollToMe } = useMyRowScroll();

  return (
    <QueryBoundary
      query={query}
      isEmpty={(data) => data.rows.length === 0}
      emptyNode={<EmptyState kind="empty" description="当前榜还没有可参与排名的成员。" />}
    >
      {(data) => (
        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                范围：正式 / 预备 / 考察成员；E 为近六个月加权有效积分。
              </p>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground tabular-nums">
                  最近获取 {formatDateTime(new Date(query.dataUpdatedAt))}
                </span>
                {data.rows.some((row) => row.isMe) && (
                  <Button size="sm" variant="outline" onClick={scrollToMe}>
                    <CrosshairIcon aria-hidden="true" />
                    定位到我
                  </Button>
                )}
              </div>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">名次</TableHead>
                    <TableHead>姓名</TableHead>
                    <TableHead>身份</TableHead>
                    <TableHead className="text-right">E</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((row) => (
                    <TableRow
                      key={row.userId}
                      ref={row.isMe ? rowRef : undefined}
                      className={row.isMe ? 'bg-info-subtle' : undefined}
                    >
                      <TableCell className="tabular-nums">{row.rank}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          {row.displayName}
                          {row.isMe && (
                            <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-3 font-semibold text-primary-foreground">
                              我
                            </span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {membershipLabel(row.membership)}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{row.e}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </QueryBoundary>
  );
}

function DisclosureBoard({ principalId }: { principalId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const ref = searchParams.get('ref');
  const [manualRef, setManualRef] = useState('');

  const listQuery = usePrivateQuery<DisclosureRef[] | null, ApiError>(
    principalId,
    ['admin', 'disclosures', 'list'],
    async () => {
      const { data } = await api.get<DisclosureRef[]>('/admin/disclosures');
      return data;
    },
    { retry: false },
  );

  const boardQuery = usePrivateQuery<
    { kind: string; monthKey: string; startsAt: string | null; endsAt: string | null; rows: DisclosureRow[] },
    ApiError
  >(principalId, ['me', 'leaderboard', 'disclosure', ref ?? 'none'], async () => {
    const { data } = await api.get<{
      kind: string;
      monthKey: string;
      startsAt: string | null;
      endsAt: string | null;
      rows: DisclosureRow[];
    }>(`/me/leaderboard?kind=disclosure&ref=${ref}`);
    return data;
  }, { enabled: ref != null });
  const { rowRef, scrollToMe } = useMyRowScroll();

  const listForbidden = listQuery.isError && (listQuery.error.status === 403 || listQuery.error.code === 'FORBIDDEN');
  const options = listQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      {ref == null ? (
        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            {listQuery.isPending ? (
              <p className="text-sm text-muted-foreground">正在获取公示列表…</p>
            ) : listForbidden ? (
              <>
                <p className="text-sm leading-[22px] text-muted-foreground">
                  月度公示快照按期发布：公示期至少 48 小时，期间的榜单以发布时的快照为准，
                  不随当前分变化。快照引用由负责人在公示公告中发布。
                </p>
                <form
                  className="flex flex-col gap-2 sm:flex-row sm:items-center"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (manualRef.trim()) {
                      setSearchParams((previous) => {
                        const next = new URLSearchParams(previous);
                        next.set('tab', 'disclosure');
                        next.set('ref', manualRef.trim());
                        return next;
                      });
                    }
                  }}
                >
                  <Input
                    value={manualRef}
                    onChange={(event) => setManualRef(event.target.value)}
                    placeholder="粘贴公示公告中的快照引用（UUID）"
                    aria-label="公示快照引用"
                  />
                  <Button type="submit" disabled={manualRef.trim().length < 8}>
                    查看快照
                  </Button>
                </form>
              </>
            ) : options.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无已发布的月度公示。</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {options.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 py-2.5 text-left"
                      onClick={() => {
                        setSearchParams((previous) => {
                          const next = new URLSearchParams(previous);
                          next.set('tab', 'disclosure');
                          next.set('ref', item.id);
                          return next;
                        });
                      }}
                    >
                      <span className="text-sm text-foreground">
                        {item.monthKey} 月度公示
                      </span>
                      <span className="flex items-center gap-2">
                        <StatusBadge
                          kind="disclosure"
                          value={item.status === 'published' ? '公示中' : '已结束'}
                        />
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {item.endsAt ? `至 ${formatDateTime(item.endsAt)}` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearchParams((previous) => {
                  const next = new URLSearchParams(previous);
                  next.delete('ref');
                  return next;
                });
              }}
            >
              返回列表
            </Button>
          </div>
          <QueryBoundary query={boardQuery}>
            {(board) => (
              <Card>
                <CardContent className="flex flex-col gap-3 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm text-muted-foreground">
                      {board.monthKey} 快照 · 公示期{' '}
                      {board.startsAt ? formatDateTime(board.startsAt) : '—'} 至{' '}
                      {board.endsAt ? formatDateTime(board.endsAt) : '—'}
                    </p>
                    {boardQuery.data?.rows.some((row) => row.isMe) && (
                      <Button size="sm" variant="outline" onClick={scrollToMe}>
                        <CrosshairIcon aria-hidden="true" />
                        定位到我
                      </Button>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-20">名次</TableHead>
                          <TableHead>姓名</TableHead>
                          <TableHead>身份</TableHead>
                          <TableHead className="text-right">当月新增</TableHead>
                          <TableHead className="text-right">E（快照）</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {board.rows.map((row) => (
                          <TableRow
                            key={row.userId}
                            ref={row.isMe ? rowRef : undefined}
                            className={row.isMe ? 'bg-info-subtle' : undefined}
                          >
                            <TableCell className="tabular-nums">{row.rank}</TableCell>
                            <TableCell>
                              <span className="flex items-center gap-2">
                                {row.displayName}
                                {row.isMe && (
                                  <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-3 font-semibold text-primary-foreground">
                                    我
                                  </span>
                                )}
                              </span>
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {membershipLabel(row.membership)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {row.monthAdded}
                            </TableCell>
                            <TableCell className="text-right font-medium tabular-nums">
                              {row.currentE}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            )}
          </QueryBoundary>
        </>
      )}
    </div>
  );
}

function FrozenBoard({ principalId }: { principalId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const ref = searchParams.get('ref');
  const [manualRef, setManualRef] = useState('');

  const listQuery = usePrivateQuery<FreezeRef[] | null, ApiError>(
    principalId,
    ['admin', 'freezes', 'list'],
    async () => {
      const { data } = await api.get<FreezeRef[]>('/admin/freezes');
      return data;
    },
    { retry: false },
  );

  const boardQuery = usePrivateQuery<
    { kind: string; title: string; frozenAt: string; rows: FrozenRow[] },
    ApiError
  >(
    principalId,
    ['me', 'leaderboard', 'frozen', ref ?? 'none'],
    async () => {
      const { data } = await api.get<{
        kind: string;
        title: string;
        frozenAt: string;
        rows: FrozenRow[];
      }>(`/me/leaderboard?kind=frozen&ref=${ref}`);
      return data;
    },
    { enabled: ref != null },
  );
  const { rowRef, scrollToMe } = useMyRowScroll();

  const listForbidden = listQuery.isError && (listQuery.error.status === 403 || listQuery.error.code === 'FORBIDDEN');
  const options = listQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      {ref == null ? (
        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            {listQuery.isPending ? (
              <p className="text-sm text-muted-foreground">正在获取冻结榜列表…</p>
            ) : listForbidden ? (
              <>
                <p className="text-sm leading-[22px] text-muted-foreground">
                  赛事冻结榜在报名截止前一日 22:00 生成，名单锁定后回填成绩不改变出场资格。
                  冻结榜引用由负责人随赛事公告发布。
                </p>
                <form
                  className="flex flex-col gap-2 sm:flex-row sm:items-center"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (manualRef.trim()) {
                      setSearchParams((previous) => {
                        const next = new URLSearchParams(previous);
                        next.set('tab', 'frozen');
                        next.set('ref', manualRef.trim());
                        return next;
                      });
                    }
                  }}
                >
                  <Input
                    value={manualRef}
                    onChange={(event) => setManualRef(event.target.value)}
                    placeholder="粘贴赛事公告中的冻结榜引用（UUID）"
                    aria-label="冻结榜引用"
                  />
                  <Button type="submit" disabled={manualRef.trim().length < 8}>
                    查看冻结榜
                  </Button>
                </form>
              </>
            ) : options.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无赛事冻结榜。</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {options.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 py-2.5 text-left"
                      onClick={() => {
                        setSearchParams((previous) => {
                          const next = new URLSearchParams(previous);
                        next.set('tab', 'frozen');
                        next.set('ref', item.id);
                          return next;
                        });
                      }}
                      disabled={item.status !== 'frozen'}
                    >
                      <span className="text-sm text-foreground">{item.title}</span>
                      <span className="flex items-center gap-2">
                        <StatusBadge kind="disclosure" value={item.status === 'frozen' ? '已冻结' : '待冻结'} />
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {formatDateTime(item.freezeAt)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="w-fit"
            onClick={() => {
              setSearchParams((previous) => {
                const next = new URLSearchParams(previous);
                next.delete('ref');
                return next;
              });
            }}
          >
            返回列表
          </Button>
          <QueryBoundary query={boardQuery}>
            {(board) => (
              <Card>
                <CardContent className="flex flex-col gap-3 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                      {board.title}
                      <StatusBadge kind="disclosure" value="已冻结" />
                    </p>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        冻结于 {formatDateTime(board.frozenAt)}（不随当前分变化）
                      </span>
                      {board.rows.some((row) => row.isMe) && (
                        <Button size="sm" variant="outline" onClick={scrollToMe}>
                          <CrosshairIcon aria-hidden="true" />
                          定位到我
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-20">名次</TableHead>
                          <TableHead>成员</TableHead>
                          <TableHead className="text-right">E（冻结快照）</TableHead>
                          <TableHead className="text-right">Q 分</TableHead>
                          <TableHead>出场资格</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {board.rows.map((row) => (
                          <TableRow
                            key={row.userId}
                            ref={row.isMe ? rowRef : undefined}
                            className={row.isMe ? 'bg-info-subtle' : undefined}
                          >
                            <TableCell className="tabular-nums">{row.position}</TableCell>
                            <TableCell>
                              <span className="flex items-center gap-2">
                                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                                  {row.userId.slice(0, 8)}
                                </span>
                                {row.isMe && (
                                  <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-3 font-semibold text-primary-foreground">
                                    我
                                  </span>
                                )}
                              </span>
                            </TableCell>
                            <TableCell className="text-right font-medium tabular-nums">
                              {row.eSnapshot}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {row.qScore ?? '—'}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {row.eligible ? '具备' : '不具备'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    冻结榜不含姓名展示（按成员引用展示）；出场资格以冻结时点为准。
                  </p>
                </CardContent>
              </Card>
            )}
          </QueryBoundary>
        </>
      )}
    </div>
  );
}
