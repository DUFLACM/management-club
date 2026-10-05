/**
 * 管理端 · 邀请码（invitations.manage）：GET /admin/invitations、POST /admin/invitations
 * （返回一次性明文码）、POST /admin/invitations/:id/revoke。
 * 创建成功后用 qrcode（动态 import）生成 /register#invite=<code> 的注册二维码。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, CopyIcon, LoaderCircleIcon, PlusIcon, QrCodeIcon } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateInfiniteQuery } from '@/lib/private-infinite';
import { usePrincipal } from '@/lib/session';
import { LoadMoreButton } from '@/lib/hooks';
import { formatDateTime } from '@/lib/format';
import { renderQrDataUrl } from '@/lib/qr';
import { PanelHeader } from '@/components/club/PanelHeader';
import { PrincipalGate } from '@/components/club/QueryBoundary';
import { EmptyState } from '@/components/club/EmptyState';
import { ErrorState } from '@/components/club/ErrorState';
import { StatusBadge } from '@/components/club/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

interface InvitationDto {
  id: string;
  batchLabel: string | null;
  status: string;
  maxUses: number;
  usedCount: number;
  expiresAt: string;
  allowedStudentNo: string | null;
  revokedAt: string | null;
  createdAt: string;
  redemptions: Array<{
    id: string;
    user: { studentNo: string; verifiedRealName: string | null } | null;
  }>;
}

export default function InvitesPanel() {
  const principal = usePrincipal();
  return (
    <PrincipalGate principal={principal}>
      {(principalId) => <InvitesBody principalId={principalId} />}
    </PrincipalGate>
  );
}

function InvitesBody({ principalId }: { principalId: string }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ maxUses: '1', expiresInDays: '14', batchLabel: '', allowedStudentNo: '' });
  const [created, setCreated] = useState<{ code: string; expiresAt: string } | null>(null);
  const [createdQr, setCreatedQr] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const listQuery = usePrivateInfiniteQuery<
    { items: InvitationDto[]; nextCursor?: string | null },
    ApiError
  >(principalId, ['admin', 'invitations'], async (cursor) => {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    const { data } = await api.get<{ items: InvitationDto[]; nextCursor?: string | null }>(
      `/admin/invitations?${params.toString()}`,
    );
    return data;
  });

  const items = listQuery.data?.pages.flatMap((page) => page.items) ?? [];

  const createMutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ invitationId: string; code: string; expiresAt: string }>(
        '/admin/invitations',
        {
          maxUses: Number(form.maxUses || 1),
          expiresInDays: Number(form.expiresInDays || 14),
          ...(form.batchLabel.trim() ? { batchLabel: form.batchLabel.trim() } : {}),
          ...(form.allowedStudentNo.trim()
            ? { allowedStudentNo: form.allowedStudentNo.trim() }
            : {}),
        },
      );
      return data;
    },
    onSuccess: async (result) => {
      setCreateError(null);
      setCreated({ code: result.code, expiresAt: result.expiresAt });
      setCopied(false);
      setCreatedQr(null);
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'invitations'] });
      try {
        const origin = window.location.origin;
        const url = await renderQrDataUrl(`${origin}/register#invite=${result.code}`);
        setCreatedQr(url);
      } catch {
        setCreatedQr(null);
      }
    },
    onError: (error: ApiError) => setCreateError(error.message),
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/admin/invitations/${id}/revoke`);
      return id;
    },
    onSuccess: () => {
      setRevokeError(null);
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'invitations'] });
    },
    onError: (error: ApiError) => setRevokeError(error.message),
  });

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="邀请码"
        description="入社邀请的一次性明文码；创建时展示一次，之后只保留哈希。"
      />

      {created && (
        <Card>
          <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <QrCodeIcon className="size-4 text-input" aria-hidden="true" />
                入社注册邀请（只显示这一次）
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded-lg bg-muted px-3 py-2 font-mono text-sm break-all text-foreground">
                  {created.code}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(created.code);
                      setCopied(true);
                    } catch {
                      setCopied(false);
                    }
                  }}
                >
                  {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
                  {copied ? '已复制' : '复制'}
                </Button>
              </div>
              <p className="text-xs leading-5 text-muted-foreground tabular-nums">
                有效期至 {formatDateTime(created.expiresAt)}；二维码内容为
                /register#invite=&lt;code&gt;，扫码后打开注册页自动填入（fragment 不进服务器日志）。
              </p>
            </div>
            {createdQr && (
              <img
                src={createdQr}
                alt="入社注册邀请二维码"
                width={160}
                height={160}
                className="size-40 shrink-0 rounded-xl border border-border bg-white p-2"
              />
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <form
            className="grid grid-cols-1 gap-3 border-b border-border p-5 sm:grid-cols-4 sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              createMutation.mutate();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="invite-uses">可用次数（1-200）</Label>
              <Input
                id="invite-uses"
                type="number"
                min={1}
                max={200}
                value={form.maxUses}
                onChange={(event) => setForm({ ...form, maxUses: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="invite-days">有效天数（1-365）</Label>
              <Input
                id="invite-days"
                type="number"
                min={1}
                max={365}
                value={form.expiresInDays}
                onChange={(event) => setForm({ ...form, expiresInDays: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="invite-batch">批次标签（可选）</Label>
              <Input
                id="invite-batch"
                value={form.batchLabel}
                onChange={(event) => setForm({ ...form, batchLabel: event.target.value })}
                maxLength={64}
                placeholder="如 2026 秋招新"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="invite-campus-id">限定校园编号（可选）</Label>
              <Input
                id="invite-campus-id"
                value={form.allowedStudentNo}
                onChange={(event) => setForm({ ...form, allowedStudentNo: event.target.value })}
                maxLength={64}
                pattern="[A-Za-z0-9._-]{1,64}"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="如 202601234 或 T00123"
              />
            </div>
            <div className="sm:col-span-4">
              {createError && (
                <Alert variant="destructive" className="mb-3">
                  <AlertDescription>{createError}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? (
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                ) : (
                  <PlusIcon aria-hidden="true" />
                )}
                创建邀请
              </Button>
            </div>
          </form>

          {listQuery.isPending ? (
            <div className="flex flex-col gap-2 p-5">
              {[0, 1].map((index) => (
                <Skeleton key={index} className="h-16 rounded-xl" />
              ))}
            </div>
          ) : listQuery.isError ? (
            <div className="p-5">
              {listQuery.error.status === 403 ? (
                <EmptyState kind="forbidden" description={listQuery.error.message} />
              ) : (
                <ErrorState
                  description={listQuery.error.message}
                  onRetry={() => void listQuery.refetch()}
                  retrying={listQuery.isFetching}
                />
              )}
            </div>
          ) : items.length === 0 ? (
            <div className="p-5">
              <EmptyState kind="empty" description="还没有邀请；创建后把一次性明文码发给受邀同学。" />
            </div>
          ) : (
            <>
              <ul className="flex flex-col divide-y divide-border">
                {items.map((invitation) => (
                  <li key={invitation.id} className="flex flex-col gap-2 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {invitation.batchLabel ?? '（个人邀请）'}
                      </span>
                      <StatusBadge
                        kind="disclosure"
                        value={
                          invitation.status === 'revoked' || invitation.revokedAt
                            ? '已停用'
                            : new Date(invitation.expiresAt) < new Date()
                              ? '已结束'
                              : '公示中'
                        }
                      />
                      <span className="text-xs text-muted-foreground tabular-nums">
                        已用 {invitation.usedCount}/{invitation.maxUses} · 至{' '}
                        {formatDateTime(invitation.expiresAt)}
                      </span>
                      <span className="ml-auto flex items-center gap-2">
                        {invitation.allowedStudentNo && (
                          <span className="text-xs text-muted-foreground tabular-nums">
                            限定 {invitation.allowedStudentNo}
                          </span>
                        )}
                        {!invitation.revokedAt && invitation.status !== 'revoked' && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={revokeMutation.isPending}
                            onClick={() => revokeMutation.mutate(invitation.id)}
                          >
                            停用
                          </Button>
                        )}
                      </span>
                    </div>
                    {invitation.redemptions.length > 0 && (
                      <ul className="flex flex-wrap gap-2">
                        {invitation.redemptions.map((redemption) => (
                          <li
                            key={redemption.id}
                            className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground tabular-nums"
                          >
                            {redemption.user?.studentNo ?? '—'}{' '}
                            {redemption.user?.verifiedRealName ?? ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
              <div className="px-5">
                <LoadMoreButton
                  onClick={() => {
                    void listQuery.fetchNextPage();
                  }}
                  loading={listQuery.isFetchingNextPage}
                  hasNext={Boolean(listQuery.data?.pages.at(-1)?.nextCursor)}
                  hint="已展示全部邀请"
                />
              </div>
            </>
          )}
          {revokeError && (
            <div className="px-5 pb-5">
              <Alert variant="destructive">
                <AlertTitle>停用失败</AlertTitle>
                <AlertDescription>{revokeError}</AlertDescription>
              </Alert>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
