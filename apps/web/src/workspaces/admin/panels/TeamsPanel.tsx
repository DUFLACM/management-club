/**
 * 管理端 · 组队管理（competitions.manage）：
 * GET /admin/teams?q=&status=&cursor= 列表；GET /admin/teams/:id 详情；
 * POST /admin/teams 代建；POST /admin/teams/:id 改名 / 人数 / 锁定；
 * POST :id/members、:id/members/:userId/remove、:id/captain、:id/disband、:id/invites/:inviteId/cancel。
 * 已锁定（已报名）的队伍也允许调整，界面提示影响；解散会撤销进行中的报名。
 */
import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CrownIcon, LoaderCircleIcon, LockIcon, LockOpenIcon, PlusIcon, SearchIcon, UserMinusIcon, UserPlusIcon, UsersIcon } from 'lucide-react';

import { api, type ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrivateInfiniteQuery } from '@/lib/private-infinite';
import { usePrincipal } from '@/lib/session';
import { useDebouncedValue, LoadMoreButton } from '@/lib/hooks';
import { formatDateTime } from '@/lib/format';
import { entryStatusLabel } from '@/lib/competitions';
import { PanelHeader } from '@/components/club/PanelHeader';
import { PrincipalGate } from '@/components/club/QueryBoundary';
import { EmptyState } from '@/components/club/EmptyState';
import { ErrorState } from '@/components/club/ErrorState';
import { ResponsiveDetail } from '@/components/club/ResponsiveDetail';
import { MemberAvatar } from '@/components/club/MemberAvatar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface TeamMemberView {
  userId: string;
  studentNo: string;
  name: string;
  avatarAssetId: string | null;
  role: string;
  joinedAt?: string;
}

interface TeamRowDto {
  id: string;
  name: string;
  teamSize: number;
  status: string;
  captainUserId: string;
  createdAt: string;
  entryCount: number;
  members: TeamMemberView[];
}

interface TeamDetailDto extends Omit<TeamRowDto, 'entryCount'> {
  invites: Array<{ id: string; createdAt: string; userId: string; studentNo: string; name: string; avatarAssetId: string | null }>;
  entries: Array<{ id: string; status: string; registeredAt: string; event: { id: string; title: string; status: string } }>;
}

interface MemberPickDto {
  id: string;
  displayName: string;
  studentNo: string;
  avatarAssetId?: string | null;
}

