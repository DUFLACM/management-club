/**
 * 管理端 · 正式赛事（competitions.manage）。
 *
 * 赛事 CRUD / 发布 → A 类资格名单（E 或专项 Q 排序 + quota 截断，可个别调整）
 * → 报名与队伍审核（人工档位按附录二计分入账）→ 平台自动结算（W=λ(4S+6R)+X）
 * → 强制编组（均衡分组矩阵法）与名单 CSV 导出。
 * 下方保留附录一「指定比赛认定目录」管理。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CalculatorIcon,
  DownloadIcon,
  LoaderCircleIcon,
  PlusIcon,
  SendIcon,
  ShuffleIcon,
  UsersIcon,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrincipal } from '@/lib/session';
import { formatDateTime, memberName, memberAvatarId } from '@/lib/format';
import {
  competitionsAdminApi,
  contestTierLabel,
  eventStatusLabel,
  entryStatusLabel,
  awardFormKind,
  CONTEST_TIERS,
  LADDER_INDIVIDUAL_AWARDS,
  LADDER_TEAM_AWARDS,
  LAMBDA_LABELS,
  LANQIAO_AWARDS,
  MEDAL_LEVELS,
  type AdminCompetitionEventDto,
  type AdminRegistrationDto,
  type AdminShortlistRowDto,
  type AdminTeamEntryDto,
  type AwardFormKind,
  type CompetitionEventInput,
  type SettleResultDto,
} from '@/lib/competitions';
import { PanelHeader } from '@/components/club/PanelHeader';
import { PrincipalGate, QueryBoundary } from '@/components/club/QueryBoundary';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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

const STATUS_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'draft', label: '草稿' },
  { value: 'open', label: '开放报名' },
  { value: 'shortlisted', label: '已出资格名单' },
  { value: 'team_forming', label: '组队中' },
  { value: 'settled', label: '已结算' },
];

/** datetime-local 值 → ISO；空值返回 undefined */
function toIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function categoryBadge(category: string) {
  return category === 'A' ? 'info' : 'success';
}

export default function ContestsPanel() {
  const principal = usePrincipal();
  return (
    <PrincipalGate principal={principal}>
      {(principalId) => <ContestsBody principalId={principalId} />}
    </PrincipalGate>
  );
}

