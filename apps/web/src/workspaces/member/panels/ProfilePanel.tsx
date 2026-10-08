/**
 * 成员端 · 我的：GET /me/profile（?memberId= 时 GET /profiles/:memberId 按权限裁剪）。
 * 首屏头像/展示名/简介/置顶徽标/平台绑定；
 * Tabs 概览/rating/比赛成绩/参加活动/正式赛事/徽标/资料与隐私（后三项仅本人）。
 * rating 图表懒加载且进入可见区才加载；缺失显示「暂无数据」，不补 0。
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRightIcon, LoaderCircleIcon, UploadIcon } from 'lucide-react';

import { api, ApiError, fetchCsrfToken, CSRF_HEADER, API_BASE } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrivateInfiniteQuery } from '@/lib/private-infinite';
import { usePrincipal } from '@/lib/session';
import { LoadMoreButton } from '@/lib/hooks';
import { attendanceResultBadge, formatDateTime, formatStartEnd, membershipLabel, platformAccountBadge, platformLabel, memberName, formatMemberName, memberAvatarId } from '@/lib/format';
import {
  competitionsApi,
  entryStatusLabel,
  type MemberCompetitionEventDto,
  type TeamDto,
} from '@/lib/competitions';
import { PanelHeader } from '@/components/club/PanelHeader';
import { MemberGate, QueryBoundary } from '@/components/club/QueryBoundary';
import { EmptyState } from '@/components/club/EmptyState';
import { StatusBadge } from '@/components/club/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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

const RatingChart = lazy(() => import('@/components/club/RatingChart'));

interface MyProfileDto {
  userId: string;
  displayName: string;
  bio: string | null;
  avatarAssetId: string | null;
  visibility: string;
  themePreference: string;
  revision: number;
  verified: { studentNo: string; realName: string; grade: number | null };
  membership: string;
  featuredBadges: Array<{ slot: number; awardId: string; name: string; icon: string; theme: string; expiresAt: string | null }>;
  platformAccounts: Array<{ platform: string; handle: string | null; status: string; lastSyncAt: string | null; lastSyncStatus: string | null }>;
}

interface MemberProfileDto {
  userId: string;
  displayName: string;
  bio: string | null;
  avatarAssetId: string | null;
  membership: string;
  featuredBadges: Array<{ name: string; icon: string; theme: string }>;
  platformAccounts: Array<{ platform: string; handle: string | null }>;
  studentNo?: string;
  realName?: string;
}

interface BadgeAwardDto {
  id: string;
  status: string;
  grantedAt: string;
  expiresAt: string | null;
  definition: { key: string; name: string; description: string; icon: string; theme: string; category: string };
}

interface RatingSeries {
  platform: string;
  seriesType: string;
  completeness: string;
  points: Array<{ occurredAt: string; old: number | null; new: number | null; snapshot: number | null }>;
}

interface ActivityHistoryDto {
  activityId: string;
  title: string;
  type: string;
  startAt: string;
  registration: string | null;
  checkin: string | null;
  checkout: string | null;
  attendanceResult: string | null;
}

const VISIBILITY_LABELS: Record<string, string> = {
  internal: '社内可见',
  self_only: '仅自己可见',
  public_opt_in: '主动公开',
};

export default function ProfilePanel() {
  const principal = usePrincipal();
  return (
    <MemberGate principal={principal}>
      {(principalId) => <ProfileBody principalId={principalId} />}
    </MemberGate>
  );
}

function ProfileBody({ principalId }: { principalId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const memberId = searchParams.get('memberId');
  const tab = searchParams.get('tab') ?? 'overview';
  const isSelf = memberId == null || memberId === principalId;
  const targetId = memberId ?? principalId;

  const profileQuery = usePrivateQuery<MyProfileDto | MemberProfileDto, ApiError>(
    principalId,
    ['profiles', isSelf ? 'me' : 'member', targetId],
    async () => {
      const path = isSelf ? '/me/profile' : `/profiles/${targetId}`;
      const { data } = await api.get<MyProfileDto | MemberProfileDto>(path);
      return data;
    },
  );

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title={isSelf ? '我的资料' : '成员主页'}
        description={isSelf ? '展示名、徽标、平台绑定与隐私设置。' : '按对方可见范围展示的资料。'}
      />
      <QueryBoundary query={profileQuery}>
        {(profile) => {
          const displayName = profile.displayName || '未命名';
          const avatarText = displayName.slice(0, 1).toUpperCase();
          const isSelfProfile = 'revision' in profile;
          return (
            <>
              <Card>
                <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
                  <Avatar className="size-20 md:size-24">
                    {profile.avatarAssetId && (
                      <AvatarImage
                        src={`/api/v1/me/avatar/${profile.avatarAssetId}?size=256`}
                        alt={`${displayName} 的头像`}
                      />
                    )}
                    <AvatarFallback className="text-2xl">{avatarText}</AvatarFallback>
                  </Avatar>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-semibold text-foreground">{'verified' in profile ? formatMemberName(displayName, profile.verified.realName) : displayName}</h2>
                      <Badge variant="info">{membershipLabel(profile.membership)}</Badge>
                    </div>
                    <p className="text-sm leading-[22px] text-muted-foreground">
                      {profile.bio?.trim() ? profile.bio : '这个人还没有写简介。'}
                    </p>
                    {profile.featuredBadges.length > 0 && (
                      <ul className="flex flex-wrap gap-2" aria-label="置顶徽标">
                        {profile.featuredBadges.map((badge, index) => (
                          <li key={`${badge.name}-${index}`}>
                            <Badge variant="outline">{badge.name}</Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {profile.platformAccounts.length === 0 && <li>未绑定平台账号</li>}
                      {profile.platformAccounts.map((account) => (
                        <li key={account.platform} className="flex items-center gap-1.5">
                          {platformLabel(account.platform)}
                          {account.handle ? ` · ${account.handle}` : ''}
                          {'status' in account && (
                            <StatusBadge kind="sync" value={platformAccountBadge(account.status)} />
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                </CardContent>
              </Card>

              <Tabs
                value={tab}
                onValueChange={(value) =>
                  setSearchParams((previous) => {
                    const next = new URLSearchParams(previous);
                    if (value === 'overview') next.delete('tab');
                    else next.set('tab', value);
                    return next;
                  })
                }
              >
                <TabsList aria-label="资料子页">
                  <TabsTrigger value="overview">概览</TabsTrigger>
                  <TabsTrigger value="rating">rating</TabsTrigger>
                  <TabsTrigger value="results">比赛成绩</TabsTrigger>
                  <TabsTrigger value="activities">参加活动</TabsTrigger>
                  {isSelfProfile && <TabsTrigger value="competitions">正式赛事</TabsTrigger>}
                  {isSelfProfile && <TabsTrigger value="badges">徽标</TabsTrigger>}
                  {isSelfProfile && <TabsTrigger value="edit">资料与隐私</TabsTrigger>}
                </TabsList>

                <TabsContent value="overview" className="mt-4">
                  <OverviewSection profile={profile} />
                </TabsContent>
                <TabsContent value="rating" className="mt-4">
                  <RatingSection principalId={principalId} targetId={targetId} />
                </TabsContent>
                <TabsContent value="results" className="mt-4">
                  <ResultsSection principalId={principalId} targetId={targetId} />
                </TabsContent>
                <TabsContent value="activities" className="mt-4">
                  <ActivitiesSection principalId={principalId} targetId={targetId} />
                </TabsContent>
                {isSelfProfile && (
                  <TabsContent value="competitions" className="mt-4">
                    <CompetitionsSection principalId={principalId} />
                  </TabsContent>
                )}
                {isSelfProfile && (
                  <TabsContent value="badges" className="mt-4">
                    <BadgesSection
                      principalId={principalId}
                      featuredAwardIds={(profile as MyProfileDto).featuredBadges
                        .map((badge) => badge.awardId)
                        .filter((id): id is string => id != null)}
                    />
                  </TabsContent>
                )}
                {isSelfProfile && (
                  <TabsContent value="edit" className="mt-4">
                    <EditSection principalId={principalId} profile={profile as MyProfileDto} />
                  </TabsContent>
                )}
              </Tabs>
            </>
          );
        }}
      </QueryBoundary>
    </div>
  );
}

function OverviewSection({ profile }: { profile: MyProfileDto | MemberProfileDto }) {
  const isSelfProfile = 'revision' in profile;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Card>
        <CardContent className="flex flex-col gap-2 p-5">
          <h3 className="text-sm font-semibold text-foreground">身份信息（只读）</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">展示名</dt>
            <dd>{profile.displayName}</dd>
            {'verified' in profile && (
              <>
                <dt className="text-muted-foreground">校园编号</dt>
                <dd className="tabular-nums">{profile.verified.studentNo}</dd>
                <dt className="text-muted-foreground">实名</dt>
                <dd>{profile.verified.realName}</dd>
                <dt className="text-muted-foreground">年级</dt>
                <dd className="tabular-nums">{profile.verified.grade ?? '—'}</dd>
              </>
            )}
            {'studentNo' in profile && profile.studentNo && (
              <>
                <dt className="text-muted-foreground">校园编号</dt>
                <dd className="tabular-nums">{profile.studentNo}</dd>
              </>
            )}
            <dt className="text-muted-foreground">身份</dt>
            <dd>{membershipLabel(profile.membership)}</dd>
            {'visibility' in profile && (
              <>
                <dt className="text-muted-foreground">可见范围</dt>
                <dd>{VISIBILITY_LABELS[profile.visibility] ?? profile.visibility}</dd>
              </>
            )}
          </dl>
          <p className="text-xs leading-5 text-muted-foreground">
            {isSelfProfile
              ? '校园编号与实名来自校园认证，只读；如需更正请联系管理员。'
              : '按对方的可见范围展示。'}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-2 p-5">
          <h3 className="text-sm font-semibold text-foreground">置顶徽标</h3>
          {profile.featuredBadges.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无置顶徽标。</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {profile.featuredBadges.map((badge, index) => (
                <li key={`${badge.name}-${index}`} className="flex flex-col">
                  <Badge variant="outline">{badge.name}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RatingSection({ principalId, targetId }: { principalId: string; targetId: string }) {
  const query = usePrivateQuery<Record<string, RatingSeries>, ApiError>(
    principalId,
    ['profiles', 'ratings', targetId],
    async () => (await api.get<Record<string, RatingSeries>>(`/profiles/${targetId}/ratings`)).data,
  );

  return (
    <QueryBoundary
      query={query}
      isEmpty={(series) => Object.keys(series).length === 0}
      emptyNode={
        <EmptyState
          kind="empty"
          title="暂无数据"
          description="绑定并核验平台账号、同步出比赛记录后，这里会出现 rating 走势。"
        />
      }
    >
      {(series) => (
        <div className="flex flex-col gap-4">
          {Object.entries(series).map(([platform, item]) => (
            <LazyRatingCard key={platform} platform={platform} series={item} />
          ))}
        </div>
      )}
    </QueryBoundary>
  );
}

/** rating 空态按平台解释原因（CF 需打 rated 场；牛客已接入 rating-history，同步后即有） */
function ratingEmptyReason(platform: string): string {
  if (platform === 'codeforces') return '尚未参加 Codeforces rated 比赛；参加后点「申请刷新」同步即出现。';
  if (platform === 'nowcoder') return '尚未参加牛客 rated 场次；参加 rated 比赛并同步后这里会出现曲线（单场 rating 也可在「比赛成绩」中查看）。';
  if (platform === 'hydro') return '校内 OJ 暂无 rating 序列；比赛成绩见「比赛成绩」列表。';
  return '暂无 rated 记录；参加 rated 比赛并同步后即出现。';
}