const TEAM_STATUS: Record<string, { label: string; className: string }> = {
  forming: { label: '组队中', className: 'bg-info-subtle text-info-foreground' },
  locked: { label: '已锁定', className: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300' },
  disbanded: { label: '已解散', className: 'bg-muted text-muted-foreground' },
};

function TeamStatusBadge({ status }: { status: string }) {
  const entry = TEAM_STATUS[status] ?? { label: status, className: 'bg-muted text-muted-foreground' };
  return <span className={`inline-flex w-fit rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ${entry.className}`}>{entry.label}</span>;
}

/** 队员头像叠放 + 人数 */
function MemberStack({ members, teamSize }: { members: TeamMemberView[]; teamSize: number }) {
  return (
    <span className="flex items-center gap-2">
      <span className="flex -space-x-2">
        {members.slice(0, 5).map((member) => (
          <MemberAvatar key={member.userId} assetId={member.avatarAssetId} name={member.name} size="sm" />
        ))}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {members.length}/{teamSize}
      </span>
    </span>
  );
}

export default function TeamsPanel() {
  const principal = usePrincipal();
  return <PrincipalGate principal={principal}>{(principalId) => <TeamsBody principalId={principalId} />}</PrincipalGate>;
}

function TeamsBody({ principalId }: { principalId: string }) {
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 450);
  const [status, setStatus] = useState('active');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const listQuery = usePrivateInfiniteQuery<{ items: TeamRowDto[]; nextCursor?: string | null }, ApiError>(
    principalId,
    ['admin', 'teams', 'list', status, debouncedSearch],
    async (cursor) => {
      const params = new URLSearchParams();
      if (status !== 'all') params.set('status', status);
      if (debouncedSearch) params.set('q', debouncedSearch);
      if (cursor) params.set('cursor', cursor);
      const { data } = await api.get<{ items: TeamRowDto[]; nextCursor?: string | null }>(`/admin/teams?${params.toString()}`);
      return data;
    },
  );
  // 默认「进行中」= 组队中 + 已锁定（服务端 status=active），隐藏已解散的队伍
  const items = listQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const captainName = (team: TeamRowDto) => team.members.find((m) => m.userId === team.captainUserId)?.name ?? '—';

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="组队"
        description="查看全部队伍，代建队伍、调整队员与队长、锁定或解散队伍。"
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon aria-hidden="true" />
            新建队伍
          </Button>
        }
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:w-72">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="搜索队名 / 队员姓名 / 学号"
            className="pl-9"
            aria-label="搜索队伍"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="sm:w-40" aria-label="状态筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">进行中</SelectItem>
            <SelectItem value="forming">组队中</SelectItem>
            <SelectItem value="locked">已锁定</SelectItem>
            <SelectItem value="disbanded">已解散</SelectItem>
            <SelectItem value="all">全部</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {listQuery.isPending ? (
        <Card>
          <CardContent className="flex flex-col gap-2 p-5">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-12" />
            ))}
          </CardContent>
        </Card>
      ) : listQuery.isError ? (
        <Card>
          <CardContent className="py-10">
            {listQuery.error.status === 403 ? (
              <EmptyState kind="forbidden" description={listQuery.error.message} />
            ) : (
              <ErrorState description={listQuery.error.message} onRetry={() => void listQuery.refetch()} retrying={listQuery.isFetching} />
            )}
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10">
            <EmptyState kind="empty" description={debouncedSearch ? '没有匹配的队伍。' : '还没有队伍。成员可在「竞赛」页自行组队，也可以在这里代建。'} />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 pb-2">
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">队伍</TableHead>
                    <TableHead>队员</TableHead>
                    <TableHead>队长</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">报名</TableHead>
                    <TableHead className="pr-5">创建时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((team) => (
                    <TableRow key={team.id} className="cursor-pointer" onClick={() => setDetailId(team.id)}>
                      <TableCell className="pl-5 font-medium">
                        <button type="button" className="text-left hover:underline" onClick={() => setDetailId(team.id)}>
                          {team.name}
                        </button>
                      </TableCell>
                      <TableCell>
                        <MemberStack members={team.members} teamSize={team.teamSize} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">{captainName(team)}</TableCell>
                      <TableCell>
                        <TeamStatusBadge status={team.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{team.entryCount}</TableCell>
                      <TableCell className="pr-5 text-muted-foreground tabular-nums">{formatDateTime(team.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <ul className="flex flex-col divide-y divide-border md:hidden">
              {items.map((team) => (
                <li key={team.id}>
                  <button type="button" onClick={() => setDetailId(team.id)} className="flex w-full flex-col gap-2 px-4 py-3 text-left">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{team.name}</span>
                      <TeamStatusBadge status={team.status} />
                    </span>
                    <span className="flex items-center justify-between gap-2">
                      <MemberStack members={team.members} teamSize={team.teamSize} />
                      <span className="text-xs text-muted-foreground">队长 {captainName(team)} · 报名 {team.entryCount}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="px-5">
              <LoadMoreButton
                onClick={() => void listQuery.fetchNextPage()}
                loading={listQuery.isFetchingNextPage}
                hasNext={Boolean(listQuery.data?.pages.at(-1)?.nextCursor)}
                hint="已展示全部队伍"
              />
            </div>
          </CardContent>
        </Card>
      )}

      {detailId && <TeamDetail principalId={principalId} teamId={detailId} onClose={() => setDetailId(null)} />}
      <CreateTeamDialog
        principalId={principalId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(teamId) => {
          setCreateOpen(false);
          setDetailId(teamId);
        }}
      />
    </div>
  );
}

/** 管理端成员检索（复用 /admin/members?q=），用于代建选队长与加队员 */
function MemberSearch({
  principalId,
  excludeIds,
  actionLabel,
  pending,
  onPick,
}: {
  principalId: string;
  excludeIds: string[];
  actionLabel: string;
  pending?: boolean;
  onPick: (member: MemberPickDto) => void;
}) {
  const [keyword, setKeyword] = useState('');
  const debounced = useDebouncedValue(keyword.trim(), 400);
  const query = usePrivateQuery<{ items: MemberPickDto[] }, ApiError>(
    principalId,
    ['admin', 'members', 'picker', debounced],
    async () => (await api.get<{ items: MemberPickDto[] }>(`/admin/members?q=${encodeURIComponent(debounced)}`)).data,
    { enabled: debounced.length >= 1 },
  );
  const candidates = (query.data?.items ?? []).filter((member) => !excludeIds.includes(member.id)).slice(0, 8);
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入姓名 / 展示名 / 学号" className="pl-9" aria-label="搜索成员" />
      </div>
      {debounced && (
        <ul className="flex max-h-56 flex-col divide-y divide-border overflow-y-auto rounded-xl border border-border">
          {query.isFetching && candidates.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">搜索中…</li>
          ) : candidates.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">没有可选的成员。</li>
          ) : (
            candidates.map((member) => (
              <li key={member.id} className="flex items-center gap-2 px-3 py-2">
                <MemberAvatar assetId={member.avatarAssetId} name={member.displayName} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">{member.displayName}</span>
                  <span className="block font-mono text-xs text-muted-foreground">{member.studentNo}</span>
                </span>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => onPick(member)}>
                  {actionLabel}
                </Button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function CreateTeamDialog({
  principalId,
  open,
  onOpenChange,
  onCreated,
}: {
  principalId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (teamId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [teamSize, setTeamSize] = useState('3');
  const [captain, setCaptain] = useState<MemberPickDto | null>(null);
  const mutation = useMutation({
    mutationFn: async () =>
      (await api.post<{ teamId: string }>('/admin/teams', { name: name.trim(), teamSize: Number(teamSize), captainUserId: captain!.id })).data,
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'teams'] });
      setName('');
      setCaptain(null);
      onCreated(data.teamId);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) mutation.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建队伍</DialogTitle>
          <DialogDescription>先选队长建队，建好后可在队伍详情里继续加队员。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {mutation.isError && (
            <Alert variant="destructive">
              <AlertDescription>{(mutation.error as ApiError).message}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-[1fr_96px] gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="team-name">队名</Label>
              <Input id="team-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="如 算法一队" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="team-size">人数上限</Label>
              <Input id="team-size" inputMode="numeric" value={teamSize} onChange={(event) => setTeamSize(event.target.value.replace(/\D/g, ''))} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>队长</Label>
            {captain ? (
              <div className="flex items-center gap-2 rounded-xl border border-border px-3 py-2">
                <MemberAvatar assetId={captain.avatarAssetId} name={captain.displayName} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm">{captain.displayName}</span>
                <Button size="sm" variant="ghost" onClick={() => setCaptain(null)}>
                  更换
                </Button>
              </div>
            ) : (
              <MemberSearch principalId={principalId} excludeIds={[]} actionLabel="选为队长" onPick={setCaptain} />
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={mutation.isPending || name.trim().length < 2 || !captain || !(Number(teamSize) >= 1 && Number(teamSize) <= 10)}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            建队
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function TeamDetail({ principalId, teamId, onClose }: { principalId: string; teamId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const query = usePrivateQuery<TeamDetailDto, ApiError>(principalId, ['admin', 'teams', 'detail', teamId], async () => (await api.get<TeamDetailDto>(`/admin/teams/${teamId}`)).data);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [confirmDisband, setConfirmDisband] = useState(false);
  const [disbandReason, setDisbandReason] = useState('');
  const [editName, setEditName] = useState<string | null>(null);
  const [editSize, setEditSize] = useState<string | null>(null);

  const action = useMutation({
    mutationFn: async ({ path, body }: { path: string; body?: unknown }) => (await api.post(`/admin/teams/${teamId}${path}`, body ?? {})).data,
    onSuccess: () => {
      setError(null);
      setConfirmRemove(null);
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'teams'] });
    },
    onError: (err: ApiError) => setError(err.message),
  });
  const run = (path: string, body?: unknown) => action.mutate({ path, body });

  const team = query.data;
  const disbanded = team?.status === 'disbanded';
  const activeEntries = team?.entries.filter((entry) => ['submitted', 'pending_review', 'confirmed'].includes(entry.status)) ?? [];
  const name = editName ?? team?.name ?? '';
  const size = editSize ?? String(team?.teamSize ?? '');
  const dirty = team != null && (name.trim() !== team.name || Number(size) !== team.teamSize);

  return (
    <ResponsiveDetail
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        team ? (
          <span className="flex items-center gap-2">
            <UsersIcon className="size-5 text-primary" aria-hidden="true" />
            {team.name}
            <TeamStatusBadge status={team.status} />
          </span>
        ) : (
          '队伍详情'
        )
      }
      description={team ? `${team.members.length}/${team.teamSize} 人 · 创建于 ${formatDateTime(team.createdAt)}` : undefined}
    >
      {query.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
      ) : query.isError ? (
        <ErrorState description={query.error.message} onRetry={() => void query.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {team!.status === 'locked' && (
            <Alert>
              <AlertDescription>队伍已锁定（通常是已报名赛事）。调整队员会影响报名名单，请确认后再操作。</AlertDescription>
            </Alert>
          )}

          {!disbanded && (
            <Section title="基本信息">
              <div className="grid grid-cols-[1fr_96px_auto] items-end gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="edit-team-name">队名</Label>
                  <Input id="edit-team-name" value={name} maxLength={80} onChange={(event) => setEditName(event.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="edit-team-size">人数上限</Label>
                  <Input id="edit-team-size" inputMode="numeric" value={size} onChange={(event) => setEditSize(event.target.value.replace(/\D/g, ''))} />
                </div>
                <Button
                  variant="outline"
                  disabled={!dirty || action.isPending || name.trim().length < 2}
                  onClick={() => {
                    run('', { name: name.trim(), teamSize: Number(size) });
                    setEditName(null);
                    setEditSize(null);
                  }}
                >
                  保存
                </Button>
              </div>
              <div>
                <Button size="sm" variant="ghost" disabled={action.isPending} onClick={() => run('', { status: team!.status === 'locked' ? 'forming' : 'locked' })}>
                  {team!.status === 'locked' ? <LockOpenIcon aria-hidden="true" /> : <LockIcon aria-hidden="true" />}
                  {team!.status === 'locked' ? '解锁（允许成员继续邀请）' : '锁定（成员不能再邀请）'}
                </Button>
              </div>
            </Section>
          )}

          <Section
            title={`队员（${team!.members.length}/${team!.teamSize}）`}
            action={
              !disbanded && (
                <Button size="sm" variant="outline" onClick={() => setAddOpen((value) => !value)} disabled={team!.members.length >= team!.teamSize}>
                  <UserPlusIcon aria-hidden="true" />
                  {team!.members.length >= team!.teamSize ? '已满员' : '加队员'}
                </Button>
              )
            }
          >
            {addOpen && !disbanded && (
              <MemberSearch
                principalId={principalId}
                excludeIds={team!.members.map((m) => m.userId)}
                actionLabel="加入"
                pending={action.isPending}
                onPick={(member) => run('/members', { userId: member.id })}
              />
            )}
            {team!.members.length === 0 ? (
              <p className="text-sm text-muted-foreground">队伍里没有成员。</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
                {team!.members.map((member) => {
                  const isCaptain = member.userId === team!.captainUserId;
                  return (
                    <li key={member.userId} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                      <MemberAvatar assetId={member.avatarAssetId} name={member.name} size="md" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                          <span className="truncate">{member.name}</span>
                          {isCaptain && (
                            <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
                              <CrownIcon className="size-3" aria-hidden="true" />
                              队长
                            </span>
                          )}
                        </span>
                        <span className="block font-mono text-xs text-muted-foreground">{member.studentNo}</span>
                      </span>
                      {!disbanded && (
                        <span className="flex gap-1">
                          {!isCaptain && (
                            <Button size="sm" variant="ghost" disabled={action.isPending} onClick={() => run('/captain', { userId: member.userId })}>
                              设为队长
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant={confirmRemove === member.userId ? 'destructive' : 'ghost'}
                            className={confirmRemove === member.userId ? undefined : 'text-destructive hover:text-destructive'}
                            disabled={action.isPending}
                            onClick={() => {
                              if (confirmRemove === member.userId) run(`/members/${member.userId}/remove`);
                              else setConfirmRemove(member.userId);
                            }}
                          >
                            <UserMinusIcon aria-hidden="true" />
                            {confirmRemove === member.userId ? '确认移出' : '移出'}
                          </Button>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          {team!.invites.length > 0 && (
            <Section title="待处理邀请">
              <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
                {team!.invites.map((invite) => (
                  <li key={invite.id} className="flex items-center gap-3 px-3 py-2">
                    <MemberAvatar assetId={invite.avatarAssetId} name={invite.name} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm">{invite.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{formatDateTime(invite.createdAt)}</span>
                    <Button size="sm" variant="ghost" disabled={action.isPending} onClick={() => run(`/invites/${invite.id}/cancel`)}>
                      撤销
                    </Button>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="赛事报名">
            {team!.entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">还没有报名赛事。</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
                {team!.entries.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate">{entry.event.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{entryStatusLabel(entry.status)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {!disbanded && (
            <Section title="解散队伍">
              <div className="flex flex-col gap-2 rounded-xl border border-destructive/30 p-3">
                <p className="text-xs text-muted-foreground">
                  解散后队伍不能再修改；待处理邀请会被撤销
                  {activeEntries.length > 0 ? `，进行中的 ${activeEntries.length} 条报名会被取消` : ''}。已审核通过的报名和已入账积分不受影响。
                </p>
                {confirmDisband && (
                  <Input value={disbandReason} onChange={(event) => setDisbandReason(event.target.value)} maxLength={200} placeholder="解散原因（选填，会写入报名备注与审计）" />
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={confirmDisband ? 'destructive' : 'outline'}
                    className={confirmDisband ? undefined : 'text-destructive hover:text-destructive'}
                    disabled={action.isPending}
                    onClick={() => {
                      if (confirmDisband) {
                        run('/disband', { reason: disbandReason.trim() || undefined });
                        setConfirmDisband(false);
                      } else setConfirmDisband(true);
                    }}
                  >
                    {confirmDisband ? '确认解散' : '解散队伍'}
                  </Button>
                  {confirmDisband && (
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDisband(false)}>
                      取消
                    </Button>
                  )}
                </div>
              </div>
            </Section>
          )}
        </div>
      )}
    </ResponsiveDetail>
  );
}