function ContestsBody({ principalId }: { principalId: string }) {
  const [statusFilter, setStatusFilter] = useState('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const listQuery = usePrivateQuery<AdminCompetitionEventDto[], ApiError>(
    principalId,
    ['admin', 'competition-events', statusFilter],
    () => competitionsAdminApi.listEvents(statusFilter),
  );

  const selected = listQuery.data?.find((event) => event.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="正式赛事"
        description="报名与名额分配、资格名单、组队与结算；A 类占用学校配额，B 类纳入积分认定。"
        actions={
          <Button onClick={() => setCreateOpen((previous) => !previous)}>
            <PlusIcon aria-hidden="true" />
            {createOpen ? '收起表单' : '创建赛事'}
          </Button>
        }
      />

      {createOpen && (
        <CreateEventForm
          principalId={principalId}
          onClose={() => setCreateOpen(false)}
          onCreated={(eventId) => {
            setCreateOpen(false);
            setSelectedId(eventId);
          }}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-9 w-40" aria-label="按状态筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <QueryBoundary
        query={listQuery}
        isEmpty={(list) => list.length === 0}
        emptyNode={
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              暂无正式赛事；点击「创建赛事」发布报名公告。
            </CardContent>
          </Card>
        }
      >
        {(list) => (
          <Card>
            <CardContent className="p-0 pb-2">
              <ul className="flex flex-col divide-y divide-border">
                {list.map((event) => (
                  <li key={event.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(event.id === selectedId ? null : event.id)}
                      aria-expanded={event.id === selectedId}
                      className="flex w-full flex-wrap items-center justify-between gap-2 p-4 text-left hover:bg-muted/40"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge variant={categoryBadge(event.category)}>{event.category} 类</Badge>
                          <span className="text-sm font-medium text-foreground">{event.title}</span>
                          {event.teamSize && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                              {event.teamSize} 人团队赛
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
                          报名截止 {formatDateTime(event.registerDeadline)} ·{' '}
                          {event.scoringMode === 'platform_auto'
                            ? `平台自动积分（${LAMBDA_LABELS[event.lambdaKey ?? 'B']}）`
                            : `人工审核 · ${contestTierLabel(event.contestTier)}`}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {event.teamSize
                            ? `${event._count.teamEntries} 队`
                            : `${event._count.registrations} 人`}
                        </span>
                        <Badge variant={event.status === 'settled' ? 'success' : 'neutral'}>
                          {eventStatusLabel(event.status)}
                        </Badge>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </QueryBoundary>

      {selected && <EventDetail principalId={principalId} event={selected} />}

      <DesignatedCatalogSection principalId={principalId} />
    </div>
  );
}

function CreateEventForm({
  principalId,
  onClose,
  onCreated,
}: {
  principalId: string;
  onClose: () => void;
  onCreated: (eventId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    title: '',
    category: 'B' as 'A' | 'B',
    isTeam: false,
    teamSize: '3',
    scoringMode: 'platform_auto' as 'platform_auto' | 'manual_review',
    platform: 'nowcoder',
    platformContestId: '',
    contestTier: 'provincial',
    lambdaKey: 'B',
    announcement: '',
    registerDeadline: '',
    startAt: '',
    endAt: '',
    quota: '',
    basedOn: 'currentE' as 'currentE' | 'specialQ',
    specialWeight: '0.3',
    freezeAt: '',
    teamFormDeadline: '',
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const registerDeadline = toIso(form.registerDeadline);
      const startAt = toIso(form.startAt);
      const endAt = toIso(form.endAt);
      if (!registerDeadline || !startAt || !endAt) {
        throw new ApiError('INVALID_INPUT', '请完整填写报名截止、开始与结束时间。');
      }
      const body: CompetitionEventInput = {
        title: form.title.trim(),
        category: form.category,
        teamSize: form.isTeam ? Number(form.teamSize) : null,
        scoringMode: form.scoringMode,
        announcement: form.announcement.trim(),
        registerDeadline,
        startAt,
        endAt,
      };
      if (form.scoringMode === 'platform_auto') {
        body.platform = form.platform;
        body.platformContestId = form.platformContestId.trim();
        body.lambdaKey = form.lambdaKey;
      } else {
        body.contestTier = form.contestTier;
      }
      if (form.category === 'A') {
        if (form.quota.trim()) body.quota = Number(form.quota);
        body.qualificationRule = {
          basedOn: form.basedOn,
          ...(form.basedOn === 'specialQ' ? { specialWeight: Number(form.specialWeight) } : {}),
        };
        const freezeAt = toIso(form.freezeAt);
        if (freezeAt) body.freezeAt = freezeAt;
      }
      if (form.isTeam) {
        const teamFormDeadline = toIso(form.teamFormDeadline);
        if (teamFormDeadline) body.teamFormDeadline = teamFormDeadline;
      }
      return competitionsAdminApi.createEvent(body);
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: ['principal', principalId, 'admin', 'competition-events'],
      });
      onCreated(result.eventId);
    },
  });

  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">创建正式赛事</h2>
          <Button size="sm" variant="ghost" onClick={onClose}>
            收起
          </Button>
        </div>
        {mutation.isError && (
          <Alert variant="destructive">
            <AlertTitle>创建失败</AlertTitle>
            <AlertDescription>{(mutation.error as ApiError).message}</AlertDescription>
          </Alert>
        )}
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="event-title">赛事名称（2-160 字）</Label>
              <Input
                id="event-title"
                value={form.title}
                onChange={(e) => update('title', e.target.value)}
                required
                minLength={2}
                maxLength={160}
                placeholder="如：2026 ICPC 亚洲区域赛（沈阳站）"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="event-category">分类</Label>
              <Select
                value={form.category}
                onValueChange={(value) => update('category', value as 'A' | 'B')}
              >
                <SelectTrigger id="event-category" aria-label="分类">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="A">A 类 · 学校配额统一管理</SelectItem>
                  <SelectItem value="B">B 类 · 纳入积分认定</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="event-scoring">积分方式</Label>
              <Select
                value={form.scoringMode}
                onValueChange={(value) =>
                  update('scoringMode', value as 'platform_auto' | 'manual_review')
                }
              >
                <SelectTrigger id="event-scoring" aria-label="积分方式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="platform_auto">平台自动结算</SelectItem>
                  <SelectItem value="manual_review">人工审核档位</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {form.scoringMode === 'platform_auto' ? (
            <div className="grid gap-3 rounded-xl border border-dashed border-border p-3 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="event-platform">平台</Label>
                <Select value={form.platform} onValueChange={(value) => update('platform', value)}>
                  <SelectTrigger id="event-platform" aria-label="平台">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="nowcoder">牛客</SelectItem>
                    <SelectItem value="codeforces">Codeforces</SelectItem>
                    <SelectItem value="atcoder">AtCoder</SelectItem>
                    <SelectItem value="hydro">校内 OJ</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="event-contest-id">平台赛事 ID</Label>
                <Input
                  id="event-contest-id"
                  value={form.platformContestId}
                  onChange={(e) => update('platformContestId', e.target.value)}
                  required
                  maxLength={64}
                  placeholder="如 140235 / abc472"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="event-lambda">λ 档位</Label>
                <Select value={form.lambdaKey} onValueChange={(value) => update('lambdaKey', value)}>
                  <SelectTrigger id="event-lambda" aria-label="λ 档位">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A">甲 1.2</SelectItem>
                    <SelectItem value="B">乙 1.0</SelectItem>
                    <SelectItem value="C">丙 0.8</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs leading-5 text-muted-foreground sm:col-span-3">
                结算公式 W = λ(4S + 6R) + X，上限 20；正式赛事非社团线下活动，不含到场基础分 B。
                比赛结束 5 分钟后可结算，调度器也会自动尝试。
              </p>
            </div>
          ) : (
            <div className="grid gap-3 rounded-xl border border-dashed border-border p-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="event-tier">积分档位（附录二）</Label>
                <Select
                  value={form.contestTier}
                  onValueChange={(value) => update('contestTier', value)}
                >
                  <SelectTrigger id="event-tier" aria-label="积分档位">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONTEST_TIERS.map((tier) => (
                      <SelectItem key={tier.value} value={tier.value}>
                        {tier.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="self-end text-xs leading-5 text-muted-foreground">
                审核通过时按档位与奖项档次计分并直接入账成员账本。
              </p>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="event-register-deadline">报名截止</Label>
              <Input
                id="event-register-deadline"
                type="datetime-local"
                value={form.registerDeadline}
                onChange={(e) => update('registerDeadline', e.target.value)}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="event-start">赛事开始</Label>
              <Input
                id="event-start"
                type="datetime-local"
                value={form.startAt}
                onChange={(e) => update('startAt', e.target.value)}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="event-end">赛事结束</Label>
              <Input
                id="event-end"
                type="datetime-local"
                value={form.endAt}
                onChange={(e) => update('endAt', e.target.value)}
                required
              />
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-3">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox
                checked={form.isTeam}
                onCheckedChange={(checked) => update('isTeam', checked === true)}
              />
              团队赛（固定人数，经组队广场报名）
            </label>
            {form.isTeam && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="event-team-size">每队人数（2-10）</Label>
                  <Input
                    id="event-team-size"
                    type="number"
                    min={2}
                    max={10}
                    value={form.teamSize}
                    onChange={(e) => update('teamSize', e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="event-team-deadline">自主组队截止（可选）</Label>
                  <Input
                    id="event-team-deadline"
                    type="datetime-local"
                    value={form.teamFormDeadline}
                    onChange={(e) => update('teamFormDeadline', e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    留空默认报名截止后 3 天；逾期未成队可强制编组。
                  </p>
                </div>
              </div>
            )}
          </div>

          {form.category === 'A' && (
            <div className="grid gap-3 rounded-xl border border-dashed border-border p-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="grid gap-1.5">
                <Label htmlFor="event-quota">学校配额（可选）</Label>
                <Input
                  id="event-quota"
                  type="number"
                  min={1}
                  max={500}
                  value={form.quota}
                  onChange={(e) => update('quota', e.target.value)}
                  placeholder="留空为不限"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="event-based-on">资格排序口径</Label>
                <Select
                  value={form.basedOn}
                  onValueChange={(value) => update('basedOn', value as 'currentE' | 'specialQ')}
                >
                  <SelectTrigger id="event-based-on" aria-label="资格排序口径">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="currentE">有效积分 E</SelectItem>
                    <SelectItem value="specialQ">专项选拔 Q</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.basedOn === 'specialQ' && (
                <div className="grid gap-1.5">
                  <Label htmlFor="event-special-weight">专项权重（0.3-0.5）</Label>
                  <Input
                    id="event-special-weight"
                    type="number"
                    step="0.05"
                    min={0.3}
                    max={0.5}
                    value={form.specialWeight}
                    onChange={(e) => update('specialWeight', e.target.value)}
                  />
                </div>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="event-freeze">积分冻结时点（可选）</Label>
                <Input
                  id="event-freeze"
                  type="datetime-local"
                  value={form.freezeAt}
                  onChange={(e) => update('freezeAt', e.target.value)}
                />
                <p className="text-xs text-muted-foreground">留空默认报名截止前一日 22:00。</p>
              </div>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="event-announcement">报名公告（5-20000 字）</Label>
            <Textarea
              id="event-announcement"
              value={form.announcement}
              onChange={(e) => update('announcement', e.target.value)}
              required
              minLength={5}
              maxLength={20000}
              rows={5}
              placeholder="赛事时间地点、报名条件、所需材料、组队要求与注意事项"
            />
          </div>

          <Button
            type="submit"
            className="w-fit"
            disabled={
              mutation.isPending || form.title.trim().length < 2 || form.announcement.trim().length < 5
            }
          >
            {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            保存为草稿
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function EventDetail({
  principalId,
  event,
}: {
  principalId: string;
  event: AdminCompetitionEventDto;
}) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [settleResult, setSettleResult] = useState<SettleResultDto | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ['principal', principalId, 'admin', 'competition-events'],
    });
  };

  const publishMutation = useMutation({
    mutationFn: () => competitionsAdminApi.publish(event.id),
    onSuccess: () => {
      setNotice({ tone: 'info', text: '赛事已发布，成员端可见并开放报名。' });
      invalidate();
    },
    onError: (error: ApiError) => setNotice({ tone: 'error', text: error.message }),
  });

  const shortlistMutation = useMutation({
    mutationFn: () => competitionsAdminApi.buildShortlist(event.id),
    onSuccess: (result) => {
      setNotice({
        tone: 'info',
        text: `资格名单已生成：候选 ${result.total} 人，入围 ${result.shortlisted} 人。`,
      });
      invalidate();
    },
    onError: (error: ApiError) => setNotice({ tone: 'error', text: error.message }),
  });

  const forceAssignMutation = useMutation({
    mutationFn: () => competitionsAdminApi.forceTeamAssignment(event.id),
    onSuccess: (result) => {
      setNotice({
        tone: 'info',
        text: `强制编组完成：新建 ${result.teamsCreated} 队，余 ${result.remainder} 人待人工处理。`,
      });
      invalidate();
    },
    onError: (error: ApiError) => setNotice({ tone: 'error', text: error.message }),
  });

  const settleMutation = useMutation({
    mutationFn: () => competitionsAdminApi.settle(event.id),
    onSuccess: (result) => {
      setSettleResult(result);
      setNotice({
        tone: 'info',
        text: `结算完成：入账 ${result.posted} 条，去重 ${result.deduplicated} 条，跳过 ${result.skipped.length} 个对象。`,
      });
      invalidate();
    },
    onError: (error: ApiError) => {
      setSettleResult(null);
      setNotice({ tone: 'error', text: error.message });
    },
  });

  const anyPending =
    publishMutation.isPending ||
    shortlistMutation.isPending ||
    forceAssignMutation.isPending ||
    settleMutation.isPending;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
              {event.title}
              <Badge variant={categoryBadge(event.category)}>{event.category} 类</Badge>
              <Badge variant={event.status === 'settled' ? 'success' : 'neutral'}>
                {eventStatusLabel(event.status)}
              </Badge>
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground tabular-nums">
              赛期 {formatDateTime(event.startAt)} — {formatDateTime(event.endAt)}
              {event.freezeAt && ` · 冻结时点 ${formatDateTime(event.freezeAt)}`}
              {event.quota != null && ` · 配额 ${event.quota}`}
              {event.teamFormDeadline && ` · 组队截止 ${formatDateTime(event.teamFormDeadline)}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {event.status === 'draft' && (
              <Button size="sm" disabled={anyPending} onClick={() => publishMutation.mutate()}>
                {publishMutation.isPending ? (
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                ) : (
                  <SendIcon aria-hidden="true" />
                )}
                发布
              </Button>
            )}
            {event.category === 'A' && (
              <Button
                size="sm"
                variant="outline"
                disabled={anyPending}
                onClick={() => shortlistMutation.mutate()}
              >
                {shortlistMutation.isPending ? (
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                ) : (
                  <UsersIcon aria-hidden="true" />
                )}
                生成资格名单
              </Button>
            )}
            {event.teamSize != null && (
              <Button
                size="sm"
                variant="outline"
                disabled={anyPending}
                onClick={() => forceAssignMutation.mutate()}
              >
                {forceAssignMutation.isPending ? (
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                ) : (
                  <ShuffleIcon aria-hidden="true" />
                )}
                强制编组
              </Button>
            )}
            {event.scoringMode === 'platform_auto' && (
              <Button
                size="sm"
                variant="outline"
                disabled={anyPending}
                onClick={() => settleMutation.mutate()}
              >
                {settleMutation.isPending ? (
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                ) : (
                  <CalculatorIcon aria-hidden="true" />
                )}
                平台结算
              </Button>
            )}
            <Button size="sm" variant="outline" asChild>
              <a href={competitionsAdminApi.exportUrl(event.id)} download>
                <DownloadIcon aria-hidden="true" />
                导出名单
              </a>
            </Button>
          </div>
        </div>

        {notice && (
          <Alert variant={notice.tone === 'error' ? 'destructive' : 'info'}>
            <AlertTitle>{notice.tone === 'error' ? '操作未完成' : '已完成'}</AlertTitle>
            <AlertDescription>{notice.text}</AlertDescription>
          </Alert>
        )}

        {settleResult && settleResult.skipped.length > 0 && (
          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <p className="text-xs font-medium text-foreground">未能入账的对象</p>
            <ul className="mt-1 flex flex-col gap-1">
              {settleResult.skipped.map((row) => (
                <li key={row.name} className="text-xs text-muted-foreground">
                  {row.name}：{row.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Tabs defaultValue="registrations">
          <TabsList aria-label="赛事管理子页">
            <TabsTrigger value="registrations">
              {event.teamSize ? '队伍报名' : '报名名单'}
            </TabsTrigger>
            {event.category === 'A' && <TabsTrigger value="shortlist">资格名单</TabsTrigger>}
            <TabsTrigger value="announcement">公告</TabsTrigger>
          </TabsList>
          <TabsContent value="registrations" className="mt-4">
            {event.teamSize != null ? (
              <TeamEntriesSection principalId={principalId} event={event} />
            ) : (
              <RegistrationsSection principalId={principalId} event={event} />
            )}
          </TabsContent>
          {event.category === 'A' && (
            <TabsContent value="shortlist" className="mt-4">
              <ShortlistSection principalId={principalId} event={event} />
            </TabsContent>
          )}
          <TabsContent value="announcement" className="mt-4">
            <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">
              {event.announcement}
            </p>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function RegistrationsSection({
  principalId,
  event,
}: {
  principalId: string;
  event: AdminCompetitionEventDto;
}) {
  const queryClient = useQueryClient();
  const [reviewing, setReviewing] = useState<AdminRegistrationDto | null>(null);

  const query = usePrivateQuery<AdminRegistrationDto[], ApiError>(
    principalId,
    ['admin', 'competition-registrations', event.id],
    () => competitionsAdminApi.registrations(event.id),
  );

  return (
    <>
      <QueryBoundary
        query={query}
        skeleton={<Skeleton className="h-24 rounded-xl" />}
        isEmpty={(rows) => rows.length === 0}
        emptyNode={
          <p className="py-6 text-center text-sm text-muted-foreground">暂无报名记录。</p>
        }
      >
        {(rows) => (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>成员</TableHead>
                  <TableHead>报名时间</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>材料</TableHead>
                  <TableHead className="text-right">积分</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <span className="flex items-center gap-2 text-sm text-foreground">
                        <MemberAvatar assetId={memberAvatarId(row.user)} name={memberName(row.user)} size="xs" />
                        {memberName(row.user)}
                      </span>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {row.user.studentNo}
                      </span>
                      {row.note && (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          备注：{row.note}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {formatDateTime(row.registeredAt)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          row.status === 'approved' || row.status === 'confirmed'
                            ? 'success'
                            : row.status === 'rejected'
                              ? 'destructive'
                              : 'neutral'
                        }
                      >
                        {entryStatusLabel(row.status)}
                      </Badge>
                      {row.reviewNote && (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {row.reviewNote}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.materials.length === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <ul className="flex flex-col gap-0.5">
                          {row.materials.map((material) => (
                            <li key={material.id}>
                              <a
                                className="text-xs text-primary underline-offset-2 hover:underline"
                                href={competitionsAdminApi.registrationMaterialUrl(row.id, material.id)}
                                download
                              >
                                {material.title}
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.resultScore ?? '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      {event.scoringMode === 'manual_review' ? (
                        <Button size="sm" variant="outline" onClick={() => setReviewing(row)}>
                          审核
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">平台自动</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </QueryBoundary>

      {reviewing && (
        <ReviewForm
          heading={memberName(reviewing.user)}
          tier={event.contestTier}
          onClose={() => setReviewing(null)}
          onSubmit={async (input) => {
            await competitionsAdminApi.reviewRegistration(reviewing.id, input);
            void queryClient.invalidateQueries({
              queryKey: ['principal', principalId, 'admin', 'competition-registrations', event.id],
            });
            void queryClient.invalidateQueries({
              queryKey: ['principal', principalId, 'admin', 'competition-events'],
            });
          }}
        />
      )}
    </>
  );
}

/**
 * 人工审核的奖项录入字段：按档位分支，仅暴露后端 award-score 接受的枚举值。
 * 返回 fields 与 build()，供个人报名与队伍报名两处审核共用。
 */
function useAwardFields(kind: AwardFormKind) {
  const [medal, setMedal] = useState('none');
  const [participated, setParticipated] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [rank, setRank] = useState('');
  const [rankTotal, setRankTotal] = useState('');
  const [teamAwards, setTeamAwards] = useState<string[]>([]);
  const [individual, setIndividual] = useState('none');
  const [lanqiaoGroup, setLanqiaoGroup] = useState('B');
  const [lanqiaoAwards, setLanqiaoAwards] = useState<string[]>([]);
  const [preliminary, setPreliminary] = useState('none');
  const [final, setFinal] = useState('none');

  const toggle = (list: string[], set: (next: string[]) => void, value: string) => {
    set(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  };

  const build = (): Record<string, unknown> => {
    switch (kind) {
      case 'network_qualifier':
        return {
          participatedWithSubmission: participated,
          advanced,
          rankAmongAdvanced:
            advanced && rank && rankTotal
              ? { rank: Number(rank), total: Number(rankTotal) }
              : null,
        };
      case 'ladder':
        return { teamAwards, individual: individual === 'none' ? null : individual };
      case 'lanqiao':
        return { group: lanqiaoGroup, awards: lanqiaoAwards };
      case 'baidu_star':
        return {
          preliminary: preliminary === 'none' ? null : preliminary,
          final: final === 'none' ? null : final,
        };
      default:
        return { medal: medal === 'none' ? null : medal };
    }
  };

  const fields = (
    <>
      {kind === 'medal' && (
        <div className="grid gap-1.5 sm:max-w-xs">
          <Label htmlFor="review-medal">奖项档次</Label>
          <Select value={medal} onValueChange={setMedal}>
            <SelectTrigger id="review-medal" aria-label="奖项档次">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">无奖项（按参与分）</SelectItem>
              {MEDAL_LEVELS.map((level) => (
                <SelectItem key={level.value} value={level.value}>
                  {level.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {kind === 'network_qualifier' && (
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Checkbox
              checked={participated}
              onCheckedChange={(checked) => setParticipated(checked === true)}
            />
            有效参赛（存在有效提交）
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Checkbox
              checked={advanced}
              onCheckedChange={(checked) => setAdvanced(checked === true)}
            />
            已晋级
          </label>
          {advanced && (
            <div className="grid gap-3 sm:max-w-sm sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="review-rank">晋级内名次</Label>
                <Input
                  id="review-rank"
                  type="number"
                  min={1}
                  value={rank}
                  onChange={(e) => setRank(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="review-rank-total">晋级总队数</Label>
                <Input
                  id="review-rank-total"
                  type="number"
                  min={1}
                  value={rankTotal}
                  onChange={(e) => setRankTotal(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {kind === 'ladder' && (
        <div className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-foreground">团队奖项（可多选，取最高）</legend>
            <div className="flex flex-wrap gap-3">
              {LADDER_TEAM_AWARDS.map((award) => (
                <label key={award.value} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={teamAwards.includes(award.value)}
                    onCheckedChange={() => toggle(teamAwards, setTeamAwards, award.value)}
                  />
                  {award.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-1.5 sm:max-w-xs">
            <Label htmlFor="review-individual">个人奖项</Label>
            <Select value={individual} onValueChange={setIndividual}>
              <SelectTrigger id="review-individual" aria-label="个人奖项">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">无</SelectItem>
                {LADDER_INDIVIDUAL_AWARDS.map((award) => (
                  <SelectItem key={award.value} value={award.value}>
                    {award.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {kind === 'lanqiao' && (
        <div className="flex flex-col gap-3">
          <div className="grid gap-1.5 sm:max-w-xs">
            <Label htmlFor="review-group">组别</Label>
            <Select value={lanqiaoGroup} onValueChange={setLanqiaoGroup}>
              <SelectTrigger id="review-group" aria-label="组别">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="A">A 组</SelectItem>
                <SelectItem value="B">B 组</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-foreground">奖项（可多选，取最高）</legend>
            <div className="flex flex-wrap gap-3">
              {LANQIAO_AWARDS.map((award) => (
                <label key={award.value} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={lanqiaoAwards.includes(award.value)}
                    onCheckedChange={() => toggle(lanqiaoAwards, setLanqiaoAwards, award.value)}
                  />
                  {award.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}

      {kind === 'baidu_star' && (
        <div className="grid gap-3 sm:max-w-md sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="review-preliminary">初赛</Label>
            <Select value={preliminary} onValueChange={setPreliminary}>
              <SelectTrigger id="review-preliminary" aria-label="初赛">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">无</SelectItem>
                <SelectItem value="bronze">铜（40）</SelectItem>
                <SelectItem value="silver">银（60）</SelectItem>
                <SelectItem value="gold">金（90）</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="review-final">决赛</Label>
            <Select value={final} onValueChange={setFinal}>
              <SelectTrigger id="review-final" aria-label="决赛">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">无</SelectItem>
                <SelectItem value="bronze">铜（110）</SelectItem>
                <SelectItem value="silver">银（145）</SelectItem>
                <SelectItem value="gold">金（200）</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </>
  );

  return { fields, build };
}

/** 人工审核：按档位录入奖项后由后端 award-score 纯函数计分并入账 */
function ReviewForm({
  heading,
  tier,
  onSubmit,
  onClose,
}: {
  heading: string;
  tier: string | null;
  onSubmit: (input: {
    decision: 'approve' | 'reject';
    note?: string;
    award?: Record<string, unknown>;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const { fields, build } = useAwardFields(awardFormKind(tier));
  const [note, setNote] = useState('');

  const mutation = useMutation({
    mutationFn: async (decision: 'approve' | 'reject') => {
      await onSubmit({
        decision,
        note: note.trim() || undefined,
        ...(decision === 'approve' ? { award: build() } : {}),
      });
    },
    onSuccess: onClose,
  });

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-xl border border-border bg-muted/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">
          审核 · {heading}（{contestTierLabel(tier)}）
        </h3>
        <Button size="sm" variant="ghost" onClick={onClose}>
          收起
        </Button>
      </div>

      {mutation.isError && (
        <Alert variant="destructive">
          <AlertTitle>审核未完成</AlertTitle>
          <AlertDescription>{(mutation.error as ApiError).message}</AlertDescription>
        </Alert>
      )}

      {fields}

      <div className="grid gap-1.5">
        <Label htmlFor="review-note">审核意见（驳回时作为原因展示给成员）</Label>
        <Textarea
          id="review-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          rows={2}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate('approve')}>
          {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
          通过并入账
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-destructive hover:text-destructive"
          disabled={mutation.isPending || note.trim().length === 0}
          onClick={() => mutation.mutate('reject')}
        >
          驳回
        </Button>
        {note.trim().length === 0 && (
          <span className="text-xs text-muted-foreground">驳回需填写原因。</span>
        )}
      </div>
    </div>
  );
}

/** 团队赛以队为单位审核；通过时为每名在队成员分别入账同一档位分值 */
function TeamEntriesSection({
  principalId,
  event,
}: {
  principalId: string;
  event: AdminCompetitionEventDto;
}) {
  const queryClient = useQueryClient();
  const [reviewing, setReviewing] = useState<AdminTeamEntryDto | null>(null);

  const query = usePrivateQuery<AdminTeamEntryDto[], ApiError>(
    principalId,
    ['admin', 'competition-team-entries', event.id],
    () => competitionsAdminApi.teamEntries(event.id),
  );

  return (
    <>
      <QueryBoundary
        query={query}
        skeleton={<Skeleton className="h-24 rounded-xl" />}
        isEmpty={(rows) => rows.length === 0}
        emptyNode={
          <p className="py-6 text-center text-sm text-muted-foreground">
            暂无队伍报名；成员在「竞赛 → 组队广场」建队后提交。
          </p>
        }
      >
        {(rows) => (
          <ul className="flex flex-col gap-3">
            {rows.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-2 rounded-xl border border-border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{entry.team.name}</span>
                    <Badge
                      variant={
                        entry.status === 'approved' || entry.status === 'confirmed'
                          ? 'success'
                          : entry.status === 'rejected'
                            ? 'destructive'
                            : 'neutral'
                      }
                    >
                      {entryStatusLabel(entry.status)}
                    </Badge>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {entry.team.members.length}/{entry.team.teamSize} 人 ·{' '}
                      {formatDateTime(entry.registeredAt)}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {entry.resultScore && (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        每人 {entry.resultScore} 分
                      </span>
                    )}
                    {event.scoringMode === 'manual_review' ? (
                      <Button size="sm" variant="outline" onClick={() => setReviewing(entry)}>
                        审核
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">平台自动</span>
                    )}
                  </span>
                </div>
                <ul className="flex flex-wrap gap-x-4 gap-y-1">
                  {entry.team.members.map((member) => (
                    <li key={member.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <MemberAvatar assetId={memberAvatarId(member.user)} name={memberName(member.user)} size="xs" />
                      {memberName(member.user)}
                      <span className="ml-1 font-mono">{member.user.studentNo}</span>
                      {member.role === 'captain' && (
                        <span className="ml-1 text-primary">队长</span>
                      )}
                    </li>
                  ))}
                </ul>
                {entry.materials.length > 0 && (
                  <ul className="flex flex-wrap gap-3">
                    {entry.materials.map((material) => (
                      <li key={material.id}>
                        <a
                          className="text-xs text-primary underline-offset-2 hover:underline"
                          href={competitionsAdminApi.teamMaterialUrl(entry.id, material.id)}
                          download
                        >
                          {material.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
                {entry.reviewNote && (
                  <p className="text-xs text-muted-foreground">审核意见：{entry.reviewNote}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>

      {reviewing && (
        <ReviewForm
          heading={reviewing.team.name}
          tier={event.contestTier}
          onClose={() => setReviewing(null)}
          onSubmit={async (input) => {
            await competitionsAdminApi.reviewTeamEntry(reviewing.id, input);
            void queryClient.invalidateQueries({
              queryKey: ['principal', principalId, 'admin', 'competition-team-entries', event.id],
            });
            void queryClient.invalidateQueries({
              queryKey: ['principal', principalId, 'admin', 'competition-events'],
            });
          }}
        />
      )}
    </>
  );
}

function ShortlistSection({
  principalId,
  event,
}: {
  principalId: string;
  event: AdminCompetitionEventDto;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [qScoreDraft, setQScoreDraft] = useState('');

  const query = usePrivateQuery<AdminShortlistRowDto[], ApiError>(
    principalId,
    ['admin', 'competition-shortlist', event.id],
    () => competitionsAdminApi.shortlist(event.id),
  );

  const overrideMutation = useMutation({
    mutationFn: async (input: { userId: string; qScore?: number | null; eligible?: boolean }) => {
      await competitionsAdminApi.overrideShortlist(event.id, input.userId, {
        ...(input.qScore !== undefined ? { qScore: input.qScore } : {}),
        ...(input.eligible !== undefined ? { eligible: input.eligible } : {}),
      });
    },
    onSuccess: () => {
      setError(null);
      setEditing(null);
      void queryClient.invalidateQueries({
        queryKey: ['principal', principalId, 'admin', 'competition-shortlist', event.id],
      });
    },
    onError: (cause: ApiError) => setError(cause.message),
  });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-5 text-muted-foreground">
        按积分冻结时点的有效积分 E（或专项选拔 Q）排序，配额 {event.quota ?? '不限'} 以内为入围。
        个别调整 Q 分或出场资格后会自动重新排序并重新截断。
      </p>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <QueryBoundary
        query={query}
        skeleton={<Skeleton className="h-24 rounded-xl" />}
        isEmpty={(rows) => rows.length === 0}
        emptyNode={
          <p className="py-6 text-center text-sm text-muted-foreground">
            尚未生成资格名单；点击上方「生成资格名单」。
          </p>
        }
      >
        {(rows) => (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">名次</TableHead>
                  <TableHead>成员</TableHead>
                  <TableHead className="text-right">E 快照</TableHead>
                  <TableHead className="text-right">Q 分</TableHead>
                  <TableHead>资格</TableHead>
                  <TableHead>入围</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} className={row.shortlisted ? undefined : 'opacity-60'}>
                    <TableCell className="tabular-nums">{row.position}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2 text-sm text-foreground">
                        <MemberAvatar assetId={memberAvatarId(row.user)} name={memberName(row.user)} size="xs" />
                        {memberName(row.user)}
                      </span>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {row.user.studentNo}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.eSnapshot}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {editing === row.userId ? (
                        <Input
                          className="h-8 w-24 text-right"
                          type="number"
                          step="0.0001"
                          value={qScoreDraft}
                          onChange={(e) => setQScoreDraft(e.target.value)}
                          aria-label="Q 分"
                        />
                      ) : (
                        (row.qScore ?? '—')
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.eligible ? 'success' : 'neutral'}>
                        {row.eligible ? '具备' : '不具备'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.shortlisted ? 'info' : 'neutral'}>
                        {row.shortlisted ? '已入围' : '未入围'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {editing === row.userId ? (
                          <>
                            <Button
                              size="sm"
                              disabled={overrideMutation.isPending}
                              onClick={() =>
                                overrideMutation.mutate({
                                  userId: row.userId,
                                  qScore: qScoreDraft.trim() === '' ? null : Number(qScoreDraft),
                                })
                              }
                            >
                              保存
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                              取消
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setEditing(row.userId);
                                setQScoreDraft(row.qScore ?? '');
                              }}
                            >
                              改 Q 分
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={overrideMutation.isPending}
                              onClick={() =>
                                overrideMutation.mutate({
                                  userId: row.userId,
                                  eligible: !row.eligible,
                                })
                              }
                            >
                              {row.eligible ? '取消资格' : '恢复资格'}
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}

interface DesignatedRowDto {
  id: string;
  category: string;
  groupName: string;
  name: string;
  platform: string | null;
  lambdaKey: string | null;
  note: string | null;
  evidenceRef: string | null;
}

/** 指定目录管理：增删条目；λ 档位供结算引擎匹配（公告未设 λ 时按目录取） */
function DesignatedCatalogSection({ principalId }: { principalId: string }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    category: 'B',
    groupName: '平台型公开训练赛事',
    name: '',
    platform: 'nowcoder',
    lambdaKey: 'B',
  });
  const [error, setError] = useState<string | null>(null);

  const query = usePrivateQuery<DesignatedRowDto[], ApiError>(
    principalId,
    ['admin', 'designated-contests'],
    async () => (await api.get<DesignatedRowDto[]>('/admin/platform/designated-contests')).data,
    { retry: false },
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ['principal', principalId, 'admin', 'designated-contests'],
    });
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      await api.post('/admin/platform/designated-contests', {
        category: form.category,
        groupName: form.groupName.trim() || '未分组',
        name: form.name.trim(),
        ...(form.platform !== 'other' ? { platform: form.platform } : {}),
        lambdaKey: form.lambdaKey,
      });
    },
    onSuccess: () => {
      setError(null);
      setForm((previous) => ({ ...previous, name: '' }));
      setAdding(false);
      invalidate();
    },
    onError: (cause: ApiError) => setError(cause.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/admin/platform/designated-contests/${id}`);
    },
    onSuccess: invalidate,
    onError: (cause: ApiError) => setError(cause.message),
  });

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">指定比赛认定目录</h2>
          <Button size="sm" variant="outline" onClick={() => setAdding((previous) => !previous)}>
            {adding ? '收起' : '新增条目'}
          </Button>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          附录一 A/B/C 目录：λ 档位供结算引擎匹配（活动公告未设 λ 时按目录名称匹配平台与标题）；
          成员端「竞赛 → 指定与备案」同步展示。调整目录至少提前 3 日公示（R13）。
        </p>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {adding && (
          <form
            className="flex flex-col gap-2 rounded-xl border border-dashed border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (form.name.trim().length >= 2) createMutation.mutate();
            }}
          >
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="designated-category">分类</Label>
                <Select
                  value={form.category}
                  onValueChange={(value) => setForm((p) => ({ ...p, category: value }))}
                >
                  <SelectTrigger id="designated-category" aria-label="分类">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A">A 学校配额</SelectItem>
                    <SelectItem value="B">B 积分认定</SelectItem>
                    <SelectItem value="C">C 不认定</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="designated-platform">平台</Label>
                <Select
                  value={form.platform}
                  onValueChange={(value) => setForm((p) => ({ ...p, platform: value }))}
                >
                  <SelectTrigger id="designated-platform" aria-label="平台">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="nowcoder">牛客</SelectItem>
                    <SelectItem value="codeforces">Codeforces</SelectItem>
                    <SelectItem value="atcoder">AtCoder</SelectItem>
                    <SelectItem value="hydro">校内 OJ</SelectItem>
                    <SelectItem value="other">其他/无</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="designated-lambda">λ 档位</Label>
                <Select
                  value={form.lambdaKey}
                  onValueChange={(value) => setForm((p) => ({ ...p, lambdaKey: value }))}
                >
                  <SelectTrigger id="designated-lambda" aria-label="λ 档位">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A">甲 1.2</SelectItem>
                    <SelectItem value="B">乙 1.0</SelectItem>
                    <SelectItem value="C">丙 0.8</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="designated-group">分组</Label>
                <Input
                  id="designated-group"
                  value={form.groupName}
                  onChange={(e) => setForm((p) => ({ ...p, groupName: e.target.value }))}
                  maxLength={64}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="designated-name">赛事名称</Label>
                <Input
                  id="designated-name"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  maxLength={160}
                  placeholder="例如：Codeforces Div.3"
                />
              </div>
            </div>
            <Button
              type="submit"
              size="sm"
              className="w-fit"
              disabled={createMutation.isPending || form.name.trim().length < 2}
            >
              保存条目
            </Button>
          </form>
        )}
        {query.isPending ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : query.isError ? (
          <p className="text-sm text-muted-foreground">{query.error.message}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {query.data.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <Badge
                  variant={
                    row.category === 'A' ? 'info' : row.category === 'B' ? 'success' : 'neutral'
                  }
                >
                  {row.category}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-foreground">{row.name}</span>
                <span className="text-xs text-muted-foreground">{row.groupName}</span>
                {row.platform && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{row.platform}</span>
                )}
                {row.lambdaKey && (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                    λ {row.lambdaKey}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate(row.id)}
                >
                  删除
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
