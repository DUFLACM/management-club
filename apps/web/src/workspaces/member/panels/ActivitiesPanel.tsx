/**
 * 成员端 · 活动目录 + 参与者活动详情页（页面内视图，不再全屏覆盖）。
 *
 * - 列表 GET /activities?tab=&type=&q=&cursor=；
 * - 详情 GET /activities/:id（?activity=<id> 直接进入，可分享/后退）；
 * - 详情页集成了：平台赛跳转卡、现场签到/签出（ActivityCheckinCard）、
 *   报名与申请讲题（POST lecture-requests）、讲题材料（上传/下载）、
 *   平台榜单成绩（GET standings：我的成绩/题目链接/社团对题数排名）；
 * - 手机端单列堆叠，xl 起主内容 + 侧栏两列。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CalculatorIcon,
  CalendarDaysIcon,
  CalendarXIcon,
  CoinsIcon,
  ExternalLinkIcon,
  FileDownIcon,
  GlobeIcon,
  LoaderCircleIcon,
  MapPinIcon,
  MicIcon,
  RefreshCwIcon,
  SearchIcon,
  StarIcon,
  TrophyIcon,
  UsersIcon,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrivateInfiniteQuery } from '@/lib/private-infinite';
import { usePrincipal } from '@/lib/session';
import { BindPlatformAccountDialog } from '@/components/club/BindPlatformAccountDialog';
import { useDebouncedValue, LoadMoreButton } from '@/lib/hooks';
import { ACTIVITY_TYPE_LABELS, activityTypeBadgeClass, activityTypeLabel, formatDateTime, formatStartEnd, formatVenue, platformContestUrl, platformLabel, policyLabel, relativeDeadline, memberName } from '@/lib/format';
import { ActivityCheckinCard } from '@/components/club/ActivityCheckinCard';
import { PanelHeader } from '@/components/club/PanelHeader';
import { MemberGate } from '@/components/club/QueryBoundary';
import { ErrorState } from '@/components/club/ErrorState';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { MemberAvatar } from '@/components/club/MemberAvatar';

interface ActivityCardDto {
  id: string;
  type: string;
  platform: string | null;
  platformContestId: string | null;
  title: string;
  startAt: string;
  endAt: string;
  registerDeadline: string | null;
  cancelDeadline: string | null;
  capacity: number | null;
  /** 团队活动每队人数；null 为个人报名（此时 capacity/enrolledCount 按人计，否则按队计） */
  teamSize: number | null;
  enrolledCount: number;
  requiredCount: number;
  waitlistCapacity: number | null;
  venue: { name: string; building: string | null; room: string | null } | null;
  attendancePolicy: string | null;
  remoteAllowed: boolean;
  requireValidSubmission: boolean;
  myRegistration: { status: string; waitlistSeq: number | null } | null;
}

interface ActivityDetailDto {
  id: string;
  type: string;
  title: string;
  status: string;
  platform: string | null;
  platformContestId: string | null;
  contest: { name: string; sourceUrl: string | null; startTime: string } | null;
  announcement: string;
  joinNotes: string | null;
  startAt: string;
  endAt: string;
  registerStartAt: string | null;
  registerDeadline: string | null;
  cancelDeadline: string | null;
  leaveDeadline: string | null;
  capacity: number | null;
  waitlistCapacity: number | null;
  remoteAllowed: boolean;
  remotePolicy: string | null;
  requireValidSubmission: boolean;
  teamSize: number | null;
  scoringConfig: Record<string, unknown> | null;
  registrations: Array<{ status: string; waitlistSeq: number | null; teamId: string | null }>;
  participants: Array<{ required: boolean }>;
  leaveRequests: Array<{ status: string; reason: string }>;
  remotePermissions: Array<{ status: string; reason: string }>;
  checkpoints: Array<{ checkpoint: 'IN' | 'OUT'; acceptedAt: string; method: string }>;
  lectureRequests: Array<{ id: string; topic: string | null; status: string; createdAt: string }>;
  materials: Array<{
    id: string;
    title: string;
    kind: string;
    fileName: string;
    sizeBytes: number | null;
    createdAt: string;
    uploaderUserId: string;
    user: { verifiedRealName: string; profile: { displayName: string | null } | null } | null;
  }>;
  policy: {
    policy: string;
    checkinOpenAt: string;
    checkinCloseAt: string;
    checkoutOpenAt: string | null;
    checkoutCloseAt: string | null;
    maxAccuracyMeters: string | number;
  } | null;
  venueBindings: Array<{
    venueVersionId: string;
    venueVersion: { building: string | null; room: string | null; venue: { name: string } };
  }>;
  /** 本活动获批讲题人的满意度评价（无讲题时为空数组） */
  lectureRatings?: LectureRatingDto[];
  /** 平台赛（牛客 / CF / AtCoder）报名前须绑定对应平台账号 */
  platformBinding?: { platform: string; bound: boolean } | null;
  /** 签到墙：已签到成员（按签到先后） */
  checkedIn?: {
    total: number;
    people: Array<{ userId: string; name: string; avatarAssetId: string | null; checkedInAt: string }>;
  };
  /** 团队活动上下文；个人活动为 null */
  team?: {
    teamSize: number;
    enrolledTeams: number;
    waitlistedTeams: number;
    myTeam: TeamBriefDto | null;
    captainTeams: Array<TeamBriefDto & { ready: boolean }>;
  } | null;
  activityPoints: {
    mine: Array<{ amount: number; category: string; scoreMonth: string; note: string | null; recordedAt: string }>;
    myTotal: number;
    board: Array<{ rank: number; userId: string; name: string; avatarAssetId?: string | null; total: number; count: number }>;
    totalAwarded: number;
  } | null;
}

interface TeamBriefDto {
  id: string;
  name: string;
  captainUserId: string;
  members: Array<{ userId: string; role: string; name: string; avatarAssetId: string | null }>;
}

interface LectureRatingDto {
  lectureRequestId: string;
  lecturerUserId: string;
  lecturerName: string;
  topic: string | null;
  isLecturer: boolean;
  canRate: boolean;
  blockedReason: string | null;
  myScore: number | null;
  myComment: string | null;
  /** 仅讲题人本人与活动负责人可见；其余人为 null */
  stats: { count: number; average: number; distribution: number[] } | null;
  comments: Array<{ id: string; score: number; comment: string; createdAt: string }> | null;
  hiddenComments: number;
}

interface StandingsCellDto {
  index: string;
  score: number;
  solved: boolean;
  failedCount: number | null;
}

interface StandingsDto {
  platform: string;
  contestId: string;
  contestUrl: string | null;
  ended: boolean;
  available: boolean;
  processing?: boolean;
  reason?: string;
  note: string | null;
  fetchedAt: string;
  problems: Array<{
    index: string;
    name: string | null;
    fullScore: number | null;
    url: string | null;
    clubSolved: number;
  }>;
  clubRanking: Array<{
    clubRank: number;
    userId: string;
    name: string;
    handle: string;
    displayName?: string | null;
    solvedCount: number;
    score: number;
    platformRank: number | null;
  }>;
  me: {
    clubRank: number;
    userId: string;
    name: string;
    handle: string;
    solvedCount: number;
    score: number;
    platformRank: number | null;
    cells: StandingsCellDto[];
  } | null;
  totalEntries: number;
}

const TAB_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'open', label: '可报名' },
  { value: 'mine', label: '我的报名' },
  { value: 'ongoing', label: '进行中' },
  { value: 'ended', label: '已结束' },
];

const MATERIAL_KIND_LABELS: Record<string, string> = {
  slides: '讲题幻灯片',
  solution: '题解',
  data: '数据',
  other: '其他',
};

const PLATFORM_BADGE: Record<string, string> = {
  nowcoder: '牛客',
  codeforces: 'Codeforces',
  atcoder: 'AtCoder',
  hydro: '校内 OJ',
};

