/**
 * 公告中心（成员端 / 管理端顶栏共用）：
 * - 顶栏喇叭按钮，红点显示未读数，点开看全部公告；
 * - 管理端勾选了「弹窗」的未读公告，进入工作台时自动逐条弹出，点「我知道了」记已读后不再弹。
 * GET /announcements（已发布且未过期，带本人已读标记）、POST /announcements/:id/read。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRightIcon, MegaphoneIcon, PinIcon } from 'lucide-react';

import { api } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrincipal } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { MarkdownView } from '@/components/club/MarkdownView';
import { EmptyState } from '@/components/club/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export interface AnnouncementDto {
  id: string;
  title: string;
  content: string;
  popup: boolean;
  pinned: boolean;
  publishedAt: string | null;
  expiresAt: string | null;
  read: boolean;
}

export function AnnouncementCenter() {
  const principal = usePrincipal();
  const principalId = principal?.authenticated ? principal.principalId : null;
  const queryClient = useQueryClient();
  const [listOpen, setListOpen] = useState(false);
  const [openedId, setOpenedId] = useState<string | null>(null);
  // 本次会话里已关掉的弹窗（已读请求失败时也不再反复弹）
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  const query = usePrivateQuery(principalId, ['announcements'], async () => {
    const { data } = await api.get<AnnouncementDto[]>('/announcements');
    return data;
  }, { staleTime: 60_000 });
  const items = query.data ?? [];
  const unreadCount = items.filter((item) => !item.read).length;

  const readMutation = useMutation({
    mutationFn: (id: string) => api.post(`/announcements/${id}/read`),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<AnnouncementDto[]>(['principal', principalId ?? 'anonymous', 'announcements'], (previous) =>
        previous?.map((item) => (item.id === id ? { ...item, read: true } : item)),
      );
    },
  });
  const markRead = (item: AnnouncementDto) => {
    if (!item.read) readMutation.mutate(item.id);
  };

  // 弹窗队列：未读、勾了弹窗、本次没关过；按服务端顺序（置顶在前、新的在前）逐条弹
  const popupItem = !listOpen && !openedId ? items.find((item) => item.popup && !item.read && !dismissed.has(item.id)) : undefined;
  const opened = items.find((item) => item.id === openedId) ?? null;

  if (!principalId) return null;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="relative"
        aria-label={unreadCount > 0 ? `公告，${unreadCount} 条未读` : '公告'}
        onClick={() => setListOpen(true)}
      >
        <MegaphoneIcon aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute top-1.5 right-1.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-4 font-semibold text-white tabular-nums">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </Button>

      {/* 公告列表 */}
      <Dialog open={listOpen} onOpenChange={setListOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>公告</DialogTitle>
            <DialogDescription>社团发布的通知，点开查看全文。</DialogDescription>
          </DialogHeader>
          {items.length === 0 ? (
            <EmptyState kind="empty" title="暂无公告" description="有新公告时会显示在这里。" />
          ) : (
            <ul className="-mx-2 flex max-h-[60dvh] flex-col overflow-y-auto">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      setListOpen(false);
                      setOpenedId(item.id);
                      markRead(item);
                    }}
                  >
                    <span
                      className={cn('size-2 shrink-0 rounded-full', item.read ? 'bg-transparent' : 'bg-destructive')}
                      aria-hidden="true"
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className={cn('flex items-center gap-1.5 truncate text-sm', item.read ? 'text-foreground' : 'font-semibold text-foreground')}>
                        {item.pinned && <PinIcon className="size-3.5 shrink-0 text-primary" aria-label="置顶" />}
                        <span className="truncate">{item.title}</span>
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">{formatDateTime(item.publishedAt)}</span>
                    </span>
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      {/* 从列表打开的单条公告 */}
      <AnnouncementDialog
        item={opened}
        onClose={() => {
          setOpenedId(null);
          setListOpen(true);
        }}
        actionLabel="返回列表"
      />

      {/* 自动弹窗 */}
      <AnnouncementDialog
        item={popupItem ?? null}
        onClose={() => {
          if (!popupItem) return;
          setDismissed((previous) => new Set(previous).add(popupItem.id));
          markRead(popupItem);
        }}
        actionLabel="我知道了"
      />
    </>
  );
}

function AnnouncementDialog({
  item,
  onClose,
  actionLabel,
}: {
  item: AnnouncementDto | null;
  onClose: () => void;
  actionLabel: string;
}) {
  return (
    <Dialog open={item != null} onOpenChange={(next) => !next && onClose()}>
      {item && (
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-6">
              <MegaphoneIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <span className="min-w-0">{item.title}</span>
            </DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-2 tabular-nums">
              {item.pinned && <Badge variant="info">置顶</Badge>}
              发布于 {formatDateTime(item.publishedAt)}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60dvh] overflow-y-auto">
            <MarkdownView source={item.content} className="text-foreground" />
          </div>
          <DialogFooter>
            <Button onClick={onClose}>{actionLabel}</Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
