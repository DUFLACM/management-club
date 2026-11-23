/**
 * 管理端 · 徽标管理与规则自动发章（挂载于成员面板）：
 * - GET/POST /admin/badges/definitions（自定义徽标定义）；
 * - GET/POST /admin/badges/awards + POST /admin/badges/awards/:id/revoke（手动授予与撤销）；
 * - POST /admin/badges/auto-grant（dryRun 预览 + 一键批量自动授予并推送个人通知）。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AwardIcon, LoaderCircleIcon, PlusIcon, SparklesIcon, UserPlusIcon } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { useDebouncedValue } from '@/lib/hooks';
import { formatDateTime } from '@/lib/format';
import { EmptyState } from '@/components/club/EmptyState';
import { ErrorState } from '@/components/club/ErrorState';
import { StatusBadge } from '@/components/club/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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

interface BadgeDefinitionDto {
  id: string;
  key: string;
  name: string;
  description: string;
  icon: string;
  theme: string;
  category: string;
  grantMethod: string;
  isOfficialHonor: boolean;
  status: string;
}

interface BadgeAwardAdminDto {
  id: string;
  status: string;
  sourceKey: string;
  evidenceRef: string | null;
  revokedReason: string | null;
  grantedAt: string;
  definition: {
    id: string;
    key: string;
    name: string;
    theme: string;
    category: string;
    grantMethod: string;
  };
  user: {
    id: string;
    studentNo: string;
    name: string;
  };
}

interface AutoGrantResultDto {
  dryRun: boolean;
  evaluatedMembers: number;
  matchedCount: number;
  grantedCount: number;
  items: Array<{
    userId: string;
    userName: string;
    studentNo: string;
    badgeKey: string;
    badgeName: string;
    reason: string;
  }>;
}

const THEME_LABELS: Record<string, string> = {
  blue: '海蓝',
  mint: '薄荷绿',
  lilac: '丁香紫',
  amber: '琥珀金',
};

const CATEGORY_LABELS: Record<string, string> = {
  honor: '荣誉',
  contribution: '贡献',
  service: '服务',
  activity: '出勤活动',
  growth: '成长里程碑',
};

export function AdminBadgesTab({ principalId }: { principalId: string }) {
  const queryClient = useQueryClient();
  const [defineOpen, setDefineOpen] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoPreview, setAutoPreview] = useState<AutoGrantResultDto | null>(null);

  const defsQuery = usePrivateQuery<BadgeDefinitionDto[], ApiError>(
    principalId,
    ['admin', 'badges', 'definitions'],
    async () => (await api.get<BadgeDefinitionDto[]>('/admin/badges/definitions')).data,
  );

  const awardsQuery = usePrivateQuery<BadgeAwardAdminDto[], ApiError>(
    principalId,
    ['admin', 'badges', 'awards'],
    async () => (await api.get<BadgeAwardAdminDto[]>('/admin/badges/awards')).data,
  );

  const autoGrantMutation = useMutation({
    mutationFn: async (dryRun: boolean) =>
      (await api.post<AutoGrantResultDto>('/admin/badges/auto-grant', { dryRun })).data,
    onSuccess: (res) => {
      setError(null);
      setAutoPreview(res);
      if (!res.dryRun) {
        setNotice(`规则巡检完成：扫描 ${res.evaluatedMembers} 位成员，新授予 ${res.grantedCount} 枚徽标并已通知成员。`);
        void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'badges'] });
      }
    },
    onError: (err: ApiError) => setError(err.message),
  });

  const revokeMutation = useMutation({
    mutationFn: async (awardId: string) => {
      await api.post(`/admin/badges/awards/${awardId}/revoke`, { reason: '管理员撤销授予' });
    },
    onSuccess: () => {
      setError(null);
      setNotice('已撤销该徽标授予记录。');
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'badges'] });
    },
    onError: (err: ApiError) => setError(err.message),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'badges'] });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="border-primary/20 bg-primary/[0.02]">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <SparklesIcon className="size-4 text-primary" aria-hidden="true" />
              规则自动发章引擎
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              按真实业务记录自动判定：首讲达人（获批讲题 ≥1）、全勤先锋（准时 ≥5 场）、题解共享者（上传资料 ≥1）、高产贡献者（通过申报 ≥3）、竞赛常青树（完赛 ≥5）、CF Specialist（≥1400）/ Expert（≥1600）。幂等不重复发章。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={autoGrantMutation.isPending}
              onClick={() => autoGrantMutation.mutate(true)}
            >
              {autoGrantMutation.isPending && autoGrantMutation.variables === true && (
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
              )}
              预览命中名单
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={autoGrantMutation.isPending}
              onClick={() => autoGrantMutation.mutate(false)}
            >
              {autoGrantMutation.isPending && autoGrantMutation.variables === false && (
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
              )}
              一键自动发章
            </Button>
          </div>
        </CardContent>
      </Card>

      {autoPreview && (
        <Card>
          <CardContent className="flex flex-col gap-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-medium text-foreground">
                {autoPreview.dryRun ? '自动发章预览' : '自动发章执行结果'}：共评估 {autoPreview.evaluatedMembers} 名活跃成员，
                {autoPreview.dryRun
                  ? `可新发 ${autoPreview.matchedCount} 枚徽标`
                  : `已新发 ${autoPreview.grantedCount} 枚徽标`}
              </span>
              <Button type="button" size="sm" variant="ghost" onClick={() => setAutoPreview(null)}>
                收起
              </Button>
            </div>
            {autoPreview.items.length === 0 ? (
              <p className="text-xs text-muted-foreground">所有达标成员均已获得对应规则徽标，暂无新增项。</p>
            ) : (
              <ul className="max-h-48 divide-y divide-border overflow-y-auto text-xs">
                {autoPreview.items.map((item, idx) => (
                  <li key={`${item.userId}-${item.badgeKey}-${idx}`} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span>
                      <strong className="font-medium text-foreground">{item.userName}</strong>
                      <span className="ml-1 text-muted-foreground tabular-nums">({item.studentNo})</span>
                      {' → '}
                      <Badge variant="outline" className="ml-1">{item.badgeName}</Badge>
                    </span>
                    <span className="text-muted-foreground">{item.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {notice && (
        <Alert>
          <AlertTitle>已更新</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>操作未完成</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <Card className="xl:col-span-5">
          <CardContent className="flex flex-col gap-3 p-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <AwardIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                徽标定义（{defsQuery.data?.length ?? 0}）
              </h3>
              <div className="flex gap-1.5">
                <Button type="button" size="sm" variant="outline" onClick={() => setDefineOpen(true)}>
                  <PlusIcon aria-hidden="true" />
                  新建
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={!defsQuery.data || defsQuery.data.length === 0}
                  onClick={() => setGrantOpen(true)}
                >
                  <UserPlusIcon aria-hidden="true" />
                  手动授予
                </Button>
              </div>
            </div>
            {defsQuery.isPending ? (
              <Skeleton className="h-40 rounded-xl" />
            ) : defsQuery.isError ? (
              <ErrorState description={defsQuery.error.message} onRetry={() => void defsQuery.refetch()} />
            ) : defsQuery.data.length === 0 ? (
              <EmptyState kind="empty" title="暂无徽标定义" description="可点击「新建」创建自定义徽标，或运行「一键自动发章」初始化内置规则徽标。" />
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {defsQuery.data.map((def) => (
                  <li key={def.id} className="flex flex-col gap-1 py-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{def.name}</span>
                      <Badge variant="outline" className="text-[11px]">{CATEGORY_LABELS[def.category] ?? def.category}</Badge>
                      <Badge variant={def.grantMethod === 'rule' ? 'info' : 'neutral'} className="text-[11px]">
                        {def.grantMethod === 'rule' ? '规则自动' : '人工授予'}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{def.description}</p>
                    <p className="font-mono text-[11px] text-muted-foreground/80">
                      {def.key} · {THEME_LABELS[def.theme] ?? def.theme}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="xl:col-span-7">
          <CardContent className="flex flex-col gap-3 p-5">
            <h3 className="text-sm font-semibold text-foreground">
              近期授予记录（{awardsQuery.data?.length ?? 0}）
            </h3>
            {awardsQuery.isPending ? (
              <Skeleton className="h-40 rounded-xl" />
            ) : awardsQuery.isError ? (
              <ErrorState description={awardsQuery.error.message} onRetry={() => void awardsQuery.refetch()} />
            ) : awardsQuery.data.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">尚无徽标授予记录。</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {awardsQuery.data.map((award) => (
                  <li key={award.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">{award.user.name}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">{award.user.studentNo}</span>
                        <Badge variant="outline">{award.definition.name}</Badge>
                        <StatusBadge
                          kind="disclosure"
                          value={award.status === 'active' ? '已批准' : '已取消'}
                        />
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {award.evidenceRef ?? '—'} · 授予于 {formatDateTime(award.grantedAt)}
                      </p>
                    </div>
                    {award.status === 'active' && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        disabled={revokeMutation.isPending}
                        onClick={() => revokeMutation.mutate(award.id)}
                      >
                        撤销
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <DefineBadgeDialog
        open={defineOpen}
        onOpenChange={setDefineOpen}
        onCreated={() => {
          setNotice('已新建徽标定义。');
          invalidate();
        }}
      />
      <GrantBadgeDialog
        principalId={principalId}
        definitions={defsQuery.data ?? []}
        open={grantOpen}
        onOpenChange={setGrantOpen}
        onGranted={() => {
          setNotice('徽标已授予并发送站内通知。');
          invalidate();
        }}
      />
    </div>
  );
}

function DefineBadgeDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('award');
  const [theme, setTheme] = useState('blue');
  const [category, setCategory] = useState('honor');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      await api.post('/admin/badges/definitions', {
        key: key.trim().toLowerCase(),
        name: name.trim(),
        description: description.trim(),
        icon,
        theme,
        category,
        grantMethod: 'manual',
      });
    },
    onSuccess: () => {
      setError(null);
      setKey('');
      setName('');
      setDescription('');
      onOpenChange(false);
      onCreated();
    },
    onError: (err: ApiError) => setError(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>新建徽标定义</DialogTitle>
          <DialogDescription>创建社团荣誉或贡献徽标，随后可授予成员并置顶展示在个人主页。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="badge-key">唯一标识（小写字母/数字/下划线）</Label>
            <Input id="badge-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="icpc_2026_silver" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="badge-name">显示名称（2-40 字）</Label>
            <Input id="badge-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="2026 ICPC 区域赛银牌" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="badge-desc">说明（5-300 字）</Label>
            <Input id="badge-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="代表学校获得 2026 ICPC 亚洲区域赛银奖" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="grid gap-1">
              <Label>分类</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(CATEGORY_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label>配色</Label>
              <Select value={theme} onValueChange={setTheme}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(THEME_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label>图标</Label>
              <Select value={icon} onValueChange={setIcon}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['award', 'star', 'zap', 'target', 'book-open', 'code', 'heart', 'users'].map((ic) => (
                    <SelectItem key={ic} value={ic}>{ic}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            type="button"
            disabled={mutation.isPending || key.trim().length < 2 || name.trim().length < 2 || description.trim().length < 5}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            创建徽标
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GrantBadgeDialog({
  principalId,
  definitions,
  open,
  onOpenChange,
  onGranted,
}: {
  principalId: string;
  definitions: BadgeDefinitionDto[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGranted: () => void;
}) {
  const [definitionKey, setDefinitionKey] = useState(definitions[0]?.key ?? '');
  const [memberSearch, setMemberSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const debounced = useDebouncedValue(memberSearch, 300);

  const membersQuery = usePrivateQuery<
    { items: Array<{ id: string; studentNo: string; realName: string; displayName: string | null }> },
    ApiError
  >(
    open ? principalId : null,
    ['admin', 'members', 'badge-picker', debounced],
    async () => {
      const qs = debounced ? `?q=${encodeURIComponent(debounced)}` : '';
      return (await api.get<{ items: Array<{ id: string; studentNo: string; realName: string; displayName: string | null }> }>(`/admin/members${qs}`)).data;
    },
  );

  const effectiveKey = definitionKey || definitions[0]?.key || '';

  const mutation = useMutation({
    mutationFn: async () => {
      await api.post('/admin/badges/awards', {
        definitionKey: effectiveKey,
        userId: selectedUserId,
        reason: reason.trim(),
        evidenceRef: `manual:${Date.now()}`,
      });
    },
    onSuccess: () => {
      setError(null);
      setReason('');
      setSelectedUserId('');
      onOpenChange(false);
      onGranted();
    },
    onError: (err: ApiError) => setError(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>手动授予徽标</DialogTitle>
          <DialogDescription>选择徽标与成员并填写依据，授予后将自动推送个人通知。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-1.5">
            <Label>选择徽标</Label>
            <Select value={effectiveKey} onValueChange={setDefinitionKey}>
              <SelectTrigger><SelectValue placeholder="请选择徽标" /></SelectTrigger>
              <SelectContent>
                {definitions.map((d) => (
                  <SelectItem key={d.key} value={d.key}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="grant-member-search">搜索并选择成员</Label>
            <Input
              id="grant-member-search"
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              placeholder="输入姓名或学号筛选"
            />
            <ul className="max-h-36 divide-y divide-border overflow-y-auto rounded-xl border border-border">
              {(membersQuery.data?.items ?? []).slice(0, 15).map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedUserId(m.id)}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs ${
                      selectedUserId === m.id ? 'bg-primary/10 font-semibold text-primary' : 'hover:bg-muted/50'
                    }`}
                  >
                    <span>{m.displayName || m.realName}</span>
                    <span className="text-muted-foreground tabular-nums">{m.studentNo}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="grant-reason">授予依据（3-500 字）</Label>
            <Input
              id="grant-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="如：校赛筹备与出题突出贡献"
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            type="button"
            disabled={mutation.isPending || !effectiveKey || !selectedUserId || reason.trim().length < 3}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            确认授予
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
