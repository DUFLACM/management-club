/**
 * 个人事件通知中心（顶栏铃铛按钮，紧邻全员公告）：
 * - 聚合审批结果（请假 / 远程 / 贡献 / 训练室）、申诉处理回复、新获徽标等定向通知；
 * - 未读角标实时展示，支持单条点击已读并跳转到对应业务页，支持一键全部已读。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellIcon, CheckCheckIcon, ChevronRightIcon } from 'lucide-react';

import { api } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrincipal } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/club/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface NotificationItemDto {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

interface NotificationListDto {
  items: NotificationItemDto[];
  unreadCount: number;
}

const KIND_LABELS: Record<string, string> = {
  leave_decision: '请假审批',
  remote_decision: '远程审批',
  appeal_decision: '积分申诉',
  claim_decision: '贡献申报',
  room_booking: '训练室',
  badge_awarded: '徽标',
  platform_review: '平台账号',
  general: '通知',
};

export function NotificationCenter() {
  const principal = usePrincipal();
  const principalId = principal?.authenticated ? principal.principalId : null;
  const hasUserProfile = Boolean(principal?.authenticated && principal.userId);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const query = usePrivateQuery<NotificationListDto>(
    hasUserProfile ? principalId : null,
    ['me', 'notifications'],
    async () => (await api.get<NotificationListDto>('/me/notifications')).data,
    { staleTime: 30_000, refetchInterval: 60_000 },
  );

  const items = query.data?.items ?? [];
  const unreadCount = query.data?.unreadCount ?? 0;

  const markOneMutation = useMutation({
    mutationFn: (id: string) => api.post(`/me/notifications/${id}/read`),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<NotificationListDto>(
        ['principal', principalId ?? 'anonymous', 'me', 'notifications'],
        (previous) => {
          if (!previous) return previous;
          let decremented = 0;
          const nextItems = previous.items.map((item) => {
            if (item.id === id && !item.read) {
              decremented = 1;
              return { ...item, read: true, readAt: new Date().toISOString() };
            }
            return item;
          });
          return {
            items: nextItems,
            unreadCount: Math.max(0, previous.unreadCount - decremented),
          };
        },
      );
    },
  });

  const markAllMutation = useMutation({
    mutationFn: () => api.post('/me/notifications/read-all'),
    onSuccess: () => {
      queryClient.setQueryData<NotificationListDto>(
        ['principal', principalId ?? 'anonymous', 'me', 'notifications'],
        (previous) =>
          previous
            ? {
                items: previous.items.map((item) => ({ ...item, read: true, readAt: item.readAt ?? new Date().toISOString() })),
                unreadCount: 0,
              }
            : previous,
      );
    },
  });

  if (!hasUserProfile) return null;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="relative"
        aria-label={unreadCount > 0 ? `消息通知，${unreadCount} 条未读` : '消息通知'}
        onClick={() => {
          setOpen(true);
          void query.refetch();
        }}
      >
        <BellIcon aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute top-1.5 right-1.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <div className="flex items-center justify-between gap-2 pr-6">
              <div>
                <DialogTitle>个人消息通知</DialogTitle>
                <DialogDescription>审批结果、申诉回复与个人动态会在这里提醒。</DialogDescription>
              </div>
              {unreadCount > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={markAllMutation.isPending}
                  onClick={() => markAllMutation.mutate()}
                >
                  <CheckCheckIcon aria-hidden="true" />
                  全部已读
                </Button>
              )}
            </div>
          </DialogHeader>

          {items.length === 0 ? (
            <EmptyState kind="empty" title="暂无个人通知" description="有审批结果、申诉回复或新徽标时会展示在这里。" />
          ) : (
            <ul className="-mx-2 flex max-h-[60dvh] flex-col divide-y divide-border overflow-y-auto">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={cn(
                      'flex w-full items-start gap-3 rounded-xl px-2.5 py-3 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
                      !item.read && 'bg-primary/[0.03]',
                    )}
                    onClick={() => {
                      if (!item.read) markOneMutation.mutate(item.id);
                      if (item.link) {
                        setOpen(false);
                        navigate(item.link);
                      }
                    }}
                  >
                    <span
                      className={cn(
                        'mt-2 size-2 shrink-0 rounded-full',
                        item.read ? 'bg-transparent' : 'bg-primary',
                      )}
                      aria-hidden="true"
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                          {KIND_LABELS[item.kind] ?? '通知'}
                        </Badge>
                        <span className={cn('text-sm', item.read ? 'text-foreground' : 'font-semibold text-foreground')}>
                          {item.title}
                        </span>
                      </span>
                      <span className="text-xs leading-5 text-muted-foreground">{item.body}</span>
                      <span className="text-[11px] text-muted-foreground/80 tabular-nums">
                        {formatDateTime(item.createdAt)}
                      </span>
                    </span>
                    {item.link && (
                      <ChevronRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
