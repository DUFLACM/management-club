/**
 * 管理端 · 公告（announcements.manage）：GET/POST /admin/announcements、PUT/DELETE /admin/announcements/:id、
 * POST /admin/announcements/:id/{publish,withdraw}。
 * 正文 Markdown；勾选「弹窗」的公告发布后，成员进入工作台时自动弹出，确认一次后不再弹。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EyeIcon, LoaderCircleIcon, PencilIcon, PinIcon, PlusIcon, SendIcon, Trash2Icon, Undo2Icon } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrincipal } from '@/lib/session';
import { formatDateTime, fromLocalInputValue, toLocalInputValue } from '@/lib/format';
import { PanelHeader } from '@/components/club/PanelHeader';
import { PrincipalGate } from '@/components/club/QueryBoundary';
import { EmptyState } from '@/components/club/EmptyState';
import { ErrorState } from '@/components/club/ErrorState';
import { MarkdownView } from '@/components/club/MarkdownView';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';

interface AdminAnnouncementDto {
  id: string;
  title: string;
  content: string;
  popup: boolean;
  pinned: boolean;
  status: 'draft' | 'published' | 'withdrawn';
  publishedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  readCount: number;
}

const STATUS_BADGE: Record<AdminAnnouncementDto['status'], { label: string; variant: 'neutral' | 'success' | 'warning' }> = {
  draft: { label: '草稿', variant: 'neutral' },
  published: { label: '已发布', variant: 'success' },
  withdrawn: { label: '已撤回', variant: 'warning' },
};

interface FormState {
  title: string;
  content: string;
  popup: boolean;
  pinned: boolean;
  /** datetime-local 值，留空不过期 */
  expiresAt: string;
}

const EMPTY_FORM: FormState = { title: '', content: '', popup: true, pinned: false, expiresAt: '' };

export default function AnnouncementsPanel() {
  const principal = usePrincipal();
  return (
    <PrincipalGate principal={principal}>
      {(principalId) => <AnnouncementsBody principalId={principalId} />}
    </PrincipalGate>
  );
}

