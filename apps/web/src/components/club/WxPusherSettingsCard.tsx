/**
 * WxPusher 微信推送设置卡片（成员端「我的 → 资料与隐私」）：
 * - 支持生成带一次性 extra 令牌的微信扫码绑定二维码，并在扫码期间自动轮询完成状态；
 * - 提供手动填入 UID 兜底绑定（适配本地开发无公网回调地址的场景）；
 * - 绑定后支持总开关、分项订阅开关（积分/审批/活动/赛事/公告）、发送测试推送与解绑。
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BellRingIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  QrCodeIcon,
  SendIcon,
  UnlinkIcon,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { formatDateTime } from '@/lib/format';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

interface WxPusherStatusDto {
  configured: boolean;
  ready: boolean;
  bound: boolean;
  uidMasked: string | null;
  enabled: boolean;
  preferences: {
    points: boolean;
    approvals: boolean;
    activities: boolean;
    competitions: boolean;
    announcements: boolean;
  };
  boundAt: string | null;
  lastPushedAt: string | null;
  lastError: string | null;
  callbackUrl: string;
}

interface WxPusherQrDto {
  qrDataUrl: string;
  shortUrl: string;
  expiresAt: string;
  callbackUrl: string;
}

type PreferenceKey = keyof WxPusherStatusDto['preferences'];

const PREFERENCE_ITEMS: Array<{ key: PreferenceKey; label: string; desc: string }> = [
  { key: 'points', label: '积分变动', desc: '积分入账、冲正或更正时推送' },
  { key: 'approvals', label: '审批与个人动态', desc: '请假、远程、申诉、贡献申报、训练室与徽标通知' },
  { key: 'activities', label: '比赛与活动发布', desc: '周赛、月赛、例会、讲座等新活动发布时推送' },
  { key: 'competitions', label: '正式赛事通知', desc: 'A/B 类正式赛事开放报名时推送' },
  { key: 'announcements', label: '社团公告', desc: '协会发布新公告时推送' },
];

export function WxPusherSettingsCard({ principalId }: { principalId: string }) {
  const queryClient = useQueryClient();
  const [qr, setQr] = useState<WxPusherQrDto | null>(null);
  const [showManualBind, setShowManualBind] = useState(false);
  const [manualUid, setManualUid] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'error'; message: string } | null>(null);

  const statusQuery = usePrivateQuery<WxPusherStatusDto, ApiError>(
    principalId,
    ['me', 'wxpusher'],
    async () => (await api.get<WxPusherStatusDto>('/me/notifications/wxpusher')).data,
    {
      staleTime: 15_000,
      refetchInterval: qr ? 3_000 : false,
    },
  );

  const status = statusQuery.data;

  // 扫码绑定完成后自动收起二维码并提示成功
  useEffect(() => {
    if (qr && status?.bound) {
      setQr(null);
      setFeedback({ type: 'ok', message: '微信推送已扫码绑定成功！' });
    }
  }, [qr, status?.bound]);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'me', 'wxpusher'] });

  const qrMutation = useMutation({
    mutationFn: async () => (await api.post<WxPusherQrDto>('/me/notifications/wxpusher/qrcode')).data,
    onSuccess: (data) => {
      setFeedback(null);
      setQr(data);
    },
    onError: (error: ApiError) => {
      setFeedback({ type: 'error', message: error.message });
    },
  });

  const manualBindMutation = useMutation({
    mutationFn: async (uid: string) =>
      (await api.post<{ status: WxPusherStatusDto; welcomeSent: boolean; welcomeError: string | null }>(
        '/me/notifications/wxpusher/bind-uid',
        { uid },
      )).data,
    onSuccess: (res) => {
      setManualUid('');
      setShowManualBind(false);
      setQr(null);
      queryClient.setQueryData(['principal', principalId, 'me', 'wxpusher'], res.status);
      setFeedback(
        res.welcomeSent
          ? { type: 'ok', message: '已绑定 UID，并向你的微信发送了确认消息。' }
          : { type: 'ok', message: `已保存 UID 绑定（提示：${res.welcomeError ?? '确认消息未送达，请检查是否已关注应用'}）。` },
      );
    },
    onError: (error: ApiError) => {
      setFeedback({ type: 'error', message: error.message });
    },
  });

  const prefMutation = useMutation({
    mutationFn: async (patch: Record<string, boolean>) =>
      (await api.patch<WxPusherStatusDto>('/me/notifications/wxpusher', patch)).data,
    onSuccess: (next) => {
      queryClient.setQueryData(['principal', principalId, 'me', 'wxpusher'], next);
      setFeedback(null);
    },
    onError: (error: ApiError) => {
      setFeedback({ type: 'error', message: error.message });
      void invalidate();
    },
  });

  const testMutation = useMutation({
    mutationFn: async () =>
      (await api.post<{ sent: boolean; acceptedCount: number }>('/me/notifications/wxpusher/test')).data,
    onSuccess: () => {
      setFeedback({ type: 'ok', message: '测试消息已发送，请查看微信“WxPusher消息推送平台”通知。' });
      void invalidate();
    },
    onError: (error: ApiError) => {
      setFeedback({ type: 'error', message: error.message });
      void invalidate();
    },
  });

  const unbindMutation = useMutation({
    mutationFn: async () => (await api.delete<{ unbound: boolean }>('/me/notifications/wxpusher')).data,
    onSuccess: () => {
      setQr(null);
      setFeedback({ type: 'ok', message: '已解除微信推送绑定。' });
      void invalidate();
    },
    onError: (error: ApiError) => {
      setFeedback({ type: 'error', message: error.message });
    },
  });

  return (
    <Card className="lg:col-span-2">
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <BellRingIcon className="size-4 text-primary" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-foreground">微信消息推送（WxPusher）</h3>
          </div>
          {statusQuery.isPending ? (
            <Skeleton className="h-5 w-16 rounded-full" />
          ) : !status?.configured ? (
            <Badge variant="outline">未配置</Badge>
          ) : status.bound ? (
            <Badge variant={status.enabled ? 'success' : 'warning'}>
              {status.enabled ? '已绑定 · 开启' : '已绑定 · 已暂停'}
            </Badge>
          ) : (
            <Badge variant="outline">未绑定</Badge>
          )}
        </div>

        <p className="text-xs leading-5 text-muted-foreground">
          通过 WxPusher 将协会的积分变动、审批结果、新活动、正式赛事与社团公告实时推送到微信；也可按分类自由开关。
        </p>

        {feedback && (
          <Alert variant={feedback.type === 'error' ? 'destructive' : 'success'}>
            <AlertTitle>{feedback.type === 'error' ? '操作失败' : '提示'}</AlertTitle>
            <AlertDescription>{feedback.message}</AlertDescription>
          </Alert>
        )}

        {statusQuery.isPending ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : statusQuery.isError ? (
          <p className="text-sm text-destructive">{statusQuery.error.message}</p>
        ) : !status?.ready ? (
          <p className="text-xs text-muted-foreground">
            数据库尚未执行 WxPusher 迁移，请联系管理员执行 `pnpm db:migrate:deploy` 后重试。
          </p>
        ) : !status.configured ? (
          <p className="text-xs text-muted-foreground">
            服务端尚未配置 `WXPUSHER_APP_TOKEN`，当前暂未开放微信推送。
          </p>
        ) : !status.bound ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={qrMutation.isPending}
                onClick={() => qrMutation.mutate()}
              >
                {qrMutation.isPending ? (
                  <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <QrCodeIcon className="size-4" aria-hidden="true" />
                )}
                {qr ? '刷新绑定二维码' : '生成微信绑定二维码'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setShowManualBind((v) => !v)}
              >
                {showManualBind ? '收起手动绑定' : '已有 UID？手动绑定'}
              </Button>
            </div>

            {qr && (
              <div className="flex flex-col items-start gap-3 rounded-xl border border-border bg-muted/30 p-4 sm:flex-row sm:items-center">
                <img
                  src={qr.qrDataUrl}
                  alt="WxPusher 微信绑定二维码"
                  className="size-44 rounded-lg border border-border bg-white p-1.5"
                />
                <div className="flex flex-col gap-1.5 text-xs leading-5 text-muted-foreground">
                  <p className="text-sm font-medium text-foreground">微信扫码关注即可自动完成绑定</p>
                  <p>1. 打开微信扫描左侧二维码，关注「WxPusher消息推送平台」并确认订阅。</p>
                  <p>2. 关注成功后页面会在几秒内自动刷新状态（二维码有效至 {formatDateTime(qr.expiresAt)}）。</p>
                  {qr.shortUrl && (
                    <a
                      href={qr.shortUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex w-fit items-center gap-1 text-primary underline-offset-4 hover:underline"
                    >
                      打开订阅链接
                      <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                    </a>
                  )}
                  <p className="text-[11px] text-muted-foreground/80">
                    若本地开发无公网回调，扫码关注后可在 WxPusher 公众号底部菜单「我的 → 我的 UID」复制 UID 并点击上方「手动绑定」。
                  </p>
                </div>
              </div>
            )}

            {showManualBind && (
              <form
                className="flex flex-col gap-2 rounded-xl border border-border p-3.5 sm:flex-row sm:items-end"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (manualUid.trim()) manualBindMutation.mutate(manualUid.trim());
                }}
              >
                <div className="grid flex-1 gap-1.5">
                  <Label htmlFor="wxpusher-uid-input">WxPusher UID</Label>
                  <Input
                    id="wxpusher-uid-input"
                    placeholder="例如 UID_xxxxxxxxxxxxxxxx"
                    value={manualUid}
                    onChange={(event) => setManualUid(event.target.value)}
                    required
                  />
                </div>
                <Button type="submit" size="sm" disabled={manualBindMutation.isPending || !manualUid.trim()}>
                  {manualBindMutation.isPending && (
                    <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
                  )}
                  确认绑定
                </Button>
              </form>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted/30 px-3.5 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
                <span className="inline-flex items-center gap-1 font-medium text-foreground">
                  <CheckCircle2Icon className="size-3.5 text-emerald-600" aria-hidden="true" />
                  UID：<code className="font-mono text-xs">{status.uidMasked}</code>
                </span>
                {status.boundAt && <span>绑定于 {formatDateTime(status.boundAt)}</span>}
                {status.lastPushedAt && <span>最近送达 {formatDateTime(status.lastPushedAt)}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={testMutation.isPending}
                  onClick={() => testMutation.mutate()}
                >
                  {testMutation.isPending ? (
                    <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <SendIcon className="size-3.5" aria-hidden="true" />
                  )}
                  发送测试推送
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={unbindMutation.isPending}
                  onClick={() => unbindMutation.mutate()}
                >
                  <UnlinkIcon className="size-3.5" aria-hidden="true" />
                  解绑
                </Button>
              </div>
            </div>

            {status.lastError && (
              <Alert variant="destructive">
                <AlertTitle>最近一次推送异常</AlertTitle>
                <AlertDescription>{status.lastError}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col gap-2.5">
              <label className="flex items-center gap-2.5 text-sm font-medium text-foreground">
                <Checkbox
                  checked={status.enabled}
                  disabled={prefMutation.isPending}
                  onCheckedChange={(checked) => prefMutation.mutate({ enabled: checked === true })}
                />
                启用微信推送总开关
              </label>

              <div className="grid grid-cols-1 gap-2 pl-6 sm:grid-cols-2">
                {PREFERENCE_ITEMS.map((item) => (
                  <label
                    key={item.key}
                    className="flex items-start gap-2.5 rounded-lg border border-border/80 p-2.5 text-xs transition-colors hover:bg-muted/40"
                  >
                    <Checkbox
                      checked={status.preferences[item.key]}
                      disabled={!status.enabled || prefMutation.isPending}
                      onCheckedChange={(checked) =>
                        prefMutation.mutate({ [item.key]: checked === true })
                      }
                      className="mt-0.5"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium text-foreground">{item.label}</span>
                      <span className="text-muted-foreground">{item.desc}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