function LazyRatingCard({ platform, series }: { platform: string; series: RatingSeries }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || visible) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '80px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  const empty = series.points.length === 0;

  return (
    <Card ref={containerRef} className={empty ? 'border-dashed' : undefined}>
      <CardContent className="flex flex-col gap-2 p-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">{platformLabel(platform)} rating</h3>
          <span className="text-xs text-muted-foreground">
            {series.completeness === 'complete' ? '完整序列' : '部分序列（绑定核验中）'}
          </span>
        </div>
        {empty ? (
          <div className="flex h-[140px] flex-col items-center justify-center gap-1 rounded-xl bg-muted/30 px-4 text-center">
            <span className="text-sm text-muted-foreground">暂无 rating 数据</span>
            <span className="text-xs leading-5 text-muted-foreground">{ratingEmptyReason(platform)}</span>
          </div>
        ) : visible ? (
          <Suspense
            fallback={<Skeleton className="h-[260px] w-full rounded-xl" aria-label="图表加载中" />}
          >
            <RatingChart points={series.points} />
          </Suspense>
        ) : (
          <Skeleton className="h-[260px] w-full rounded-xl" aria-label="图表占位" />
        )}
      </CardContent>
    </Card>
  );
}

function ResultsSection({ principalId, targetId }: { principalId: string; targetId: string }) {
  const query = usePrivateInfiniteQuery<
    {
      items: Array<{
        platform: string;
        contestName: string;
        startTime: string;
        participationType: string;
        score: number | null;
        fullScore: number | null;
        acceptedCount: number | null;
        problemCount: number | null;
        rank: number | null;
        rankTotal: number | null;
        verifiedBinding: boolean;
      }>;
      nextCursor?: string | null;
    },
    ApiError
  >(principalId, ['profiles', 'competition-results', targetId], async (cursor) => {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    const { data } = await api.get<{
      items: Array<{
        platform: string;
        contestName: string;
        startTime: string;
        participationType: string;
        score: number | null;
        fullScore: number | null;
        acceptedCount: number | null;
        problemCount: number | null;
        rank: number | null;
        rankTotal: number | null;
        verifiedBinding: boolean;
      }>;
      nextCursor?: string | null;
    }>(`/profiles/${targetId}/competition-results?${params.toString()}`);
    return data;
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Card>
      <CardContent className="p-5">
        {query.isPending ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-10" />
            ))}
          </div>
        ) : query.isError ? (
          <EmptyState
            kind="error"
            description={query.error.message}
            action={
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                重试
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState kind="empty" description="暂无同步到的比赛成绩。" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>平台 / 比赛</TableHead>
                    <TableHead>时间</TableHead>
                    <TableHead className="text-right">分数</TableHead>
                    <TableHead className="text-right">通过</TableHead>
                    <TableHead className="text-right">排名</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((row, index) => (
                    <TableRow key={`${row.platform}-${index}`}>
                      <TableCell>
                        <span className="block">{row.contestName}</span>
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
                      <TableCell className="text-right tabular-nums">{row.rank ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <LoadMoreButton
              onClick={() => {
                void query.fetchNextPage();
              }}
              loading={query.isFetchingNextPage}
              hasNext={Boolean(query.data?.pages.at(-1)?.nextCursor)}
              hint="已展示全部成绩"
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ActivitiesSection({ principalId, targetId }: { principalId: string; targetId: string }) {
  const [, setSearchParams] = useSearchParams();
  const query = usePrivateInfiniteQuery<
    { items: ActivityHistoryDto[]; nextCursor?: string | null },
    ApiError
  >(principalId, ['profiles', 'activities', targetId], async (cursor) => {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    const { data } = await api.get<{ items: ActivityHistoryDto[]; nextCursor?: string | null }>(
      `/profiles/${targetId}/activities?${params.toString()}`,
    );
    return data;
  });

  const openDetail = (activityId: string) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('section', 'activities');
      next.set('activity', activityId);
      return next;
    });
  };

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Card>
      <CardContent className="p-5">
        {query.isPending ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-12" />
            ))}
          </div>
        ) : query.isError ? (
          <EmptyState
            kind="error"
            description={query.error.message}
            action={
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                重试
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState kind="empty" description="暂无活动参与记录。" />
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-border">
              {items.map((item) => {
                const resultBadge = attendanceResultBadge(item.attendanceResult);
                return (
                  <li key={item.activityId}>
                    <button
                      type="button"
                      onClick={() => openDetail(item.activityId)}
                      className="group flex w-full flex-col gap-1.5 py-3 text-left"
                    >
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground group-hover:text-primary">
                          {item.title}
                          <ChevronRightIcon
                            className="ml-1 inline size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
                            aria-hidden="true"
                          />
                        </span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {formatStartEnd(item.startAt, item.startAt)}
                        </span>
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        {item.registration && (
                          <StatusBadge
                            kind="registration"
                            value={
                              item.registration === 'enrolled'
                                ? '已报名'
                                : item.registration === 'waitlisted'
                                  ? '候补中'
                                  : item.registration === 'pending_approval'
                                    ? '待审核'
                                    : item.registration === 'cancelled'
                                      ? '已取消'
                                      : item.registration === 'participated'
                                        ? '已参加'
                                        : item.registration
                            }
                          />
                        )}
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          签到
                          <StatusBadge
                            kind="attendance"
                            value={item.checkin ? '签到已记录' : '未签到'}
                          />
                        </span>
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          签退
                          <StatusBadge
                            kind="attendance"
                            value={item.checkout ? '签到已记录' : '未签到'}
                          />
                        </span>
                        {resultBadge && <StatusBadge kind="attendance" value={resultBadge} />}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <LoadMoreButton
              onClick={() => {
                void query.fetchNextPage();
              }}
              loading={query.isFetchingNextPage}
              hasNext={Boolean(query.data?.pages.at(-1)?.nextCursor)}
              hint="已展示全部活动"
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BadgesSection({
  principalId,
  featuredAwardIds,
}: {
  principalId: string;
  featuredAwardIds: string[];
}) {
  const queryClient = useQueryClient();
  const query = usePrivateQuery<BadgeAwardDto[], ApiError>(
    principalId,
    ['me', 'badges'],
    async () => (await api.get<BadgeAwardDto[]>('/me/badges')).data,
  );
  const [pinned, setPinned] = useState<string[] | null>(null);

  const pinMutation = useMutation({
    mutationFn: async (awardIds: string[]) => {
      await api.put('/me/profile/badge-pins', { awardIds });
      return awardIds;
    },
    onSuccess: (awardIds) => {
      setPinned(awardIds);
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId] });
    },
  });

  return (
    <QueryBoundary
      query={query}
      isEmpty={(badges) => badges.length === 0}
      emptyNode={
        <EmptyState kind="empty" description="还没有获得徽标；参加活动、比赛与贡献都可能获得。" />
      }
    >
      {(badges) => {
        const effectivePinned = pinned ?? featuredAwardIds;
        return (
          <Card>
            <CardContent className="flex flex-col gap-3 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-foreground">我的徽标（置顶 ≤ 3）</h3>
                <Button
                  size="sm"
                  disabled={pinMutation.isPending}
                  onClick={() => pinMutation.mutate(effectivePinned)}
                >
                  {pinMutation.isPending && (
                    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  )}
                  保存置顶
                </Button>
              </div>
              {pinMutation.isError && (
                <Alert variant="destructive">
                  <AlertDescription>{(pinMutation.error as ApiError).message}</AlertDescription>
                </Alert>
              )}
              <ul className="flex flex-col divide-y divide-border">
                {badges.map((badge) => {
                  const checked = effectivePinned.includes(badge.id);
                  const disabled =
                    !checked && effectivePinned.length >= 3 && badge.status === 'active';
                  return (
                    <li key={badge.id} className="flex items-center gap-3 py-3">
                      <Checkbox
                        id={`badge-${badge.id}`}
                        checked={checked}
                        disabled={disabled || badge.status !== 'active'}
                        onCheckedChange={(value) => {
                          setPinned((previous) => {
                            const base = previous ?? [];
                            if (value === true) return [...base, badge.id];
                            return base.filter((id) => id !== badge.id);
                          });
                        }}
                        aria-label={`置顶 ${badge.definition.name}`}
                      />
                      <div className="min-w-0 flex-1">
                        <label
                          htmlFor={`badge-${badge.id}`}
                          className="block text-sm font-medium text-foreground"
                        >
                          {badge.definition.name}
                        </label>
                        <p className="text-xs leading-5 text-muted-foreground">
                          {badge.definition.description}
                        </p>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          授予 {formatDateTime(badge.grantedAt)}
                          {badge.expiresAt ? ` · 至 ${formatDateTime(badge.expiresAt)}` : ''}
                        </p>
                      </div>
                      <StatusBadge
                        kind="participation"
                        value={badge.status === 'active' ? '已记分' : '已取消'}
                      />
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        );
      }}
    </QueryBoundary>
  );
}

function EditSection({ principalId, profile }: { principalId: string; profile: MyProfileDto }) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [bio, setBio] = useState(profile.bio ?? '');
  const [theme, setTheme] = useState(profile.themePreference);
  const [visibility, setVisibility] = useState(profile.visibility);
  const [avatarState, setAvatarState] = useState<
    { phase: 'idle' } | { phase: 'uploading' } | { phase: 'processing' } | { phase: 'done' } | { phase: 'error'; message: string }
  >({ phase: 'idle' });

  const updateMutation = useMutation({
    mutationFn: async (input: {
      displayName?: string;
      bio?: string;
      themePreference?: string;
      visibility?: string;
      avatarAssetId?: string;
    }) =>
      (
        await api.put<{ revision: number }>('/me/profile', {
          ...input,
          expectedRevision: profile.revision,
        })
      ).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'profiles'] });
      // 侧栏头像与展示名取自会话详情，改完要一起失效，否则要刷新页面才更新
      void queryClient.invalidateQueries({ queryKey: ['session', 'details'] });
    },
  });

  async function handleAvatar(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      setAvatarState({ phase: 'error', message: '图片超过 10 MiB，请压缩或截图后再上传。' });
      return;
    }
    setAvatarState({ phase: 'uploading' });
    try {
      const token = await fetchCsrfToken();
      const form = new FormData();
      form.append('file', file);
      const response = await fetch(`${API_BASE}/me/profile/avatar`, {
        method: 'POST',
        credentials: 'include',
        headers: token ? { [CSRF_HEADER]: token } : {},
        body: form,
      });
      const body = (await response.json().catch(() => null)) as
        | { data?: { assetId: string; status?: string; jobId?: string }; error?: { message?: string } }
        | null;
      if (!response.ok || !body?.data) {
        throw new Error(body?.error?.message ?? '上传失败');
      }
      const { assetId } = body.data;
      // 处理已内联完成：通常直接 ready，立即设为头像；异常情况轮询资产状态兜底
      if (body.data.status === 'ready') {
        await updateMutation.mutateAsync({ avatarAssetId: assetId });
        setAvatarState({ phase: 'done' });
        return;
      }
      setAvatarState({ phase: 'processing' });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        const job = await api.get<{ assetId: string; status: string }>(`/me/media-jobs/${body.data.jobId ?? assetId}`);
        if (job.data.status === 'ready') {
          await updateMutation.mutateAsync({ avatarAssetId: assetId });
          setAvatarState({ phase: 'done' });
          return;
        }
        if (job.data.status === 'failed') {
          setAvatarState({ phase: 'error', message: '头像处理失败：请换一张图片重试。' });
          return;
        }
      }
      setAvatarState({ phase: 'error', message: '处理超时，请稍后在保存前重试。' });
    } catch (error) {
      setAvatarState({
        phase: 'error',
        message: error instanceof Error ? error.message : '上传失败',
      });
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardContent className="flex flex-col gap-3 p-5">
          <h3 className="text-sm font-semibold text-foreground">编辑资料</h3>
          {updateMutation.isSuccess && (
            <Alert>
              <AlertTitle>已保存</AlertTitle>
              <AlertDescription>资料已更新。</AlertDescription>
            </Alert>
          )}
          {updateMutation.isError && (
            <Alert variant="destructive">
              <AlertTitle>保存失败</AlertTitle>
              <AlertDescription>{(updateMutation.error as ApiError).message}</AlertDescription>
            </Alert>
          )}
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              updateMutation.mutate({
                displayName: displayName.trim(),
                bio: bio.trim(),
                themePreference: theme,
                visibility,
              });
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="profile-display">展示名（2-32 字）</Label>
              <Input
                id="profile-display"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                minLength={2}
                maxLength={32}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="profile-bio">简介（≤300 字）</Label>
              <Textarea
                id="profile-bio"
                value={bio}
                onChange={(event) => setBio(event.target.value)}
                rows={3}
                maxLength={300}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="profile-theme">界面偏好</Label>
              <Select value={theme} onValueChange={setTheme}>
                <SelectTrigger id="profile-theme">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">浅色</SelectItem>
                  <SelectItem value="dark">深色</SelectItem>
                  <SelectItem value="system">跟随系统</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="profile-visibility">主页可见范围</Label>
              <Select value={visibility} onValueChange={setVisibility}>
                <SelectTrigger id="profile-visibility">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="internal">社内可见</SelectItem>
                  <SelectItem value="self_only">仅自己可见</SelectItem>
                  <SelectItem value="public_opt_in">主动公开</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={updateMutation.isPending || displayName.trim().length < 2}>
              {updateMutation.isPending && (
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
              )}
              保存资料
            </Button>
          </form>
        </CardContent>
      </Card>
      <div className="flex flex-col gap-4">
        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            <h3 className="text-sm font-semibold text-foreground">认证信息（只读）</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">校园编号</dt>
              <dd className="tabular-nums">{profile.verified.studentNo}</dd>
              <dt className="text-muted-foreground">实名</dt>
              <dd>{profile.verified.realName}</dd>
              <dt className="text-muted-foreground">年级</dt>
              <dd className="tabular-nums">{profile.verified.grade ?? '—'}</dd>
            </dl>
            <p className="text-xs leading-5 text-muted-foreground">
              校园编号与实名来自校园 CAS 认证，页面只读。
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            <h3 className="text-sm font-semibold text-foreground">头像</h3>
            <div className="flex items-center gap-3">
              <Avatar className="size-14">
                {profile.avatarAssetId && (
                  <AvatarImage
                    src={`/api/v1/me/avatar/${profile.avatarAssetId}?size=128`}
                    alt="当前头像"
                  />
                )}
                <AvatarFallback>{(profile.displayName || '我').slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
              <p className="text-xs leading-5 text-muted-foreground">
                支持 JPEG/PNG/WebP，≤10MiB；上传后自动裁剪并剥离 EXIF，处理完成才设为头像。
                {profile.avatarAssetId ? '（当前已设置头像）' : ''}
              </p>
            </div>
            <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-input bg-card px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted">
              <UploadIcon className="size-4" aria-hidden="true" />
              选择图片并上传
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleAvatar(file);
                  event.target.value = '';
                }}
              />
            </label>
            {avatarState.phase === 'uploading' && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
                正在上传…
              </p>
            )}
            {avatarState.phase === 'processing' && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
                后台处理中（格式/像素/EXIF 校验）…
              </p>
            )}
            {avatarState.phase === 'done' && (
              <p className="text-sm text-foreground">头像已更新。</p>
            )}
            {avatarState.phase === 'error' && (
              <p className="text-sm text-destructive">{avatarState.message}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * 正式赛事：我报名中的赛事与常驻小队。
 * 仅本人可见（数据来自 /me 端点）；详细报名操作在「竞赛 → 正式赛报名」。
 */
function CompetitionsSection({ principalId }: { principalId: string }) {
  const eventsQuery = usePrivateQuery<MemberCompetitionEventDto[], ApiError>(
    principalId,
    ['me', 'competition-events'],
    () => competitionsApi.listOpenEvents(),
  );

  const teamsQuery = usePrivateQuery<TeamDto[], ApiError>(
    principalId,
    ['me', 'teams'],
    () => competitionsApi.myTeams(),
  );

  const myEvents = (eventsQuery.data ?? []).filter((event) => event.myStatus != null);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">我的赛事报名</h3>
            <Button size="sm" variant="outline" asChild>
              <Link to="/app?section=contests&tab=entry">前往报名</Link>
            </Button>
          </div>
          {eventsQuery.isPending ? (
            <Skeleton className="h-16 rounded-xl" />
          ) : eventsQuery.isError ? (
            <p className="text-sm text-muted-foreground">{eventsQuery.error.message}</p>
          ) : myEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              当前没有报名中的正式赛事；开放报名的赛事在「竞赛 → 正式赛报名」查看。
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {myEvents.map((event) => (
                <li key={event.id} className="flex flex-wrap items-center gap-2 py-2">
                  <Badge variant={event.category === 'A' ? 'info' : 'success'}>
                    {event.category} 类
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {event.title}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formatDateTime(event.startAt)}
                  </span>
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
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">我的小队</h3>
            <Button size="sm" variant="outline" asChild>
              <Link to="/app?section=contests&tab=teams">组队广场</Link>
            </Button>
          </div>
          {teamsQuery.isPending ? (
            <Skeleton className="h-16 rounded-xl" />
          ) : teamsQuery.isError ? (
            <p className="text-sm text-muted-foreground">{teamsQuery.error.message}</p>
          ) : teamsQuery.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              还没有小队；团队赛需要先在组队广场建队并邀请队友。
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {teamsQuery.data.map((team) => (
                <li
                  key={team.id}
                  className="flex flex-col gap-1 rounded-xl border border-border p-3"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{team.name}</span>
                    <Badge
                      variant={team.members.length >= team.teamSize ? 'success' : 'warning'}
                    >
                      {team.members.length}/{team.teamSize} 人
                    </Badge>
                    {team.captainUserId === principalId && <Badge variant="info">队长</Badge>}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {/* 队员头像叠放 */}
                    <span className="flex -space-x-2">
                      {team.members.map((member) => (
                        <MemberAvatar
                          key={member.id}
                          assetId={memberAvatarId(member.user)}
                          name={memberName(member.user, '队员')}
                          size="xs"
                        />
                      ))}
                    </span>
                    <span className="min-w-0">
                      {team.members.map((member) => memberName(member.user, '队员')).join(' · ')}
                    </span>
                  </span>
                  {team.entries.length > 0 && (
                    <ul className="flex flex-wrap gap-x-3 gap-y-1">
                      {team.entries.map((entry) => (
                        <li key={entry.id} className="text-xs text-muted-foreground">
                          {entry.event.title} · {entryStatusLabel(entry.status)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
