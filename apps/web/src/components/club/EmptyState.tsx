import type * as React from 'react';
import { FileQuestionIcon, ShieldAlertIcon, TriangleAlertIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * EmptyState：48–64px 简单线稿 + 标题 + 一句具体原因 + 一个动作。
 * 区分三种情形：空数据 / 无权限 / 加载失败。
 * 权限不足和系统故障不伪装成空列表。
 */
export type EmptyStateKind = 'empty' | 'forbidden' | 'error';

const kindIcon: Record<EmptyStateKind, typeof FileQuestionIcon> = {
  empty: FileQuestionIcon,
  forbidden: ShieldAlertIcon,
  error: TriangleAlertIcon,
};

const defaultTitle: Record<EmptyStateKind, string> = {
  empty: '这里还没有数据',
  forbidden: '当前账号没有查看此内容的权限',
  error: '内容加载失败',
};

const defaultDescription: Record<EmptyStateKind, string> = {
  empty: '记录产生后会出现在这里。',
  forbidden: '如需开通权限，请联系社团管理或指导教师。',
  error: '可能是网络或服务暂时不可用，请重试。',
};

export interface EmptyStateProps {
  kind?: EmptyStateKind;
  title?: string;
  /** 一句具体原因 */
  description?: string;
  /** 一个有用动作（传 Button），最多一个 */
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  kind = 'empty',
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  const Icon = kindIcon[kind];
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      <Icon
        className="size-12 text-input md:size-16"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <div className="flex flex-col gap-1">
        <p className="text-sm leading-[22px] font-semibold text-foreground">
          {title ?? defaultTitle[kind]}
        </p>
        <p className="text-sm leading-[22px] text-muted-foreground">
          {description ?? defaultDescription[kind]}
        </p>
      </div>
      {action != null && <div className="mt-1">{action}</div>}
    </div>
  );
}
