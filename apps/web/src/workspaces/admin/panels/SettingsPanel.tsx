/**
 * 管理端 · 设置（settings.manage / secrets.write）。
 * 左侧 15 组白名单导航 + 当前配置表单；草稿 → 校验 → 审批 → 发布；
 * 版本恢复（以旧值建新草稿）；secrets 只写（GET 只显示状态）。
 * 底部动作区分「保存草稿」与「发布」；未保存退出有守卫（beforeunload + 状态提示）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon, LoaderCircleIcon, SaveIcon, SendIcon } from 'lucide-react';

import { api, ApiError, fetchCsrfToken } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrincipal } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { PanelHeader } from '@/components/club/PanelHeader';
import { PrincipalGate, QueryBoundary } from '@/components/club/QueryBoundary';
import { EmptyState } from '@/components/club/EmptyState';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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

type FieldType = 'boolean' | 'number' | 'string' | 'policy';

interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  optional?: boolean;
}

const GROUP_FIELDS: Record<string, ReadonlyArray<FieldSpec>> = {
  branding: [
    { key: 'siteName', label: '站点名称（2-40 字）', type: 'string' },
    { key: 'shortName', label: '短名（≤16 字）', type: 'string' },
    { key: 'footerNote', label: '页脚说明', type: 'string', optional: true },
  ],
  general: [
    { key: 'supportContact', label: '支持联系方式', type: 'string', optional: true },
    { key: 'defaultPageSize', label: '默认分页大小（10-100）', type: 'number' },
  ],
  term: [
    { key: 'semesterCode', label: '学期代码', type: 'string' },
    { key: 'registerWindowOpen', label: '注册窗口开放', type: 'boolean' },
  ],
  rule_defaults: [
    { key: 'defaultRuleVersion', label: '默认规则版本', type: 'number', optional: true },
    { key: 'note', label: '说明', type: 'string', optional: true },
  ],
  attendance_defaults: [
    { key: 'defaultPolicy', label: '默认签到策略', type: 'policy' },
    { key: 'defaultQrRotateSeconds', label: '默认活动码轮换（10-120 秒）', type: 'number' },
    { key: 'defaultMaxAccuracyMeters', label: '默认定位精度（5-200 米）', type: 'number' },
  ],
  invite_policy: [
    { key: 'defaultExpiresInDays', label: '默认有效天数（1-365）', type: 'number' },
    { key: 'defaultMaxUses', label: '默认可用次数（1-200）', type: 'number' },
  ],
  badges: [{ key: 'publicDisplayAllowed', label: '允许公开展示徽标', type: 'boolean' }],
  privacy_disclosures: [
    { key: 'publicProfilesEnabled', label: '启用公开主页（opt-in）', type: 'boolean' },
    { key: 'retentionNote', label: '保留说明', type: 'string', optional: true },
  ],
  platforms: [
    { key: 'nowcoderEnabled', label: '牛客', type: 'boolean' },
    { key: 'codeforcesEnabled', label: 'Codeforces', type: 'boolean' },
    { key: 'atcoderEnabled', label: 'AtCoder', type: 'boolean' },
    { key: 'atcoderProblemsEnabled', label: 'AtCoder 题库', type: 'boolean' },
  ],
  worker: [
    { key: 'concurrency', label: '并发（1-16）', type: 'number' },
    { key: 'jobTimeoutMinutes', label: '任务超时（1-60 分钟）', type: 'number' },
  ],
  review_rules: [
    { key: 'minReviewers', label: '最少复核人（≥2）', type: 'number' },
    { key: 'teacherEscalationEnabled', label: '允许升级教师复核', type: 'boolean' },
  ],
  cas: [{ key: 'note', label: '说明（CAS 地址为受控部署配置）', type: 'string', optional: true }],
  security: [
    { key: 'sessionTtlHours', label: '会话时长（1-720 小时）', type: 'number' },
    { key: 'sensitiveReauthMinutes', label: '敏感操作重认证（1-120 分钟）', type: 'number' },
  ],
  maintenance: [
    { key: 'readOnlyMode', label: '只读模式', type: 'boolean' },
    { key: 'notice', label: '维护公告', type: 'string', optional: true },
  ],
  backups: [{ key: 'note', label: '备份说明', type: 'string', optional: true }],
};

const GROUP_LABELS: Record<string, string> = {
  branding: '品牌',
  general: '通用',
  term: '学期',
  rule_defaults: '规则默认',
  attendance_defaults: '出勤默认',
  invite_policy: '邀请策略',
  badges: '徽标',
  privacy_disclosures: '隐私与公示',
  platforms: '平台开关',
  worker: '后台任务',
  review_rules: '复核规则',
  cas: 'CAS 对接',
  security: '安全',
  maintenance: '维护',
  backups: '备份',
};

const GROUP_ORDER = Object.keys(GROUP_FIELDS);

const GROUP_DEFAULTS: Record<string, Record<string, unknown>> = {
  branding: { siteName: 'ACM 算法协会', shortName: 'ACM' },
  general: { defaultPageSize: 20 },
  term: { semesterCode: '', registerWindowOpen: false },
  rule_defaults: {},
  attendance_defaults: { defaultPolicy: 'GEO_OR_QR', defaultQrRotateSeconds: 25, defaultMaxAccuracyMeters: 50 },
  invite_policy: { defaultExpiresInDays: 14, defaultMaxUses: 1 },
  badges: { publicDisplayAllowed: true },
  privacy_disclosures: { publicProfilesEnabled: false },
  platforms: { nowcoderEnabled: true, codeforcesEnabled: true, atcoderEnabled: true, atcoderProblemsEnabled: false },
  worker: { concurrency: 2, jobTimeoutMinutes: 10 },
  review_rules: { minReviewers: 2, teacherEscalationEnabled: true },
  cas: {},
  security: { sessionTtlHours: 168, sensitiveReauthMinutes: 30 },
  maintenance: { readOnlyMode: false },
  backups: {},
};

interface SettingsViewDto {
  group: string;
  effective: Record<string, unknown> | null;
  draft: { id: string; status: string; value: Record<string, unknown>; changeSummary: string | null; createdAt: string } | null;
  versions: Array<{
    id: string;
    status: string;
    revision: number;
    changeSummary: string | null;
    createdAt: string;
    createdBy: string;
  }>;
}

interface SecretStatusDto {
  key: string;
  configured: boolean;
  version: number;
  lastRotated: string | null;
  disabled: boolean;
}

export default function SettingsPanel() {
  const principal = usePrincipal();
  return (
    <PrincipalGate principal={principal}>
      {(principalId) => <SettingsBody principalId={principalId} />}
    </PrincipalGate>
  );
}

function SettingsBody({ principalId }: { principalId: string }) {
  const [group, setGroup] = useState('branding');
  const [view, setView] = useState<'config' | 'secrets' | 'admin-security'>('config');

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="设置"
        description="站点配置的草稿 / 校验 / 审批 / 发布流；秘密只写不回显。"
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_1fr]">
        <nav aria-label="设置分组" className="lg:sticky lg:top-24 lg:self-start">
          <Card>
            <CardContent className="p-2">
              <ul className="flex flex-col gap-0.5">
                <li>
                  <button
                    type="button"
                    onClick={() => setView('config')}
                    aria-current={view === 'config' ? 'page' : undefined}
                    className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                      view === 'config' ? 'bg-secondary font-medium text-secondary-foreground' : 'text-foreground hover:bg-muted'
                    }`}
                  >
                    站点配置
                  </button>
                </li>
                {GROUP_ORDER.map((item) => (
                  <li key={item} className="pl-3">
                    <button
                      type="button"
                      onClick={() => {
                        setGroup(item);
                        setView('config');
                      }}
                      aria-current={view === 'config' && group === item ? 'page' : undefined}
                      className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                        view === 'config' && group === item
                          ? 'bg-secondary font-medium text-secondary-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      {GROUP_LABELS[item] ?? item}
                    </button>
                  </li>
                ))}
                <li className="mt-1 border-t border-border pt-1">
                  <button
                    type="button"
                    onClick={() => setView('admin-security')}
                    aria-current={view === 'admin-security' ? 'page' : undefined}
                    className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                      view === 'admin-security' ? 'bg-secondary font-medium text-secondary-foreground' : 'text-foreground hover:bg-muted'
                    }`}
                  >
                    管理员安全
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => setView('secrets')}
                    aria-current={view === 'secrets' ? 'page' : undefined}
                    className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                      view === 'secrets' ? 'bg-secondary font-medium text-secondary-foreground' : 'text-foreground hover:bg-muted'
                    }`}
                  >
                    秘密管理
                  </button>
                </li>
              </ul>
            </CardContent>
          </Card>
        </nav>

        {view === 'config' && <GroupEditor principalId={principalId} group={group} />}
        {view === 'admin-security' && <AdminAuthSecurityEditor />}
        {view === 'secrets' && <SecretsEditor />}
      </div>
    </div>
  );
}

function GroupEditor({ principalId, group }: { principalId: string; group: string }) {
  const queryClient = useQueryClient();
  const query = usePrivateQuery<SettingsViewDto, ApiError>(
    principalId,
    ['admin', 'settings', 'group', group],
    async () => (await api.get<SettingsViewDto>(`/admin/settings?group=${group}`)).data,
  );

  const fields = GROUP_FIELDS[group] ?? [];
  const initialValue = useMemo(() => {
    const view = query.data;
    const base: Record<string, unknown> = { ...(GROUP_DEFAULTS[group] ?? {}) };
    const source = view?.draft?.value ?? view?.effective ?? null;
    if (source) Object.assign(base, source);
    return base;
  }, [query.data, group]);

  const [form, setForm] = useState<Record<string, unknown>>(initialValue);
  const [changeSummary, setChangeSummary] = useState('');
  const [resetKey, setResetKey] = useState(0);
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [touched, setTouched] = useState(false);

  // 数据到达 / 切组时重置表单
  useEffect(() => {
    setForm(initialValue);
    setTouched(false);
    setResetKey((value) => value + 1);
    setChangeSummary('');
  }, [initialValue]);

  // 未保存退出守卫
  useEffect(() => {
    if (!touched) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [touched]);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'settings'] });
  }, [principalId, queryClient]);

  const buildValue = useCallback((): Record<string, unknown> => {
    const value: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = form[field.key];
      if (field.type === 'boolean') value[field.key] = raw === true;
      else if (field.type === 'number') value[field.key] = Number(raw ?? 0);
      else {
        const text = String(raw ?? '').trim();
        if (text === '' && field.optional) continue;
        value[field.key] = text;
      }
    }
    return value;
  }, [fields, form]);

  const draftMutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ versionId: string }>('/admin/settings/drafts', {
        group,
        value: buildValue(),
        changeSummary: changeSummary.trim() || '工作台草稿更新',
      });
      return data;
    },
    onSuccess: () => {
      setNotice({ tone: 'info', text: '草稿已保存；下一步：校验 → 审批 → 发布。' });
      setTouched(false);
      invalidate();
    },
    onError: (error: ApiError) => setNotice({ tone: 'error', text: error.message }),
  });

  const validateMutation = useMutation({
    mutationFn: async (draftId: string) => {
      const { data } = await api.post<{ valid: boolean; issues: string[] }>(
        `/admin/settings/drafts/${draftId}/validate`,
      );
      return data;
    },
    onSuccess: (result) => {
      setNotice(
        result.valid
          ? { tone: 'info', text: '校验通过（validated），可交另一负责人审批。' }
          : { tone: 'error', text: `校验未通过：${result.issues.join('；')}` },
      );
      invalidate();
    },
    onError: (error: ApiError) => setNotice({ tone: 'error', text: error.message }),
  });

  const approveMutation = useMutation({
    mutationFn: async (draftId: string) => {
      await api.post(`/admin/settings/drafts/${draftId}/approve`);
      return true;
    },
    onSuccess: () => {
      setNotice({ tone: 'info', text: '已审批（approved），可发布生效。' });
      invalidate();
    },
    onError: (error: ApiError) => setNotice({ tone: 'error', text: error.message }),
  });

  const publishMutation = useMutation({
    mutationFn: async (draftId: string) => {
      await api.post(`/admin/settings/drafts/${draftId}/publish`);
      return true;
    },
    onSuccess: () => {
      setNotice({ tone: 'info', text: '已发布生效（旧版本转 superseded）。' });
      invalidate();
    },
    onError: (error: ApiError) => setNotice({ tone: 'error', text: error.message }),
  });

  const revertMutation = useMutation({
    mutationFn: async (versionId: string) => {
      const { data } = await api.post<{ newDraftId: string }>(
        `/admin/settings/versions/${versionId}/revert`,
        { reason: '工作台恢复' },
      );
      return data;
    },
    onSuccess: (result) => {
      setNotice({
        tone: 'info',
        text: `已按旧值建立恢复草稿（${result.newDraftId.slice(0, 8)}），走校验/审批/发布流程。`,
      });
      invalidate();
    },
    onError: (error: ApiError) => setNotice({ tone: 'error', text: error.message }),
  });

  const draft = query.data?.draft ?? null;

  return (
    <QueryBoundary query={query} key={`${group}-${resetKey}`}>
      {(data) => (
        <div className="flex flex-col gap-4">
          {notice && (
            <Alert variant={notice.tone === 'error' ? 'destructive' : 'info'}>
              <AlertTitle>{notice.tone === 'error' ? '操作未完成' : '已处理'}</AlertTitle>
              <AlertDescription>{notice.text}</AlertDescription>
            </Alert>
          )}
          {touched && (
            <Alert variant="warning">
              <AlertDescription>
                有未保存的修改；切换分组或离开页面前请先「保存草稿」或放弃修改。
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardContent className="flex flex-col gap-4 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-foreground">
                  {GROUP_LABELS[group] ?? group} · 当前配置
                </h2>
                {data.effective == null ? (
                  <span className="text-xs text-muted-foreground">尚无生效版本（按默认值建草稿）</span>
                ) : (
                  <span className="text-xs text-muted-foreground">展示生效值；修改走草稿流程</span>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {fields.map((field) => {
                  const value = form[field.key];
                  const id = `setting-${group}-${field.key}`;
                  if (field.type === 'boolean') {
                    return (
                      <label key={field.key} htmlFor={id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          id={id}
                          checked={value === true}
                          onCheckedChange={(checked) => {
                            setForm((previous) => ({ ...previous, [field.key]: checked === true }));
                            setTouched(true);
                          }}
                        />
                        {field.label}
                      </label>
                    );
                  }
                  if (field.type === 'policy') {
                    return (
                      <div key={field.key} className="grid gap-1.5">
                        <Label htmlFor={id}>{field.label}</Label>
                        <Select
                          value={String(value ?? 'GEO_OR_QR')}
                          onValueChange={(next) => {
                            setForm((previous) => ({ ...previous, [field.key]: next }));
                            setTouched(true);
                          }}
                        >
                          <SelectTrigger id={id}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="GEO_ONLY">仅定位</SelectItem>
                            <SelectItem value="QR_ONLY">仅活动码</SelectItem>
                            <SelectItem value="GEO_OR_QR">定位或活动码</SelectItem>
                            <SelectItem value="GEO_AND_QR">定位 + 活动码</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  }
                  return (
                    <div key={field.key} className="grid gap-1.5">
                      <Label htmlFor={id}>
                        {field.label}
                        {field.optional ? '（可选）' : ''}
                      </Label>
                      <Input
                        id={id}
                        type={field.type === 'number' ? 'number' : 'text'}
                        value={String(value ?? '')}
                        onChange={(event) => {
                          setForm((previous) => ({ ...previous, [field.key]: event.target.value }));
                          setTouched(true);
                        }}
                      />
                    </div>
                  );
                })}
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="change-summary">变更说明（3-200 字）</Label>
                <Input
                  id="change-summary"
                  value={changeSummary}
                  onChange={(event) => setChangeSummary(event.target.value)}
                  placeholder="如：站点名更换为协会新名称"
                  maxLength={200}
                />
              </div>

              {/* 底部动作区：保存草稿 与 发布 分开 */}
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <Button
                  variant="outline"
                  disabled={draftMutation.isPending || changeSummary.trim().length < 3}
                  onClick={() => draftMutation.mutate()}
                >
                  {draftMutation.isPending ? (
                    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  ) : (
                    <SaveIcon aria-hidden="true" />
                  )}
                  保存草稿
                </Button>
                {draft && (
                  <Button
                    disabled={
                      publishMutation.isPending ||
                      approveMutation.isPending ||
                      draft.status !== 'approved'
                    }
                    onClick={() => publishMutation.mutate(draft.id)}
                  >
                    {publishMutation.isPending ? (
                      <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                    ) : (
                      <SendIcon aria-hidden="true" />
                    )}
                    发布{draft.status !== 'approved' ? '（需先审批）' : '生效'}
                  </Button>
                )}
                {draft && draft.status !== 'validated' && draft.status !== 'pending_approval' && draft.status !== 'approved' && (
                  <Button
                    variant="outline"
                    disabled={validateMutation.isPending}
                    onClick={() => validateMutation.mutate(draft.id)}
                  >
                    校验草稿
                  </Button>
                )}
                {draft && (draft.status === 'validated' || draft.status === 'pending_approval') && (
                  <Button
                    variant="outline"
                    disabled={approveMutation.isPending}
                    onClick={() => approveMutation.mutate(draft.id)}
                  >
                    审批（需另一负责人）
                  </Button>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                  草稿创建人不能审批自己的草稿（SAME_PRINCIPAL 拒绝）。
                </span>
              </div>
            </CardContent>
          </Card>

          {draft && (
            <Card>
              <CardContent className="flex flex-col gap-2 p-5">
                <h3 className="text-sm font-semibold text-foreground">
                  当前草稿 · {draft.status}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {draft.changeSummary ?? '（无说明）'} · 建立于 {formatDateTime(draft.createdAt)}
                </p>
                <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs text-foreground/90">
                  {JSON.stringify(draft.value, null, 2)}
                </pre>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="flex flex-col gap-2 p-5">
              <h3 className="text-sm font-semibold text-foreground">版本历史（恢复=按旧值建新草稿）</h3>
              {data.versions.length === 0 ? (
                <p className="text-sm text-muted-foreground">暂无版本记录。</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {data.versions.map((version) => (
                    <li key={version.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                      <span className="w-24 text-xs text-muted-foreground tabular-nums">
                        {formatDateTime(version.createdAt)}
                      </span>
                      <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs">{version.status}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {version.changeSummary ?? ''} · 创建人 {version.createdBy.slice(0, 8)}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={revertMutation.isPending}
                        onClick={() => revertMutation.mutate(version.id)}
                      >
                        恢复此版本
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </QueryBoundary>
  );
}

/** 入口密语长度下限，与服务端 ADMIN_SECRET_MIN_LENGTH 对齐（标签/输入框/提交按钮共用，避免各写各的） */
const GATE_SECRET_MIN_LENGTH = 5;

function AdminAuthSecurityEditor() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newGateSecret, setNewGateSecret] = useState('');
  const [confirmGateSecret, setConfirmGateSecret] = useState('');
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const secretsMatch = newGateSecret === confirmGateSecret;

  const updateMutation = useMutation({
    mutationFn: async () => {
      const csrfToken = await fetchCsrfToken();
      if (!csrfToken) throw new ApiError('CSRF_UNAVAILABLE', '安全令牌获取失败，请刷新页面重试。');
      await api.put('/admin/settings/admin-access-secret', {
        currentPassword,
        newSecret: newGateSecret,
        csrfToken,
      });
      return true;
    },
    onSuccess: () => {
      setCurrentPassword('');
      setNewGateSecret('');
      setConfirmGateSecret('');
      setNotice({ tone: 'info', text: '管理入口密语已更新，下次管理员登录时生效。' });
    },
    onError: (error: ApiError) => setNotice({ tone: 'error', text: error.message }),
  });

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-primary">
            <KeyRoundIcon aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-foreground">管理入口密语</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              修改管理员登录第一步使用的密语。此操作不会更改管理员用户名或密码。
            </p>
          </div>
        </div>

        {notice && (
          <Alert variant={notice.tone === 'error' ? 'destructive' : 'success'}>
            <AlertTitle>{notice.tone === 'error' ? '密语更新未完成' : '密语已更新'}</AlertTitle>
            <AlertDescription>{notice.text}</AlertDescription>
          </Alert>
        )}

        <form
          className="grid grid-cols-1 gap-4 sm:max-w-xl"
          onSubmit={(event) => {
            event.preventDefault();
            if (!secretsMatch) {
              setNotice({ tone: 'error', text: '两次输入的新密语不一致。' });
              return;
            }
            updateMutation.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="admin-current-password">当前管理员密码</Label>
            <Input
              id="admin-current-password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="admin-new-gate-secret">新密语（{GATE_SECRET_MIN_LENGTH}–256 个字符）</Label>
            <Input
              id="admin-new-gate-secret"
              type="password"
              autoComplete="new-password"
              required
              minLength={GATE_SECRET_MIN_LENGTH}
              maxLength={256}
              value={newGateSecret}
              onChange={(event) => setNewGateSecret(event.target.value)}
              aria-invalid={newGateSecret.length > 0 && confirmGateSecret.length > 0 && !secretsMatch}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="admin-confirm-gate-secret">确认新密语</Label>
            <Input
              id="admin-confirm-gate-secret"
              type="password"
              autoComplete="new-password"
              required
              minLength={GATE_SECRET_MIN_LENGTH}
              maxLength={256}
              value={confirmGateSecret}
              onChange={(event) => setConfirmGateSecret(event.target.value)}
              aria-invalid={confirmGateSecret.length > 0 && !secretsMatch}
              aria-describedby={!secretsMatch && confirmGateSecret ? 'admin-gate-secret-mismatch' : undefined}
            />
            {!secretsMatch && confirmGateSecret && (
              <p id="admin-gate-secret-mismatch" role="alert" className="text-xs leading-5 text-destructive">
                两次输入的新密语不一致。
              </p>
            )}
          </div>
          <div className="border-t border-border pt-3">
            <Button
              type="submit"
              disabled={
                updateMutation.isPending ||
                !currentPassword ||
                newGateSecret.length < GATE_SECRET_MIN_LENGTH ||
                !confirmGateSecret ||
                !secretsMatch
              }
            >
              {updateMutation.isPending ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : <KeyRoundIcon aria-hidden="true" />}
              {updateMutation.isPending ? '正在更新…' : '更新管理入口密语'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SecretsEditor() {
  const principal = usePrincipal();
  const principalId = principal?.principalId ?? null;
  const query = usePrivateQuery<SecretStatusDto[], ApiError>(
    principalId,
    ['admin', 'secrets'],
    async () => (await api.get<SecretStatusDto[]>('/admin/secrets')).data,
  );
  const [writeKey, setWriteKey] = useState('');
  const [writeValue, setWriteValue] = useState('');
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const writeMutation = useMutation({
    mutationFn: async () => {
      await api.put(`/admin/secrets/${writeKey.trim()}`, { secret: writeValue });
      return true;
    },
    onSuccess: () => {
      setNotice({ tone: 'info', text: '已写入/轮换（值不回显、不记录）。' });
      setWriteValue('');
    },
    onError: (error: ApiError) => setNotice({ tone: 'error', text: error.message }),
  });

  return (
    <QueryBoundary
      query={query}
      isEmpty={(secrets) => secrets.length === 0}
      emptyNode={
        <Card>
          <CardContent className="p-5">
            <EmptyState
              kind="empty"
              title="暂无登记的秘密"
              description="尚无秘密条目；按下方的写入表单登记（GET 永远只显示状态，不回显值）。"
            />
            <SecretWriteForm
              writeKey={writeKey}
              setWriteKey={setWriteKey}
              writeValue={writeValue}
              setWriteValue={setWriteValue}
              submitting={writeMutation.isPending}
              onSubmit={() => writeMutation.mutate()}
              notice={notice}
            />
          </CardContent>
        </Card>
      }
    >
      {(secrets) => (
        <div className="flex flex-col gap-4">
          {notice && (
            <Alert variant={notice.tone === 'error' ? 'destructive' : 'info'}>
              <AlertDescription>{notice.text}</AlertDescription>
            </Alert>
          )}
          <Card>
            <CardContent className="p-0 pb-2">
              <div className="p-5 pb-2">
                <h2 className="text-sm font-semibold text-foreground">秘密状态（只读）</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  只显示 key / 是否已配置 / 版本 / 最近轮换；值永不回显。
                </p>
              </div>
              <ul className="flex flex-col divide-y divide-border">
                {secrets.map((secret) => (
                  <li key={secret.key} className="flex flex-wrap items-center gap-3 p-4 text-sm">
                    <span className="font-mono text-xs">{secret.key}</span>
                    <span className={secret.configured ? 'text-success-foreground' : 'text-muted-foreground'}>
                      {secret.disabled ? '已禁用' : secret.configured ? '已配置' : '未配置'}
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                      v{secret.version} ·{' '}
                      {secret.lastRotated ? `轮换于 ${formatDateTime(secret.lastRotated)}` : '未轮换'}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-5">
              <h3 className="mb-3 text-sm font-semibold text-foreground">写入 / 轮换秘密（只写）</h3>
              <SecretWriteForm
                writeKey={writeKey}
                setWriteKey={setWriteKey}
                writeValue={writeValue}
                setWriteValue={setWriteValue}
                submitting={writeMutation.isPending}
                onSubmit={() => writeMutation.mutate()}
                notice={null}
              />
            </CardContent>
          </Card>
        </div>
      )}
    </QueryBoundary>
  );
}

function SecretWriteForm({
  writeKey,
  setWriteKey,
  writeValue,
  setWriteValue,
  submitting,
  onSubmit,
  notice,
}: {
  writeKey: string;
  setWriteKey: (value: string) => void;
  writeValue: string;
  setWriteValue: (value: string) => void;
  submitting: boolean;
  onSubmit: () => void;
  notice: { tone: 'info' | 'error'; text: string } | null;
}) {
  return (
    <form
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="secret-key">key（如 cas-api-key）</Label>
        <Input
          id="secret-key"
          value={writeKey}
          onChange={(event) => setWriteKey(event.target.value)}
          pattern="[-a-z0-9_:]{3,60}"
          required
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="secret-value">值（≥16 字节熵，不回显）</Label>
        <Input
          id="secret-value"
          type="password"
          value={writeValue}
          onChange={(event) => setWriteValue(event.target.value)}
          minLength={16}
          maxLength={4096}
          required
          autoComplete="off"
        />
      </div>
      <div className="sm:col-span-2">
        {notice && (
          <Alert variant={notice.tone === 'error' ? 'destructive' : 'info'} className="mb-3">
            <AlertDescription>{notice.text}</AlertDescription>
          </Alert>
        )}
        <Button
          type="submit"
          disabled={submitting || writeKey.trim().length < 3 || writeValue.length < 16}
        >
          {submitting && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
          写入秘密
        </Button>
      </div>
    </form>
  );
}