function AnnouncementsBody({ principalId }: { principalId: string }) {
  const queryClient = useQueryClient();
  // editing：null = 关闭；'new' = 新建；其余为公告 id
  const [editing, setEditing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const listQuery = usePrivateQuery(principalId, ['admin', 'announcements'], async () => {
    const { data } = await api.get<AdminAnnouncementDto[]>('/admin/announcements');
    return data;
  });
  const items = listQuery.data ?? [];

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'announcements'] });
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'announcements'] });
  };

  const actionMutation = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'publish' | 'withdraw' | 'delete' }) => {
      if (action === 'delete') await api.delete(`/admin/announcements/${id}`);
      else await api.post(`/admin/announcements/${id}/${action}`);
    },
    onSuccess: () => {
      setActionError(null);
      refresh();
    },
    onError: (error: ApiError) => setActionError(error.message),
  });

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="公告"
        description="发布后成员在顶栏喇叭里能看到；勾选「弹窗」的公告会在成员进入工作台时自动弹出，每人确认一次。"
        actions={
          <Button onClick={() => setEditing('new')}>
            <PlusIcon aria-hidden="true" />
            新建公告
          </Button>
        }
      />

      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      {listQuery.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : listQuery.isError ? (
        <ErrorState description={listQuery.error.message} onRetry={() => void listQuery.refetch()} retrying={listQuery.isFetching} />
      ) : items.length === 0 ? (
        <EmptyState kind="empty" title="还没有公告" description="点「新建公告」写第一条。" />
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => {
            const status = STATUS_BADGE[item.status];
            const expired = item.expiresAt != null && new Date(item.expiresAt).getTime() <= Date.now();
            const pending = actionMutation.isPending && actionMutation.variables?.id === item.id;
            return (
              <Card key={item.id}>
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      {item.pinned && <PinIcon className="size-4 text-primary" aria-label="置顶" />}
                      <h2 className="truncate text-sm font-semibold text-foreground">{item.title}</h2>
                      <Badge variant={status.variant}>{status.label}</Badge>
                      {item.popup && <Badge variant="info">弹窗</Badge>}
                      {expired && <Badge variant="destructive">已过期</Badge>}
                    </div>
                    <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{item.content}</p>
                    <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
                      {item.publishedAt ? <span>发布 {formatDateTime(item.publishedAt)}</span> : <span>更新 {formatDateTime(item.updatedAt)}</span>}
                      {item.expiresAt && <span>截止 {formatDateTime(item.expiresAt)}</span>}
                      {item.status !== 'draft' && (
                        <span className="inline-flex items-center gap-1">
                          <EyeIcon className="size-3" aria-hidden="true" />
                          {item.readCount} 人已读
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditing(item.id)}>
                      <PencilIcon aria-hidden="true" />
                      编辑
                    </Button>
                    {item.status === 'published' ? (
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => actionMutation.mutate({ id: item.id, action: 'withdraw' })}>
                        <Undo2Icon aria-hidden="true" />
                        撤回
                      </Button>
                    ) : (
                      <Button size="sm" disabled={pending} onClick={() => actionMutation.mutate({ id: item.id, action: 'publish' })}>
                        <SendIcon aria-hidden="true" />
                        {item.status === 'withdrawn' ? '重新发布' : '发布'}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={pending}
                      aria-label={`删除公告「${item.title}」`}
                      onClick={() => {
                        if (window.confirm(`确定删除公告「${item.title}」？删除后无法恢复。`)) actionMutation.mutate({ id: item.id, action: 'delete' });
                      }}
                    >
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <AnnouncementEditor
        key={editing ?? 'closed'}
        open={editing != null}
        initial={editing && editing !== 'new' ? items.find((item) => item.id === editing) ?? null : null}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />
    </div>
  );
}

function AnnouncementEditor({
  open,
  initial,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  initial: AdminAnnouncementDto | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(() =>
    initial
      ? { title: initial.title, content: initial.content, popup: initial.popup, pinned: initial.pinned, expiresAt: toLocalInputValue(initial.expiresAt) }
      : EMPTY_FORM,
  );
  const [preview, setPreview] = useState(false);

  const saveMutation = useMutation({
    mutationFn: async (publish: boolean) => {
      const body = {
        title: form.title.trim(),
        content: form.content.trim(),
        popup: form.popup,
        pinned: form.pinned,
        expiresAt: fromLocalInputValue(form.expiresAt),
      };
      if (initial) await api.put(`/admin/announcements/${initial.id}`, body);
      else await api.post(`/admin/announcements${publish ? '?publish=1' : ''}`, body);
    },
    onSuccess: onSaved,
  });

  const valid = form.title.trim().length > 0 && form.content.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial ? '编辑公告' : '新建公告'}</DialogTitle>
          <DialogDescription>
            {initial?.status === 'published' ? '公告已发布，保存后立即生效；已确认过弹窗的成员不会再次弹出。' : '正文支持 Markdown（标题、列表、链接、加粗等）。'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="announcement-title">标题</Label>
            <Input
              id="announcement-title"
              maxLength={100}
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              placeholder="如：寒假集训报名开始"
            />
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="announcement-content">正文</Label>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPreview(!preview)}>
                {preview ? '继续编辑' : '预览'}
              </Button>
            </div>
            {preview ? (
              <div className="max-h-80 min-h-40 overflow-y-auto rounded-xl border border-border p-3">
                {form.content.trim() ? <MarkdownView source={form.content} className="text-foreground" /> : <p className="text-sm text-muted-foreground">正文为空</p>}
              </div>
            ) : (
              <Textarea
                id="announcement-content"
                rows={10}
                maxLength={20000}
                value={form.content}
                onChange={(event) => setForm({ ...form, content: event.target.value })}
                placeholder="公告内容，支持 Markdown"
              />
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="announcement-expires">截止时间（选填）</Label>
              <Input
                id="announcement-expires"
                type="datetime-local"
                value={form.expiresAt}
                onChange={(event) => setForm({ ...form, expiresAt: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">过了截止时间自动下线，留空一直显示。</p>
            </div>
            <div className="flex flex-col gap-2.5 sm:pt-6">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Checkbox checked={form.popup} onCheckedChange={(checked) => setForm({ ...form, popup: checked === true })} />
                弹窗提醒（成员进入工作台时自动弹出）
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Checkbox checked={form.pinned} onCheckedChange={(checked) => setForm({ ...form, pinned: checked === true })} />
                置顶
              </label>
            </div>
          </div>

          {saveMutation.isError && (
            <Alert variant="destructive">
              <AlertDescription>
                {saveMutation.error instanceof ApiError ? saveMutation.error.message : '保存失败'}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          {initial ? (
            <Button disabled={!valid || saveMutation.isPending} onClick={() => saveMutation.mutate(false)}>
              {saveMutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
              保存
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={!valid || saveMutation.isPending} onClick={() => saveMutation.mutate(false)}>
                存为草稿
              </Button>
              <Button disabled={!valid || saveMutation.isPending} onClick={() => saveMutation.mutate(true)}>
                {saveMutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
                发布
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