function registrationBadgeOf(status: string | null | undefined): string {
  if (!status) return '未报名';
  if (status === 'enrolled') return '已报名';
  if (status === 'waitlisted') return '候补中';
  if (status === 'pending_approval') return '待审核';
  if (status === 'cancelled') return '已取消';
  return status;
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ActivitiesPanel() {
  const principal = usePrincipal();
  return (
    <MemberGate principal={principal}>
      {(principalId) => <ActivitiesBody principalId={principalId} />}
    </MemberGate>
  );
}

function ActivitiesBody({ principalId }: { principalId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') ?? 'all';
  const type = searchParams.get('type') ?? 'all';
  const activityId = searchParams.get('activity');
  const [searchInput, setSearchInput] = useState(searchParams.get('q') ?? '');
  const debouncedSearch = useDebouncedValue(searchInput, 450);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setSearchParams((previous) => {
        const next = new URLSearchParams(previous);
        if (value == null || value === '' || value === 'all') next.delete(key);
        else next.set(key, value);
        return next;
      });
    },
    [setSearchParams],
  );

  // 搜索词延迟写入 URL（作为查询 key 的一部分）
  useEffect(() => {
    if ((searchParams.get('q') ?? '') !== debouncedSearch) {
      setParam('q', debouncedSearch === '' ? null : debouncedSearch);
    }
  }, [debouncedSearch, searchParams, setParam]);

  // 列表查询保持 Hook 顺序稳定：详情打开时 enabled=false 不发请求
  const listQuery = usePrivateInfiniteQueryConditions({
    principalId,
    enabled: activityId == null,
    tab,
    type,
    debouncedSearch,
  });

  if (activityId) {
    return (
      <ActivityDetailPage
        principalId={principalId}
        activityId={activityId}
        onClose={() => setParam('activity', null)}
      />
    );
  }

  const items = listQuery.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader title="活动" description="周赛、训练、讲座与集体活动的报名、签到与成绩。" />
      <Tabs value={tab} onValueChange={(value) => setParam('tab', value === 'all' ? null : value)}>
        <TabsList aria-label="活动状态">
          {TAB_OPTIONS.map((option) => (
            <TabsTrigger key={option.value} value={option.value}>
              {option.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:w-64">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="搜索活动标题"
            className="pl-9"
            aria-label="搜索活动标题"
          />
        </div>
        <Select value={type} onValueChange={(value) => setParam('type', value)}>
          <SelectTrigger className="sm:w-44" aria-label="活动类型筛选">
            <SelectValue placeholder="全部类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            {Object.entries(ACTIVITY_TYPE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {listQuery.isPending ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-44 rounded-2xl" />
          ))}
        </div>
      ) : listQuery.isError ? (
        <Card>
          <CardContent className="py-10">
            <ErrorState
              description={listQuery.error.message}
              onRetry={() => {
                void listQuery.refetch();
              }}
              retrying={listQuery.isFetching}
            />
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {tab === 'mine'
              ? '还没有报名记录；切到「可报名」看看近期活动。'
              : debouncedSearch
                ? '没有匹配搜索条件的活动。'
                : '这里还没有活动，稍后再来看看。'}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {items.map((item) => (
            <ActivityCardView
              key={item.id}
              item={item}
              onOpen={() => setParam('activity', item.id)}
            />
          ))}
        </div>
      )}
      {!listQuery.isPending && !listQuery.isError && (
        <LoadMoreButton
          onClick={() => {
            void listQuery.fetchNextPage();
          }}
          loading={listQuery.isFetchingNextPage}
          hasNext={Boolean(listQuery.data?.pages.at(-1)?.nextCursor)}
          hint="已展示全部活动"
        />
      )}
    </div>
  );
}

/** 详情页打开时列表查询保持挂起但不请求（enabled=false） */
function usePrivateInfiniteQueryConditions({
  principalId,
  enabled,
  tab,
  type,
  debouncedSearch,
}: {
  principalId: string;
  enabled: boolean;
  tab: string;
  type: string;
  debouncedSearch: string;
}) {
  const query = usePrivateInfiniteQuery<{ items: ActivityCardDto[]; nextCursor?: string | null }, ApiError>(
    principalId,
    ['activities', 'list', tab, type, debouncedSearch],
    async (cursor) => {
      const params = new URLSearchParams({ tab });
      if (type !== 'all') params.set('type', type);
      if (debouncedSearch) params.set('q', debouncedSearch);
      if (cursor) params.set('cursor', cursor);
      const { data } = await api.get<{ items: ActivityCardDto[]; nextCursor?: string | null }>(
        `/activities?${params.toString()}`,
      );
      return data;
    },
    { enabled },
  );
  return query;
}

/** 活动状态 chip：进行中（绿点）/ 未开始（蓝点）/ 已结束（灰） */
function ActivityStatusChip({ startAt, endAt }: { startAt: string; endAt: string }) {
  const now = Date.now();
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  const state = now >= start && now <= end ? 'ongoing' : now < start ? 'upcoming' : 'ended';
  const tone =
    state === 'ongoing'
      ? 'bg-success-subtle text-success-foreground'
      : state === 'upcoming'
        ? 'bg-info-subtle text-info-foreground'
        : 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {state === 'ongoing' ? '进行中' : state === 'upcoming' ? '未开始' : '已结束'}
    </span>
  );
}

