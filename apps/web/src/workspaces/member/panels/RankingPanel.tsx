/**
 * 成员端 · 榜单。
 * 当前榜 = 社团积分排行榜：前三领奖台 + 名次列表（手机卡片、桌面表格）；
 * 月度公示快照以批次卡片列出（GET /me/disclosures），点击查看，无需粘贴引用；
 * 赛事资格名单来自正式赛事的冻结快照（GET /me/competition-events/:id/shortlist）。
 */
import { useRef } from 'react';
import { useSearchParams } from 'react-router';
import { CrosshairIcon, MedalIcon } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrincipal } from '@/lib/session';
import { formatDateTime, membershipBadgeClass, membershipLabel } from '@/lib/format';
import {
  competitionsApi,
  type MemberCompetitionEventDto,
  type MemberShortlistBoardDto,
} from '@/lib/competitions';
import { PanelHeader } from '@/components/club/PanelHeader';
import { MemberGate, QueryBoundary } from '@/components/club/QueryBoundary';
import { EmptyState } from '@/components/club/EmptyState';
import { StatusBadge } from '@/components/club/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
interface DisclosureRef {
  id: string;
  monthKey: string;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
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
      <PanelHeader title="榜单" description="社团积分排行榜：当前有效榜、月度公示快照与正式赛事资格名单。" />
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
          <TabsTrigger value="frozen">赛事资格名单</TabsTrigger>
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
  const itemRef = useRef<HTMLLIElement | null>(null);
  const scrollToMe = () => {
    (rowRef.current ?? itemRef.current)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  return { rowRef, itemRef, scrollToMe };
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
  const { rowRef, itemRef, scrollToMe } = useMyRowScroll();

  return (
    <QueryBoundary
      query={query}
      isEmpty={(data) => data.rows.length === 0}
      emptyNode={<EmptyState kind="empty" description="当前榜还没有可参与排名的成员。" />}
    >
      {(data) => {
        const podium = data.rows.slice(0, 3);
        const rest = data.rows.slice(3);
        return (
          <div className="flex flex-col gap-4">
            {/* 前三领奖台 */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {podium.map((row) => (
                <PodiumCard key={row.userId} row={row} />
              ))}
            </div>

            {/* 名次列表 */}
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
                <div className="hidden overflow-x-auto md:block">
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
                          <TableCell className="tabular-nums">
                            {row.rank <= 3 ? (
                              <span className="flex items-center gap-1 font-semibold">
                                <MedalIcon
                                  className={
                                    row.rank === 1
                                      ? 'size-3.5 text-amber-500'
                                      : row.rank === 2
                                        ? 'size-3.5 text-slate-400'
                                        : 'size-3.5 text-orange-500'
                                  }
                                  aria-hidden="true"
                                />
                                {row.rank}
                              </span>
                            ) : (
                              row.rank
                            )}
                          </TableCell>
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
                          <TableCell>
                            <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${membershipBadgeClass(row.membership)}`}>
                              {membershipLabel(row.membership)}
                            </span>
                          </TableCell>
                          <TableCell className="text-right font-medium tabular-nums">{row.e}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {/* 手机端名次卡片 */}
                <ul className="flex flex-col gap-2 md:hidden">
                  {rest.length === 0 && podium.length > 0 && (
                    <li className="px-1 text-xs text-muted-foreground">前三之外暂无其他成员。</li>
                  )}
                  {rest.map((row) => (
                    <li
                      key={row.userId}
                      ref={row.isMe ? itemRef : undefined}
                      className={`flex items-center gap-3 rounded-xl border border-border p-3 ${row.isMe ? 'bg-info-subtle' : 'bg-card'}`}
                    >
                      <span className="w-8 shrink-0 text-center text-sm font-semibold text-foreground tabular-nums">
                        {row.rank}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">{row.displayName}</span>
                          {row.isMe && (
                            <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-3 font-semibold text-primary-foreground">
                              我
                            </span>
                          )}
                        </span>
                        <span className={`mt-0.5 inline-flex w-fit rounded-md px-2 py-0.5 text-xs font-medium ${membershipBadgeClass(row.membership)}`}>
                          {membershipLabel(row.membership)}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm font-semibold text-foreground tabular-nums">{row.e}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>
        );
      }}
    </QueryBoundary>
  );
}

/** 领奖台卡片：金/银/铜名次圆徽 + 同色渐变卡面 + 彩色身份徽标，E 大字 */
function PodiumCard({ row }: { row: CurrentRow }) {
  const champion = row.rank === 1;
  // 1 金 / 2 银 / 3 铜：圆徽渐变与卡面低透明度同色系（浅深主题都成立）
  const medal =
    row.rank === 1
      ? {
          circle: 'bg-gradient-to-b from-amber-300 to-amber-500 text-amber-950 shadow-[0_0_0_3px_rgba(251,191,36,0.25)]',
          card: 'border-amber-400/50 bg-gradient-to-b from-amber-400/15 to-card',
        }
      : row.rank === 2
        ? {
            circle: 'bg-gradient-to-b from-slate-200 to-slate-400 text-slate-900 shadow-[0_0_0_3px_rgba(148,163,184,0.25)]',
            card: 'border-slate-400/40 bg-gradient-to-b from-slate-400/15 to-card',
          }
        : {
            circle: 'bg-gradient-to-b from-orange-300 to-orange-600 text-orange-950 shadow-[0_0_0_3px_rgba(234,137,61,0.25)]',
            card: 'border-orange-400/40 bg-gradient-to-b from-orange-400/15 to-card',
          };
  return (
    <Card className={`${medal.card} ${champion ? 'sm:-mt-2' : ''}`}>
      <CardContent className="flex items-center gap-3 p-4 sm:flex-col sm:items-center sm:gap-2 sm:p-5">
        <span
          className={`flex size-10 shrink-0 items-center justify-center rounded-full font-bold tabular-nums sm:size-12 sm:text-xl ${medal.circle}`}
        >
          {row.rank}
        </span>
        <div className="min-w-0 flex-1 sm:flex-none sm:text-center">
          <p className="flex items-center gap-1.5 sm:justify-center">
            <span className="truncate text-[15px] font-semibold text-foreground">{row.displayName}</span>
            {row.isMe && (
              <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-3 font-semibold text-primary-foreground">
                我
              </span>
            )}
          </p>
          <span className={`mt-1 inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${membershipBadgeClass(row.membership)}`}>
            {membershipLabel(row.membership)}
          </span>
        </div>
        <p
          className={`shrink-0 font-bold tabular-nums sm:text-2xl ${champion ? 'sm:text-3xl' : ''} ${
            row.rank === 1
              ? 'text-amber-600 dark:text-amber-400'
              : row.rank === 2
                ? 'text-slate-600 dark:text-slate-300'
                : 'text-orange-600 dark:text-orange-400'
          }`}
        >
          {row.e}
        </p>
      </CardContent>
    </Card>
  );
}

function DisclosureBoard({ principalId }: { principalId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const ref = searchParams.get('ref');

  const listQuery = usePrivateQuery<DisclosureRef[], ApiError>(
    principalId,
    ['me', 'disclosures', 'cards'],
    async () => (await api.get<DisclosureRef[]>('/me/disclosures')).data,
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

  if (ref == null) {
    return (
      <QueryBoundary
        query={listQuery}
        isEmpty={(rows) => rows.length === 0}
        emptyNode={<EmptyState kind="empty" description="暂无进行中的月度公示；公示发布后这里会出现批次卡片。" />}
      >
        {(rows) => (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {rows.map((item) => (
              <Card key={item.id} className="transition-colors hover:border-primary/50">
                <CardContent className="flex flex-col gap-3 p-5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-2xl font-semibold text-foreground tabular-nums">{item.monthKey}</p>
                    <StatusBadge kind="disclosure" value={item.status === 'published' ? '公示中' : '已结束'} />
                  </div>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    公示期 {item.startsAt ? formatDateTime(item.startsAt) : '—'} 至 {item.endsAt ? formatDateTime(item.endsAt) : '—'}
                    （快照不随当前分变化）
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-fit"
                    onClick={() => {
                      setSearchParams((previous) => {
                        const next = new URLSearchParams(previous);
                        next.set('tab', 'disclosure');
                        next.set('ref', item.id);
                        return next;
                      });
                    }}
                  >
                    查看快照
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </QueryBoundary>
    );
  }

  return (
    <div className="flex flex-col gap-4">
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
        返回批次列表
      </Button>
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
                        <TableCell className="tabular-nums">
                          {row.rank <= 3 ? (
                            <span className="flex items-center gap-1 font-semibold">
                              <MedalIcon
                                className={
                                  row.rank === 1
                                    ? 'size-3.5 text-amber-500'
                                    : row.rank === 2
                                      ? 'size-3.5 text-slate-400'
                                      : 'size-3.5 text-orange-500'
                                }
                                aria-hidden="true"
                              />
                              {row.rank}
                            </span>
                          ) : (
                            row.rank
                          )}
                        </TableCell>
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
                        <TableCell>
                          <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${membershipBadgeClass(row.membership)}`}>
                            {membershipLabel(row.membership)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{row.monthAdded}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{row.currentE}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}
      </QueryBoundary>
    </div>
  );
}

/**
 * 赛事资格名单：A 类赛事按积分冻结时点的 E（或专项 Q）排序取前 quota 名入围。
 * 名单锁定后回填成绩不改变出场资格；不公开他人姓名，按成员引用展示。
 */
function FrozenBoard({ principalId }: { principalId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const ref = searchParams.get('ref');

  const listQuery = usePrivateQuery<MemberCompetitionEventDto[], ApiError>(
    principalId,
    ['me', 'competition-events', 'shortlist-cards'],
    async () => (await competitionsApi.listOpenEvents()).filter((event) => event.category === 'A'),
  );

  const boardQuery = usePrivateQuery<MemberShortlistBoardDto, ApiError>(
    principalId,
    ['me', 'competition-shortlist', ref ?? 'none'],
    () => competitionsApi.shortlistBoard(ref as string),
    { enabled: ref != null },
  );
  const { rowRef, itemRef, scrollToMe } = useMyRowScroll();

  if (ref == null) {
    return (
      <QueryBoundary
        query={listQuery}
        isEmpty={(rows) => rows.length === 0}
        emptyNode={
          <EmptyState
            kind="empty"
            description="暂无 A 类赛事资格名单；报名截止前一日 22:00 自动按冻结时点生成。"
          />
        }
      >
        {(rows) => (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {rows.map((item) => {
              const frozen = item.status === 'shortlisted' || item.status === 'team_forming';
              return (
                <Card
                  key={item.id}
                  className={
                    frozen ? 'transition-colors hover:border-primary/50' : 'border-dashed'
                  }
                >
                  <CardContent className="flex flex-col gap-3 p-5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[15px] font-semibold text-foreground">{item.title}</p>
                      <StatusBadge kind="disclosure" value={frozen ? '已冻结' : '待冻结'} />
                    </div>
                    <p className="text-xs leading-5 text-muted-foreground tabular-nums">
                      冻结时点 {formatDateTime(item.freezeAt)}
                      {item.quota != null && ` · 配额 ${item.quota} 人`}
                      <br />
                      名单锁定后回填成绩不改变出场资格。
                    </p>
                    {frozen ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-fit"
                        onClick={() => {
                          setSearchParams((previous) => {
                            const next = new URLSearchParams(previous);
                            next.set('tab', 'frozen');
                            next.set('ref', item.id);
                            return next;
                          });
                        }}
                      >
                        查看资格名单
                      </Button>
                    ) : (
                      <p className="text-xs text-muted-foreground">到点自动冻结后可查看。</p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </QueryBoundary>
    );
  }

  return (
    <div className="flex flex-col gap-4">
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
        返回赛事列表
      </Button>
      <QueryBoundary
        query={boardQuery}
        isEmpty={(board) => board.rows.length === 0}
        emptyNode={<EmptyState kind="empty" description="该赛事的资格名单尚未生成。" />}
      >
        {(board) => (
          <Card>
            <CardContent className="flex flex-col gap-3 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {board.event.title}
                  <StatusBadge kind="disclosure" value="已冻结" />
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    冻结于 {formatDateTime(board.event.freezeAt)}（不随当前分变化）
                  </span>
                  {board.rows.some((row) => row.isMe) && (
                    <Button size="sm" variant="outline" onClick={scrollToMe}>
                      <CrosshairIcon aria-hidden="true" />
                      定位到我
                    </Button>
                  )}
                </div>
              </div>
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-20">名次</TableHead>
                      <TableHead>成员</TableHead>
                      <TableHead className="text-right">E（冻结快照）</TableHead>
                      <TableHead className="text-right">Q 分</TableHead>
                      <TableHead>入围</TableHead>
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
                          {Number(row.eSnapshot).toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.qScore == null ? '—' : Number(row.qScore).toFixed(2)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {row.shortlisted ? '已入围' : '候补'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {row.eligible ? '具备' : '不具备'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {/* 手机端名次卡片 */}
              <ul className="flex flex-col gap-2 md:hidden">
                {board.rows.map((row) => (
                  <li
                    key={row.userId}
                    ref={row.isMe ? itemRef : undefined}
                    className={`flex items-center gap-3 rounded-xl border border-border p-3 ${
                      row.isMe ? 'bg-info-subtle' : 'bg-card'
                    }`}
                  >
                    <span className="w-8 shrink-0 text-center text-sm font-semibold text-foreground tabular-nums">
                      {row.position}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {row.userId.slice(0, 8)}
                        </span>
                        {row.isMe && (
                          <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-3 font-semibold text-primary-foreground">
                            我
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {row.shortlisted ? '已入围' : '候补'} ·{' '}
                        {row.eligible ? '具备出场资格' : '不具备出场资格'}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm font-semibold text-foreground tabular-nums">
                      {Number(row.qScore ?? row.eSnapshot).toFixed(2)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-xs leading-5 text-muted-foreground">
                资格名单不展示姓名（按成员引用展示）；配额 {board.event.quota ?? '不限'}，
                出场资格以冻结时点为准。个别调整由管理员记录在审计日志中。
              </p>
            </CardContent>
          </Card>
        )}
      </QueryBoundary>
    </div>
  );
}