function ActivityCardView({ item, onOpen }: { item: ActivityCardDto; onOpen: () => void }) {
  const now = Date.now();
  const ongoing = new Date(item.startAt).getTime() <= now && now <= new Date(item.endAt).getTime();
  const isPlatform = Boolean(item.platform);
  const capacityRatio =
    item.capacity == null || item.capacity === 0 ? null : Math.min(1, item.enrolledCount / item.capacity);
  const deadlineSoon =
    item.registerDeadline != null &&
    new Date(item.registerDeadline).getTime() - now > 0 &&
    new Date(item.registerDeadline).getTime() - now < 24 * 3600_000;
  const deadlineText = item.registerDeadline ? relativeDeadline(item.registerDeadline) : null;

  return (
    <Card className="group h-full overflow-hidden pt-0 transition-colors hover:border-primary/50">
      {/* 顶部彩条：进行中绿色 / 平台赛主题蓝 / 常规中性 */}
      <div
        aria-hidden="true"
        className={
          ongoing
            ? 'h-1.5 w-full bg-gradient-to-r from-success via-success/60 to-transparent'
            : isPlatform
              ? 'h-1.5 w-full bg-gradient-to-r from-primary via-primary/50 to-transparent'
              : 'h-1.5 w-full bg-gradient-to-r from-muted via-muted/50 to-transparent'
        }
      />
      <CardContent className="flex h-full flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={onOpen}
            className="line-clamp-2 min-w-0 text-left text-[15px] leading-6 font-semibold text-foreground hover:text-primary"
          >
            {item.title}
          </button>
          <ActivityStatusChip startAt={item.startAt} endAt={item.endAt} />
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span
            className={`rounded-md px-1.5 py-0.5 font-medium ${activityTypeBadgeClass(item.type)}`}
          >
            {activityTypeLabel(item.type)}
          </span>
          {isPlatform && (
            <span className="rounded-md bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
              {PLATFORM_BADGE[item.platform!] ?? platformLabel(item.platform!)}平台赛
            </span>
          )}
          {item.attendancePolicy && (
            <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-muted-foreground">
              {policyLabel(item.attendancePolicy)}
            </span>
          )}
          {item.requireValidSubmission && (
            <span className="rounded-md bg-warning-subtle px-1.5 py-0.5 text-warning-foreground">需有效提交</span>
          )}
          {item.teamSize && (
            <span className="rounded-md bg-lilac-subtle px-1.5 py-0.5 font-medium text-lilac-foreground">
              {item.teamSize} 人组队
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1.5 text-sm">
          <p className="flex items-center gap-2 text-foreground">
            <CalendarDaysIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 truncate">{formatStartEnd(item.startAt, item.endAt)}</span>
          </p>
          <p className="flex items-center gap-2 text-muted-foreground">
            <MapPinIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{formatVenue(item.venue)}</span>
          </p>
        </div>

        {/* 名额进度 */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <UsersIcon className="size-3.5" aria-hidden="true" />
              {item.capacity == null ? (
                '名额不限'
              ) : (
                <span className="tabular-nums">
                  已报名 {item.enrolledCount}/{item.capacity}{item.teamSize ? ' 队' : ''}
                  {item.waitlistCapacity ? ` · 候补 ${item.waitlistCapacity}` : ''}
                </span>
              )}
              {item.requiredCount > 0 && <span className="tabular-nums">· 必到 {item.requiredCount}</span>}
            </span>
            {deadlineText && (
              <span className={`tabular-nums ${deadlineSoon ? 'font-medium text-warning-foreground' : 'text-muted-foreground'}`}>
                {deadlineText}
              </span>
            )}
          </div>
          {capacityRatio != null && (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="报名名额"
              aria-valuenow={item.enrolledCount}
              aria-valuemin={0}
              aria-valuemax={item.capacity ?? undefined}
            >
              <div
                className={`h-full rounded-full transition-[width] ${
                  capacityRatio >= 1
                    ? 'bg-destructive/70'
                    : capacityRatio >= 0.9
                      ? 'bg-warning'
                      : 'bg-primary'
                }`}
                style={{ width: `${Math.round(capacityRatio * 100)}%` }}
              />
            </div>
          )}
        </div>

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-3">
          {item.myRegistration ? (
            <StatusBadge kind="registration" value={registrationBadgeOf(item.myRegistration.status)} />
          ) : (
            <span className="text-xs text-muted-foreground">
              {item.registerDeadline ? `截止 ${formatDateTime(item.registerDeadline)}` : '报名未设截止'}
            </span>
          )}
          <Button size="sm" variant="ghost" className="group/btn font-medium text-primary hover:text-primary" onClick={onOpen}>
            详情与报名
            <ArrowRightIcon className="size-4 transition-transform group-hover/btn:translate-x-0.5" aria-hidden="true" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ActivityDetailPage({
  principalId,
  activityId,
  onClose,
}: {
  principalId: string;
  activityId: string;
  onClose: () => void;
}) {
  const principal = usePrincipal();
  const canManageActivities = (principal?.roles ?? []).some((role) =>
    ['activity_manager', 'presidium', 'system_admin'].includes(role),
  );

  const query = usePrivateQuery<ActivityDetailDto, ApiError>(
    principalId,
    ['activities', 'detail', activityId],
    async () => (await api.get<ActivityDetailDto>(`/activities/${activityId}`)).data,
  );

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-14 rounded-2xl" />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex flex-col gap-4">
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-56 rounded-2xl" />
          </div>
          <Skeleton className="h-56 rounded-2xl" />
        </div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="flex flex-col gap-4">
        <Button variant="ghost" size="sm" className="w-fit" onClick={onClose}>
          <ArrowLeftIcon aria-hidden="true" />
          返回活动列表
        </Button>
        <Card>
          <CardContent className="py-10">
            <ErrorState description={query.error.message} onRetry={() => void query.refetch()} />
          </CardContent>
        </Card>
      </div>
    );
  }

  const detail = query.data;
  const lectureRequest = detail.lectureRequests?.[0] ?? null;
  const lectureApproved = lectureRequest?.status === 'approved';
  const lectureRatings = detail.lectureRatings ?? [];
  const canUpload = lectureApproved || canManageActivities;
  const platformUrl = platformContestUrl(detail.platform, detail.platformContestId)
    ?? detail.contest?.sourceUrl ?? null;
  const isPlatformContest = Boolean(detail.platform && detail.platformContestId);
  const ended = new Date(detail.endAt).getTime() <= Date.now();

  return (
    <div className="flex flex-col gap-4">
      {/* 页头：返回 + 标题 + 关键徽标 */}
      <div className="flex flex-col gap-3">
        <Button variant="ghost" size="sm" className="w-fit -ml-2" onClick={onClose}>
          <ArrowLeftIcon aria-hidden="true" />
          返回活动列表
        </Button>
        <div className="flex flex-col gap-2">
          <h1 className="text-xl leading-8 font-semibold text-foreground sm:text-2xl">{detail.title}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span
              className={`inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-medium ${activityTypeBadgeClass(detail.type)}`}
            >
              {activityTypeLabel(detail.type)}
            </span>
            {isPlatformContest && (
              <span className="inline-flex shrink-0 items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {PLATFORM_BADGE[detail.platform!] ?? platformLabel(detail.platform!)}平台赛
              </span>
            )}
            <ActivityStatusChip startAt={detail.startAt} endAt={detail.endAt} />
            <span className="flex items-center gap-1">
              <CalendarDaysIcon className="size-3.5" aria-hidden="true" />
              {formatStartEnd(detail.startAt, detail.endAt)}
            </span>
            {detail.venueBindings[0] && (
              <span className="flex items-center gap-1">
                <MapPinIcon className="size-3.5" aria-hidden="true" />
                {formatVenue({
                  name: detail.venueBindings[0].venueVersion.venue.name,
                  building: detail.venueBindings[0].venueVersion.building,
                  room: detail.venueBindings[0].venueVersion.room,
                })}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        {/* 主列 */}
        <div className="flex min-w-0 flex-col gap-4">
          {isPlatformContest && (
            <ContestJumpCard
              platform={detail.platform!}
              contestName={detail.contest?.name ?? null}
              contestUrl={platformUrl}
            />
          )}

          {/* 现场签到/签出 */}
          <Card>
            <CardContent className="flex flex-col gap-4 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[15px] font-semibold text-foreground">现场签到 / 签退</h2>
                {detail.policy && (
                  <span className="text-xs text-muted-foreground">
                    {policyLabel(detail.policy.policy)}
                  </span>
                )}
              </div>
              <ActivityCheckinCard principalId={principalId} activityId={activityId} />
            </CardContent>
          </Card>

          {/* 签到墙：已签到成员头像 */}
          {detail.checkedIn && <CheckedInWall checkedIn={detail.checkedIn} />}

          {/* 报名与讲题申请 */}
          <RegistrationSection
            principalId={principalId}
            activityId={activityId}
            detail={detail}
            lectureRequest={lectureRequest}
          />

          {/* 讲题材料 */}
          <MaterialsSection
            principalId={principalId}
            activityId={activityId}
            materials={detail.materials}
            canUpload={canUpload}
            lectureApproved={lectureApproved}
          />

          {/* 讲题满意度：仅在本活动有获批讲题人时出现 */}
          {lectureRatings.length > 0 && (
            <LectureRatingSection
              principalId={principalId}
              activityId={activityId}
              ratings={lectureRatings}
            />
          )}

          {/* 平台赛成绩 */}
          {isPlatformContest && (
            <StandingsSection activityId={activityId} ended={ended} contestUrl={platformUrl} />
          )}

          {/* 活动积分（手动入账带 activityId 的流水；结算后在成员端展示） */}
          <ActivityPointsCard detail={detail} />

          {/* 本次活动适用的计分规则 */}
          <ScoringRulesCard detail={detail} />

          {/* 公告 */}
          <Card>
            <CardContent className="flex flex-col gap-2 p-5">
              <h2 className="text-[15px] font-semibold text-foreground">公告</h2>
              <p className="text-sm leading-[22px] whitespace-pre-wrap text-foreground/90">
                {detail.announcement}
              </p>
              {detail.joinNotes && (
                <p className="text-sm leading-[22px] whitespace-pre-wrap text-muted-foreground">
                  参加须知：{detail.joinNotes}
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* 侧栏 */}
        <aside className="flex flex-col gap-4">
          <Card>
            <CardContent className="flex flex-col gap-3 p-5">
              <h2 className="text-[15px] font-semibold text-foreground">活动信息</h2>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">开始 / 结束</dt>
                <dd>{formatStartEnd(detail.startAt, detail.endAt)}</dd>
                <dt className="text-muted-foreground">报名开始</dt>
                <dd>{detail.registerStartAt ? formatDateTime(detail.registerStartAt) : '随公告开放'}</dd>
                <dt className="text-muted-foreground">报名截止</dt>
                <dd>{detail.registerDeadline ? formatDateTime(detail.registerDeadline) : '不限'}</dd>
                <dt className="text-muted-foreground">取消截止</dt>
                <dd>{detail.cancelDeadline ? formatDateTime(detail.cancelDeadline) : '不限'}</dd>
                <dt className="text-muted-foreground">请假截止</dt>
                <dd>{detail.leaveDeadline ? formatDateTime(detail.leaveDeadline) : '不限'}</dd>
                {detail.teamSize && (
                  <>
                    <dt className="text-muted-foreground">报名方式</dt>
                    <dd>{detail.teamSize} 人小队报名</dd>
                  </>
                )}
                <dt className="text-muted-foreground">容量 / 候补</dt>
                <dd className="tabular-nums">
                  {detail.capacity ?? '不限'} / {detail.waitlistCapacity ?? 0}
                  {detail.teamSize ? ' 队' : ''}
                </dd>
                {detail.policy && (
                  <>
                    <dt className="text-muted-foreground">签到方式</dt>
                    <dd>{policyLabel(detail.policy.policy)}</dd>
                    <dt className="text-muted-foreground">签到窗口</dt>
                    <dd>{formatStartEnd(detail.policy.checkinOpenAt, detail.policy.checkinCloseAt)}</dd>
                  </>
                )}
                {detail.venueBindings.length > 0 && (
                  <>
                    <dt className="text-muted-foreground">地点</dt>
                    <dd>
                      <ul className="flex flex-col gap-0.5">
                        {detail.venueBindings.map((binding) => (
                          <li key={binding.venueVersionId}>
                            {[binding.venueVersion.venue.name, binding.venueVersion.building, binding.venueVersion.room]
                              .filter(Boolean)
                              .join(' ')}
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </>
                )}
              </dl>
              {detail.remoteAllowed && detail.remotePolicy && (
                <p className="text-xs leading-5 text-muted-foreground">远程规则：{detail.remotePolicy}</p>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/**
 * 签到墙：已签到成员头像 + 名字。手机 5 列、平板 8 列、宽屏 10 列；默认展示前两行，可展开全部。
 * 主页设为「仅自己可见」的成员只显示首字头像。
 */
function CheckedInWall({ checkedIn }: { checkedIn: NonNullable<ActivityDetailDto['checkedIn']> }) {
  const [expanded, setExpanded] = useState(false);
  const COLLAPSED = 20;
  const people = expanded ? checkedIn.people : checkedIn.people.slice(0, COLLAPSED);
  const hidden = checkedIn.people.length - people.length;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
            <UsersIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            已签到
            <span className="text-sm font-normal text-muted-foreground tabular-nums">{checkedIn.total} 人</span>
          </h2>
        </div>
        {checkedIn.total === 0 ? (
          <p className="text-sm text-muted-foreground">还没有人签到。</p>
        ) : (
          <>
            <ul className="grid grid-cols-5 gap-x-2 gap-y-3 sm:grid-cols-8 lg:grid-cols-10" aria-label="已签到成员">
              {people.map((person) => (
                <li
                  key={person.userId}
                  className="flex min-w-0 flex-col items-center gap-1"
                  title={`${person.name} · ${formatDateTime(person.checkedInAt)} 签到`}
                >
                  <MemberAvatar assetId={person.avatarAssetId} name={person.name} size="md" />
                  <span className="w-full truncate text-center text-[11px] leading-4 text-muted-foreground">
                    {person.name}
                  </span>
                </li>
              ))}
            </ul>
            {(hidden > 0 || expanded) && (
              <Button
                variant="ghost"
                size="sm"
                className="self-center"
                onClick={() => setExpanded((previous) => !previous)}
              >
                {expanded ? '收起' : `展开全部（还有 ${hidden} 人）`}
              </Button>
            )}
            {checkedIn.total > checkedIn.people.length && (
              <p className="text-center text-xs text-muted-foreground">
                仅显示前 {checkedIn.people.length} 位签到成员。
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** 小队成员一行：头像 + 名字，队长标注 */
function TeamMembersRow({ team }: { team: TeamBriefDto }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {team.members.map((member) => (
        <li key={member.userId} className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <MemberAvatar assetId={member.avatarAssetId} name={member.name} size="xs" />
          <span className="max-w-[8rem] truncate">{member.name}</span>
          {member.role === 'captain' && <span className="text-primary">队长</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * 团队报名：已报名时展示报名小队；否则队长从自己带的、人数恰好满足要求的小队中选一个整队报名。
 * 不是队长 / 没有合适小队时引导去组队广场建队或招募。
 */
function TeamRegistration({
  activityId,
  team,
  registration,
  principalId,
  onDone,
  onError,
  disabled,
}: {
  activityId: string;
  team: NonNullable<ActivityDetailDto['team']>;
  registration: ActivityDetailDto['registrations'][number] | undefined;
  principalId: string;
  onDone: (message: string) => void;
  onError: (message: string) => void;
  disabled: boolean;
}) {
  const readyTeams = team.captainTeams.filter((candidate) => candidate.ready);
  const [teamId, setTeamId] = useState(readyTeams[0]?.id ?? '');
  const active = registration && ['enrolled', 'waitlisted', 'pending_approval'].includes(registration.status);

  const registerMutation = useMutation({
    mutationFn: async () =>
      (
        await api.post<{ status: string; waitlistSeq: number | null; message: string }>(
          `/activities/${activityId}/team-registrations`,
          { teamId },
        )
      ).data,
    onSuccess: (result) => onDone(result.message),
    onError: (error: ApiError) => onError(error.message),
  });

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <UsersIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          {team.teamSize} 人小队报名
        </p>
        <span className="text-xs text-muted-foreground tabular-nums">
          已报名 {team.enrolledTeams} 队{team.waitlistedTeams ? ` · 候补 ${team.waitlistedTeams} 队` : ''}
        </span>
      </div>

      {active && team.myTeam ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-foreground">
            你随小队「<span className="font-medium">{team.myTeam.name}</span>」报名
            {team.myTeam.captainUserId !== principalId && '，如需取消请联系队长'}。
          </p>
          <TeamMembersRow team={team.myTeam} />
        </div>
      ) : readyTeams.length > 0 ? (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            if (teamId) registerMutation.mutate();
          }}
        >
          <Select value={teamId} onValueChange={setTeamId}>
            <SelectTrigger className="w-full sm:w-64" aria-label="选择报名小队">
              <SelectValue placeholder="选择小队" />
            </SelectTrigger>
            <SelectContent>
              {readyTeams.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit" disabled={disabled || !teamId || registerMutation.isPending}>
            {registerMutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            以小队报名
          </Button>
        </form>
      ) : (
        <p className="text-sm leading-[22px] text-muted-foreground">
          {team.captainTeams.length > 0
            ? `你带的小队还没凑满 ${team.teamSize} 人（${team.captainTeams
                .map((candidate) => `${candidate.name} ${candidate.members.length}/${team.teamSize}`)
                .join('、')}）。`
            : `本活动需由队长带 ${team.teamSize} 人小队报名；队员无需单独报名，队长报名后全队自动报名。`}
        </p>
      )}

      {!active && (
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <a href="/app?section=contests&tab=teams">去组队广场建队 / 招募队友</a>
          </Button>
        </div>
      )}
      {readyTeams.length > 0 && !active && (
        <p className="text-xs text-muted-foreground">报名后全体队员自动报名；容量与候补按队计算。</p>
      )}
      {team.captainTeams
        .filter((candidate) => candidate.ready && candidate.id === teamId)
        .map((candidate) => (
          <TeamMembersRow key={candidate.id} team={candidate} />
        ))}
    </div>
  );
}

/** 平台赛跳转卡：比赛名 + 平台徽标 + 前往比赛外链 */
function ContestJumpCard({
  platform,
  contestName,
  contestUrl,
}: {
  platform: string;
  contestName: string | null;
  contestUrl: string | null;
}) {
  return (
    <Card className="border-primary/30 bg-gradient-to-br from-primary/10 via-card to-card">
      <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 font-semibold text-primary">
            {PLATFORM_BADGE[platform] ?? platformLabel(platform)}
          </span>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              {PLATFORM_BADGE[platform] ?? platformLabel(platform)}平台赛 · 报名与平台报名分别办理
            </p>
            <p className="truncate text-[15px] font-semibold text-foreground">
              {contestName ?? '平台比赛'}
            </p>
          </div>
        </div>
        {contestUrl ? (
          <Button asChild className="shrink-0">
            <a href={contestUrl} target="_blank" rel="noreferrer">
              <ExternalLinkIcon aria-hidden="true" />
              前往比赛页面
            </a>
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">暂缺比赛链接</span>
        )}
      </CardContent>
    </Card>
  );
}

function RegistrationSection({
  principalId,
  activityId,
  detail,
  lectureRequest,
}: {
  principalId: string;
  activityId: string;
  detail: ActivityDetailDto;
  lectureRequest: ActivityDetailDto['lectureRequests'][number] | null;
}) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [leaveReason, setLeaveReason] = useState('');
  const [remoteReason, setRemoteReason] = useState('');
  const [showLeaveForm, setShowLeaveForm] = useState(false);
  const [showRemoteForm, setShowRemoteForm] = useState(false);
  const [lectureTopic, setLectureTopic] = useState('');
  const [bindOpen, setBindOpen] = useState(false);
  const needsBinding = detail.platformBinding != null && !detail.platformBinding.bound;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'activities'] });
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'me'] });
  }, [principalId, queryClient]);

  const registerMutation = useMutation({
    mutationFn: async () =>
      (
        await api.post<{ status: string; waitlistSeq: number | null; message: string }>(
          `/activities/${activityId}/registrations`,
          { idempotencyKey: crypto.randomUUID() },
        )
      ).data,
    onSuccess: (result) => {
      setActionError(null);
      setActionNotice(result.message);
      invalidate();
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async () =>
      (await api.delete<{ status: string; promoted?: string }>(`/activities/${activityId}/registrations/me`)).data,
    onSuccess: (result) => {
      setActionError(null);
      setActionNotice(
        result.promoted === 'enrolled'
          ? '已取消报名；候补第一位已递补。'
          : result.promoted === 'confirm_required'
            ? '已取消报名；候补第一位需确认是否递补。'
            : '已取消报名。',
      );
      invalidate();
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  const leaveMutation = useMutation({
    mutationFn: async (reason: string) => {
      await api.post(`/activities/${activityId}/leave-requests`, { reason });
      return true;
    },
    onSuccess: () => {
      setActionError(null);
      setActionNotice('请假申请已提交，等待负责人审核。');
      setShowLeaveForm(false);
      setLeaveReason('');
      invalidate();
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  const remoteMutation = useMutation({
    mutationFn: async (reason: string) => {
      await api.post(`/activities/${activityId}/remote-requests`, { reason });
      return true;
    },
    onSuccess: () => {
      setActionError(null);
      setActionNotice('远程参赛申请已提交（点击不等于取得计分许可，需审批）。');
      setShowRemoteForm(false);
      setRemoteReason('');
      invalidate();
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  const lectureMutation = useMutation({
    mutationFn: async (topic: string) => {
      await api.post(`/activities/${activityId}/lecture-requests`, topic ? { topic } : {});
      return true;
    },
    onSuccess: () => {
      setActionError(null);
      setActionNotice('讲题申请已提交，负责人审批通过后即可上传本次材料。');
      setLectureTopic('');
      invalidate();
    },
    onError: (error: ApiError) => {
      setActionNotice(null);
      setActionError(error.message);
    },
  });

  const registration = detail.registrations[0];
  const required = detail.participants[0]?.required ?? false;
  const activityEnded = new Date(detail.endAt).getTime() <= Date.now();

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-5">
        <h2 className="text-[15px] font-semibold text-foreground">报名 / 请假 / 讲题</h2>

        {actionError && (
          <Alert variant="destructive">
            <AlertTitle>操作未完成</AlertTitle>
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}
        {actionNotice && !actionError && (
          <Alert>
            <AlertTitle>已更新</AlertTitle>
            <AlertDescription>{actionNotice}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {registration ? (
            <>
              <StatusBadge kind="registration" value={registrationBadgeOf(registration.status)} />
              {registration.status === 'waitlisted' && registration.waitlistSeq != null && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  候补第 {registration.waitlistSeq} 位
                </span>
              )}
            </>
          ) : required ? (
            <StatusBadge kind="registration" value="必到名单" />
          ) : (
            <span className="text-sm text-muted-foreground">当前未报名。</span>
          )}
          {required && (
            <span className="text-xs text-muted-foreground">
              {registration?.status === 'enrolled'
                ? '已报名，如需缺席请提交请假申请。'
                : '现场签到成功后自动报名；出勤截止无操作将记为缺勤。'}
            </span>
          )}
        </div>

        {needsBinding && !activityEnded && (
          <Alert>
            <AlertTitle>报名前需绑定{platformLabel(detail.platformBinding!.platform)}账号</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              <span>本场成绩按绑定账号从平台榜单自动计分，未绑定无法报名参赛。</span>
              <Button size="sm" variant="outline" onClick={() => setBindOpen(true)}>
                去绑定
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <BindPlatformAccountDialog
          principalId={principalId}
          open={bindOpen}
          onOpenChange={setBindOpen}
          defaultPlatform={detail.platformBinding?.platform}
          onSuccess={() => {
            setActionError(null);
            setActionNotice('平台账号已提交绑定，现在可以报名了。');
            invalidate();
          }}
        />

        {detail.team && (
          <TeamRegistration
            activityId={activityId}
            team={detail.team}
            registration={registration}
            principalId={principalId}
            onDone={(message) => {
              setActionError(null);
              setActionNotice(message);
              invalidate();
            }}
            onError={(message) => {
              setActionNotice(null);
              setActionError(message);
            }}
            disabled={activityEnded}
          />
        )}

        <div className="flex flex-wrap gap-2">
          {!required && !detail.teamSize && (!registration ||
            !['enrolled', 'waitlisted', 'pending_approval'].includes(registration.status)) && (
            <Button
              onClick={() => (needsBinding ? setBindOpen(true) : registerMutation.mutate())}
              disabled={registerMutation.isPending}
            >
              {registerMutation.isPending && (
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
              )}
              报名
            </Button>
          )}
          {!required && registration &&
            ['enrolled', 'waitlisted', 'pending_approval'].includes(registration.status) && (
              <Button
                variant="outline"
                onClick={() => cancelMutation.mutate()}
                disabled={cancelMutation.isPending}
              >
                {cancelMutation.isPending && (
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                )}
                {registration.teamId ? '取消小队报名' : '取消报名'}
              </Button>
            )}
          {!showLeaveForm && (
            <Button variant="outline" onClick={() => setShowLeaveForm(true)}>
              <CalendarXIcon aria-hidden="true" />
              请假
            </Button>
          )}
          {detail.remoteAllowed && !showRemoteForm && (
            <Button variant="outline" onClick={() => setShowRemoteForm(true)}>
              <GlobeIcon aria-hidden="true" />
              申请远程
            </Button>
          )}
        </div>

        {showLeaveForm && (
          <form
            className="flex flex-col gap-2 rounded-xl border border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (leaveReason.trim().length >= 3) leaveMutation.mutate(leaveReason.trim());
            }}
          >
            <Label htmlFor="leave-reason">请假原因（至少 3 字）</Label>
            <Textarea
              id="leave-reason"
              value={leaveReason}
              onChange={(event) => setLeaveReason(event.target.value)}
              rows={3}
              maxLength={1000}
              required
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={leaveMutation.isPending || leaveReason.trim().length < 3}>
                {leaveMutation.isPending && (
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                )}
                提交请假
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setShowLeaveForm(false)}>
                收起
              </Button>
            </div>
          </form>
        )}
        {showRemoteForm && (
          <form
            className="flex flex-col gap-2 rounded-xl border border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (remoteReason.trim().length >= 3) remoteMutation.mutate(remoteReason.trim());
            }}
          >
            <Label htmlFor="remote-reason">远程参赛原因（至少 3 字）</Label>
            <Textarea
              id="remote-reason"
              value={remoteReason}
              onChange={(event) => setRemoteReason(event.target.value)}
              rows={3}
              maxLength={1000}
              required
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={remoteMutation.isPending || remoteReason.trim().length < 3}>
                {remoteMutation.isPending && (
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                )}
                提交申请
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setShowRemoteForm(false)}>
                收起
              </Button>
            </div>
          </form>
        )}

        {detail.leaveRequests[0] && (
          <p className="text-xs text-muted-foreground">
            当前请假申请状态：
            {detail.leaveRequests[0].status === 'approved'
              ? '已批准'
              : detail.leaveRequests[0].status === 'rejected'
                ? '已驳回'
                : '待审核'}
          </p>
        )}
        {detail.remotePermissions[0] && (
          <p className="text-xs text-muted-foreground">
            远程申请状态：
            {detail.remotePermissions[0].status === 'approved'
              ? '已批准'
              : detail.remotePermissions[0].status === 'rejected'
                ? '已驳回'
                : '待审核'}
          </p>
        )}
        {detail.registerDeadline && !activityEnded && (
          <p className="text-xs text-muted-foreground">
            {relativeDeadline(detail.registerDeadline) ?? '报名已截止'}（截止{' '}
            {formatDateTime(detail.registerDeadline)}）
          </p>
        )}

        {/* 申请讲题 */}
        <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <MicIcon className="size-4 text-primary" aria-hidden="true" />
            <span className="text-sm font-medium text-foreground">申请讲题</span>
            {lectureRequest && (
              <StatusBadge
                kind="disclosure"
                value={
                  lectureRequest.status === 'approved'
                    ? '已获上传权限'
                    : lectureRequest.status === 'pending'
                      ? '审核中'
                      : '未通过'
                }
              />
            )}
          </div>
          {lectureRequest?.status === 'approved' ? (
            <p className="text-xs leading-5 text-muted-foreground">
              你已获得本次活动的材料上传权限，可在「讲题材料」区上传幻灯片与题解。
            </p>
          ) : lectureRequest?.status === 'pending' ? (
            <p className="text-xs leading-5 text-muted-foreground">
              申请已提交（{lectureRequest.topic ? `主题：${lectureRequest.topic}` : '未填主题'}），等待负责人审批。
            </p>
          ) : (
            <>
              <p className="text-xs leading-5 text-muted-foreground">
                {lectureRequest?.status === 'rejected'
                  ? '上次申请未通过，可修改主题后重新提交。'
                  : '审批通过后可获得本次活动讲题材料（幻灯片/题解）的上传权限。'}
              </p>
              {!activityEnded && (
                <form
                  className="flex flex-col gap-2 sm:flex-row sm:items-end"
                  onSubmit={(event) => {
                    event.preventDefault();
                    lectureMutation.mutate(lectureTopic.trim());
                  }}
                >
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor="lecture-topic">讲题主题（可选）</Label>
                    <Input
                      id="lecture-topic"
                      value={lectureTopic}
                      onChange={(event) => setLectureTopic(event.target.value)}
                      maxLength={200}
                      placeholder="例如：最短路专题"
                    />
                  </div>
                  <Button type="submit" size="sm" disabled={lectureMutation.isPending}>
                    {lectureMutation.isPending && (
                      <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                    )}
                    {lectureRequest?.status === 'rejected' ? '重新申请' : '申请讲题'}
                  </Button>
                </form>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function MaterialsSection({
  principalId,
  activityId,
  materials,
  canUpload,
  lectureApproved,
}: {
  principalId: string;
  activityId: string;
  materials: ActivityDetailDto['materials'];
  canUpload: boolean;
  lectureApproved: boolean;
}) {
  const queryClient = useQueryClient();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('solution');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const principal = usePrincipal();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'activities'] });
  }, [principalId, queryClient]);

  const submitUpload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('title', title.trim() || file.name.replace(/\.[^.]+$/, '').slice(0, 200) || '未命名材料');
      form.append('kind', kind);
      await api.upload(`/activities/${activityId}/materials`, form);
      setTitle('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      invalidate();
    } catch (error) {
      setUploadError(error instanceof ApiError ? error.message : '上传失败，请重试。');
    } finally {
      setUploading(false);
    }
  };

  const removeMaterial = async (materialId: string) => {
    setUploadError(null);
    try {
      await api.delete(`/activities/${activityId}/materials/${materialId}`);
      invalidate();
    } catch (error) {
      setUploadError(error instanceof ApiError ? error.message : '删除失败。');
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-foreground">讲题材料</h2>
          <span className="text-xs text-muted-foreground">
            {materials.length > 0 ? `共 ${materials.length} 份` : '暂无材料'}
          </span>
        </div>

        {uploadError && (
          <Alert variant="destructive">
            <AlertTitle>上传未完成</AlertTitle>
            <AlertDescription>{uploadError}</AlertDescription>
          </Alert>
        )}

        {materials.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            还没有上传材料；讲题获批后可在此上传幻灯片与题解。
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {materials.map((material) => (
              <li key={material.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{material.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {MATERIAL_KIND_LABELS[material.kind] ?? material.kind} · {formatSize(material.sizeBytes)} ·{' '}
                    {memberName(material.user)} ·{' '}
                    {formatDateTime(material.createdAt)}
                  </p>
                </div>
                <Button asChild size="sm" variant="outline">
                  <a
                    href={`/api/v1/activities/${activityId}/materials/${material.id}/download`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <FileDownIcon aria-hidden="true" />
                    下载
                  </a>
                </Button>
                {(material.uploaderUserId === principal?.userId || canUpload) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => void removeMaterial(material.id)}
                  >
                    删除
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {canUpload && (
          <form
            className="flex flex-col gap-2 rounded-xl border border-dashed border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              const file = fileInputRef.current?.files?.[0];
              if (file) void submitUpload(file);
            }}
          >
            <p className="text-xs text-muted-foreground">
              {lectureApproved ? '讲题申请已获批' : '管理员权限'}：可上传本次活动的讲题幻灯片 / 题解（PDF、Markdown、Office、图片、ZIP，≤20 MiB）。
            </p>
            <div className="grid gap-2 sm:grid-cols-[1fr_150px]">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="material-title">材料标题</Label>
                <Input
                  id="material-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={200}
                  placeholder="留空则使用文件名"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="material-kind">类型</Label>
                <Select value={kind} onValueChange={setKind}>
                  <SelectTrigger id="material-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="slides">讲题幻灯片</SelectItem>
                    <SelectItem value="solution">题解</SelectItem>
                    <SelectItem value="data">数据</SelectItem>
                    <SelectItem value="other">其他</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                id="material-file"
                type="file"
                accept=".pdf,.md,.txt,.zip,.pptx,.docx,.png,.jpg,.jpeg"
                className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80"
              />
              <Button type="submit" size="sm" disabled={uploading}>
                {uploading && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
                上传材料
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

const RATING_LABELS = ['', '很不满意', '不满意', '一般', '满意', '非常满意'];

/** 1–5 星选择/展示；readOnly 时仅渲染，不接受点击 */
function StarRow({
  value,
  onChange,
  idPrefix,
}: {
  value: number;
  onChange?: (next: number) => void;
  idPrefix: string;
}) {
  const readOnly = !onChange;
  return (
    <div className="flex items-center gap-1" role={readOnly ? 'img' : 'radiogroup'} aria-label={`满意度 ${value} 星`}>
      {[1, 2, 3, 4, 5].map((star) => {
        const active = star <= value;
        const tone = active ? 'fill-warning-foreground text-warning-foreground' : 'text-muted-foreground/50';
        if (readOnly) {
          return (
            <span key={`${idPrefix}-${star}`}>
              <StarIcon className={`size-4 ${tone}`} aria-hidden="true" />
            </span>
          );
        }
        return (
          <button
            key={`${idPrefix}-${star}`}
            type="button"
            role="radio"
            aria-checked={star === value}
            aria-label={`${star} 星：${RATING_LABELS[star] ?? ''}`}
            // 手机端点选：min-size 保证 ≥40px 触控区
            className="flex size-10 items-center justify-center rounded-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={() => onChange(star)}
          >
            <StarIcon className={`size-6 ${tone}`} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

/**
 * 讲题满意度：活动有获批讲题人时出现。
 * 评分匿名提交（接口不返回评价人），汇总只对讲题人本人与活动负责人展示。
 */
function LectureRatingSection({
  principalId,
  activityId,
  ratings,
}: {
  principalId: string;
  activityId: string;
  ratings: LectureRatingDto[];
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
            <StarIcon className="size-4 text-primary" aria-hidden="true" />
            讲题满意度
          </h2>
          <span className="text-xs text-muted-foreground">匿名评分 · 共 {ratings.length} 位讲题人</span>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          评分与评语匿名提交，讲题人与活动负责人只能看到汇总结果，看不到是谁打的分。
        </p>
        <div className="flex flex-col gap-3">
          {ratings.map((rating) => (
            <LectureRatingRow
              key={rating.lectureRequestId}
              principalId={principalId}
              activityId={activityId}
              rating={rating}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function LectureRatingRow({
  principalId,
  activityId,
  rating,
}: {
  principalId: string;
  activityId: string;
  rating: LectureRatingDto;
}) {
  const queryClient = useQueryClient();
  const [score, setScore] = useState(rating.myScore ?? 0);
  const [comment, setComment] = useState(rating.myComment ?? '');
  const [error, setError] = useState<string | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'activities'] });
  }, [principalId, queryClient]);

  const basePath = `/activities/${activityId}/lectures/${rating.lectureRequestId}/rating`;

  const submit = useMutation({
    mutationFn: async () =>
      api.post(basePath, { score, comment: comment.trim() ? comment.trim() : null }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : '提交失败，请重试。'),
  });

  const revoke = useMutation({
    mutationFn: async () => api.delete(basePath),
    onSuccess: () => {
      setError(null);
      setScore(0);
      setComment('');
      invalidate();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : '撤销失败，请重试。'),
  });

  const pending = submit.isPending || revoke.isPending;
  const stats = rating.stats;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <MicIcon className="size-4 text-primary" aria-hidden="true" />
        <span className="text-sm font-medium text-foreground">{rating.lecturerName}</span>
        {rating.isLecturer && <StatusBadge kind="disclosure" value="我的讲题" />}
        {rating.topic && <span className="text-xs text-muted-foreground">主题：{rating.topic}</span>}
      </div>

      {/* 汇总：仅讲题人本人与活动负责人可见 */}
      {stats && (
        <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3">
          {stats.count === 0 ? (
            <p className="text-xs text-muted-foreground">还没有成员提交评分。</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-lg font-semibold text-foreground">{stats.average.toFixed(1)}</span>
                <StarRow value={Math.round(stats.average)} idPrefix={`avg-${rating.lectureRequestId}`} />
                <span className="text-xs text-muted-foreground">{stats.count} 人评分</span>
              </div>
              <ul className="flex flex-col gap-1">
                {[5, 4, 3, 2, 1].map((star) => {
                  const count = stats.distribution[star - 1] ?? 0;
                  const ratio = stats.count > 0 ? (count / stats.count) * 100 : 0;
                  return (
                    <li key={star} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="w-10 shrink-0">{star} 星</span>
                      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border">
                        <span className="block h-full rounded-full bg-primary" style={{ width: `${ratio}%` }} />
                      </span>
                      <span className="w-8 shrink-0 text-right">{count}</span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}

      {/* 匿名评语：样本过少时不向讲题人展示，避免反推评价人 */}
      {rating.comments && rating.comments.length > 0 && (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="w-fit px-2"
            onClick={() => setCommentsOpen((open) => !open)}
          >
            {commentsOpen ? '收起' : `查看匿名评语（${rating.comments.length}）`}
          </Button>
          {commentsOpen && (
            <ul className="flex flex-col divide-y divide-border">
              {rating.comments.map((item) => (
                <li key={item.id} className="flex flex-col gap-1 py-2">
                  <StarRow value={item.score} idPrefix={`c-${item.id}`} />
                  <p className="text-sm leading-[22px] whitespace-pre-wrap text-foreground/90">{item.comment}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {rating.hiddenComments > 0 && (
        <p className="text-xs text-muted-foreground">
          已收到 {rating.hiddenComments} 条匿名评语，评分人数达到 3 人后才会展示（防止反推评价人）。
        </p>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>操作未完成</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {rating.canRate ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (score < 1) {
              setError('请先选择 1–5 星再提交。');
              return;
            }
            submit.mutate();
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <StarRow value={score} onChange={setScore} idPrefix={`pick-${rating.lectureRequestId}`} />
            <span className="text-xs text-muted-foreground">{RATING_LABELS[score] ?? '未评分'}</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`rating-comment-${rating.lectureRequestId}`}>评语（可选，匿名）</Label>
            <Textarea
              id={`rating-comment-${rating.lectureRequestId}`}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              maxLength={500}
              rows={2}
              placeholder="例如：讲解节奏合适，希望多讲一些例题"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {submit.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
              {rating.myScore === null ? '提交评分' : '更新评分'}
            </Button>
            {rating.myScore !== null && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={pending}
                  onClick={() => revoke.mutate()}
                >
                  {revoke.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
                  撤销评分
                </Button>
                <span className="text-xs text-muted-foreground">
                  已提交 {rating.myScore} 星，可随时修改。
                </span>
              </>
            )}
          </div>
        </form>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">{rating.blockedReason}</p>
      )}
    </div>
  );
}

/** 本次活动适用的计分规则（按活动类型区分比赛分公式 / 参与分表 / 远程规则） */
function ScoringRulesCard({ detail }: { detail: ActivityDetailDto }) {
  const isContest = ['weekly_contest', 'monthly_contest', 'custom_contest'].includes(detail.type)
  const config = detail.scoringConfig as Record<string, unknown> | null
  const configEntries = config
    ? Object.entries(config).filter(([, value]) => value != null && typeof value !== 'object')
    : []
  const lambdaKey = typeof config?.lambdaKey === 'string' ? config.lambdaKey : null
  const lambdaLabel = lambdaKey === 'A' ? '甲类 λ=1.2' : lambdaKey === 'B' ? '乙类 λ=1.0' : lambdaKey === 'C' ? '丙类 λ=0.8' : null

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
            <CalculatorIcon className="size-4 text-primary" aria-hidden="true" />
            本次活动计分规则
          </h2>
          {detail.requireValidSubmission && (
            <span className="rounded-md bg-warning-subtle px-2 py-0.5 text-xs font-medium text-warning-foreground">
              需有效提交才发竞赛分
            </span>
          )}
        </div>

        {isContest ? (
          <div className="flex flex-col gap-3">
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="text-center font-mono text-sm text-foreground">
                W = B + λ × (4S + 6R) + X
              </p>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs leading-5">
                <dt className="text-muted-foreground">B 到场基础分</dt>
                <dd>线下到场 2（公告指定月赛 3）；远程 B=0</dd>
                <dt className="text-muted-foreground">λ 类别系数</dt>
                <dd>{lambdaLabel ?? '按赛前公告类别（甲 1.2 / 乙 1.0 / 丙 0.8）'}</dd>
                <dt className="text-muted-foreground">S 过题比例</dt>
                <dd>过题数/总题数（分数制为 得分/满分），上限 1</dd>
                <dt className="text-muted-foreground">R 社内名次分</dt>
                <dd>1−(名次−1)/(有效人数−1)；不足 3 人减半</dd>
                <dt className="text-muted-foreground">X 外部排名分</dt>
                <dd>前 5%→3 · 前 10%→2 · 前 30%→1 · 其余 0</dd>
              </dl>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              单场上限常规 20、公告特定场 ≤25；有效提交由引擎从平台榜单自动核验（AC/WA/TLE/MLE/RE/PE 任一提交即有效，仅编译错误或证据不足转人工窗口）；
              未提交只记出勤不发竞赛分。活动结束 5 分钟后自动结算入账（详情见「活动积分」卡）。
            </p>
            {detail.remoteAllowed && (
              <div className="rounded-xl border border-dashed border-border p-3 text-xs leading-5 text-muted-foreground">
                <span className="font-medium text-foreground">远程参赛：</span>
                W = 0.5 × [λ(4S+6R) + X]，上限为线下场的 50%，每自然月最多认定 1 次，须赛前申请获批；
                未批准而申报该场 0 分另扣 2。
                {detail.remotePolicy ? `（本活动远程规则：${detail.remotePolicy}）` : ''}
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs leading-5 text-muted-foreground">
            本活动按参与分计：必到活动准时完成 +2；迟到/早退超 15 分钟 +1（另扣 2/次，同场最多 −4）；
            超过半场到场/离场 0 分；宣讲/分享/复盘普通参会 +1.5。参与与服务类每月合计上限 12 分。
          </p>
        )}

        {configEntries.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-border/60 pt-2">
            <p className="text-xs font-medium text-foreground/80">活动公告的计分参数</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              {configEntries.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="text-foreground tabular-nums">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <p className="text-xs leading-5 text-muted-foreground">
          所有分数进入当月流水（保留精确小数），按类别月上限汇总后于月末四舍五入为整数 M；
          近六个月 M 按 1 / 0.85 / 0.7 / 0.55 / 0.4 / 0.25 加权为有效积分 E。
        </p>
      </CardContent>
    </Card>
  );
}

/** 活动积分卡：本次活动入账的积分（我的合计 + 明细 + 社团积分榜） */
function ActivityPointsCard({ detail }: { detail: ActivityDetailDto }) {
  const principal = usePrincipal();
  const points = detail.activityPoints;
  const settled = (points?.board.length ?? 0) > 0 || (points?.mine.length ?? 0) > 0;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
            <CoinsIcon className="size-4 text-primary" aria-hidden="true" />
            活动积分
          </h2>
          {settled && points && (
            <span className="text-xs text-muted-foreground tabular-nums">
              本活动共发放 {points.totalAwarded} 分 · {points.board.length} 人
            </span>
          )}
        </div>

        {!settled ? (
          <p className="text-sm leading-[22px] text-muted-foreground">
            {new Date(detail.endAt).getTime() <= Date.now()
              ? '本次活动积分尚未结算；负责人入账后此处会显示你的得分与明细。'
              : '活动结束后由负责人结算积分，届时在此展示。'}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-border bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">我的得分</p>
                <p className="mt-1 text-2xl font-semibold text-primary tabular-nums">
                  {points?.myTotal ?? 0}
                </p>
              </div>
              <div className="rounded-xl border border-border bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">积分明细</p>
                {points && points.mine.length > 0 ? (
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {points.mine.map((entry, index) => (
                      <li key={index} className="text-xs leading-5 text-muted-foreground">
                        <span className={`font-medium tabular-nums ${entry.amount >= 0 ? 'text-foreground' : 'text-destructive'}`}>
                          {entry.amount >= 0 ? '+' : ''}
                          {entry.amount}
                        </span>{' '}
                        {entry.scoreMonth} · {entry.note ?? detail.title}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-sm text-muted-foreground">本次活动没有你的积分记录。</p>
                )}
              </div>
            </div>

            {points && points.board.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-foreground">本次活动积分榜</h3>
                <ol className="flex flex-col divide-y divide-border rounded-xl border border-border">
                  {points.board.map((row) => (
                    <li
                      key={row.userId}
                      className={`flex items-center gap-3 px-3 py-2.5 text-sm ${row.userId === principal?.userId ? 'bg-info-subtle' : ''}`}
                    >
                      <span className="w-6 shrink-0 text-center font-semibold text-foreground tabular-nums">
                        {row.rank}
                      </span>
                      <MemberAvatar assetId={row.avatarAssetId} name={row.name} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        {row.name}
                        {row.userId === principal?.userId && (
                          <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-3 font-semibold text-primary-foreground">
                            我
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {row.count} 笔
                      </span>
                      <span className="w-14 shrink-0 text-right font-semibold text-foreground tabular-nums">
                        {row.total}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StandingsSection({
  activityId,
  ended,
  contestUrl,
}: {
  activityId: string;
  ended: boolean;
  contestUrl: string | null;
}) {
  const principal = usePrincipal();
  const principalId = principal?.principalId ?? null;
  const [expanded, setExpanded] = useState(false);

  const query = usePrivateQuery<StandingsDto, ApiError>(
    principalId,
    ['activities', 'standings', activityId],
    async () => (await api.get<StandingsDto>(`/activities/${activityId}/standings`)).data,
    {
      enabled: principalId != null && expanded,
      staleTime: 60_000,
      retry: false,
    },
  );

  const me = query.data?.me ?? null;
  const myCellsByIndex = new Map((me?.cells ?? []).map((cell) => [cell.index, cell]));

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
            <TrophyIcon className="size-4 text-primary" aria-hidden="true" />
            比赛成绩与社团排名
          </h2>
          <div className="flex items-center gap-2">
            {query.data && (
              <span className="text-xs text-muted-foreground tabular-nums">
                更新于 {formatDateTime(query.data.fetchedAt)}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={query.isFetching}
              onClick={() => {
                setExpanded(true);
                void query.refetch();
              }}
            >
              <RefreshCwIcon className={query.isFetching ? 'animate-spin' : ''} aria-hidden="true" />
              刷新
            </Button>
          </div>
        </div>

        {!expanded && query.isPending ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm leading-[22px] text-muted-foreground">
              {ended
                ? '比赛已结束：拉取平台榜单，查看你通过的题目、得分与社团内对题数排名。'
                : '查看当前平台实时榜单：我的过题、题目链接与社团内排名。'}
            </p>
            <Button size="sm" onClick={() => setExpanded(true)}>
              加载比赛成绩
            </Button>
          </div>
        ) : query.isError ? (
          <ErrorState description={query.error.message} onRetry={() => void query.refetch()} />
        ) : query.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </div>
        ) : query.data.available === false ? (
          <div className="flex flex-col items-start gap-3">
            <Alert>
              <AlertTitle>{query.data.processing ? '数据同步处理中' : '平台榜单暂不可用'}</AlertTitle>
              <AlertDescription>
                {query.data.reason}
                {query.data.processing ? '（约 5 分钟后自动完成，积分也将自动入账）' : ''}
              </AlertDescription>
            </Alert>
            {contestUrl && (
              <Button asChild size="sm" variant="outline">
                <a href={contestUrl} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon aria-hidden="true" />
                  前往官方榜单
                </a>
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* 我的成绩 */}
            {me ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-xl border border-border bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">社团排名</p>
                  <p className="mt-1 text-2xl font-semibold text-primary tabular-nums">
                    #{me.clubRank}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">通过题数</p>
                  <p className="mt-1 text-2xl font-semibold text-foreground tabular-nums">
                    {me.solvedCount}
                    <span className="ml-1 text-sm font-normal text-muted-foreground">
                      /{query.data.problems.length}
                    </span>
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">总得分</p>
                  <p className="mt-1 text-2xl font-semibold text-foreground tabular-nums">
                    {me.score}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">平台名次</p>
                  <p className="mt-1 text-2xl font-semibold text-foreground tabular-nums">
                    {me.platformRank != null ? `#${me.platformRank}` : '—'}
                  </p>
                </div>
              </div>
            ) : (
              <Alert>
                <AlertTitle>未在榜单中找到你的账号</AlertTitle>
                <AlertDescription>
                  榜单按平台账号绑定匹配（当前平台 handle）：{PLATFORM_BADGE[query.data.platform] ?? query.data.platform}
                  。请先在「竞赛」绑定平台账号，绑定审核通过后即可参加社团排名。
                </AlertDescription>
              </Alert>
            )}

            {/* 题目列表（含链接与我的通过状态） */}
            {query.data.problems.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  题目（{ended ? '最终' : '当前'}通过情况）
                </h3>
                <div className="flex flex-wrap gap-2">
                  {query.data.problems.map((problem) => {
                    const mine = myCellsByIndex.get(problem.index);
                    const solved = mine?.solved ?? false;
                    return (
                      <a
                        key={problem.index}
                        href={problem.url ?? contestUrl ?? '#'}
                        target={problem.url || contestUrl ? '_blank' : undefined}
                        rel="noreferrer"
                        title={`${problem.name ?? problem.index}${problem.fullScore != null ? ` · 满分 ${problem.fullScore}` : ''} · 社团通过 ${problem.clubSolved} 人`}
                        className={`flex min-w-16 flex-col items-center rounded-xl border px-3 py-2 transition-colors ${
                          solved
                            ? 'border-success-subtle bg-success-subtle/50 text-foreground'
                            : 'border-border bg-muted/40 text-muted-foreground hover:border-primary/50'
                        }`}
                      >
                        <span className="text-sm font-semibold">{problem.index}</span>
                        <span className="text-[11px] leading-4 tabular-nums">
                          {solved ? `✓ ${mine?.score ?? ''}` : mine ? `${mine.score}` : '—'}
                        </span>
                      </a>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  绿色为已通过（含得分）；点击题目跳转平台题目页。社团通过人数见悬停提示。
                </p>
              </div>
            )}

            {/* 社团对题数排名 */}
            <div className="flex flex-col gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <UsersIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                社团对题数排名（{query.data.clubRanking.length} 人 · 榜单共 {query.data.totalEntries} 人）
              </h3>
              {query.data.clubRanking.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  还没有社团成员出现在该榜单；绑定平台账号后自动参与排名。
                </p>
              ) : (
                <ol className="flex flex-col divide-y divide-border rounded-xl border border-border">
                  {query.data.clubRanking.map((row) => (
                    <li
                      key={row.userId}
                      className={`flex items-center gap-3 px-3 py-2.5 text-sm ${row.userId === principal?.userId ? 'bg-info-subtle' : ''}`}
                    >
                      <span className="w-8 shrink-0 text-center font-semibold text-foreground tabular-nums">
                        {row.clubRank}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        {row.name}
                        {row.userId === principal?.userId && (
                          <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-3 font-semibold text-primary-foreground">
                            我
                          </span>
                        )}
                      </span>
                      <span className="hidden truncate text-xs text-muted-foreground sm:block">
                        {row.displayName ?? row.handle}
                      </span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {row.solvedCount} 题
                      </span>
                      <span className="w-14 shrink-0 text-right font-medium text-foreground tabular-nums">
                        {row.score}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {query.data.note && (
              <p className="text-xs leading-5 text-muted-foreground">{query.data.note}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
