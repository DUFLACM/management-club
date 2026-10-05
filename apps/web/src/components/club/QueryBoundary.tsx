/**
 * QueryBoundary：统一查询四态呈现。
 * loading → PanelSkeleton；失败 → ErrorState（重试）；FORBIDDEN → EmptyState forbidden；
 * 其余交给 children(data)。空态由 isEmpty 钩子判定后渲染 emptyNode。
 */
import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';

import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { EmptyState } from '@/components/club/EmptyState';
import { ErrorState } from '@/components/club/ErrorState';
import { PanelSkeleton } from '@/components/club/PanelSkeleton';
import type { CsrfSession } from '@/lib/session';

export interface QueryBoundaryProps<T> {
  query: UseQueryResult<T, ApiError>;
  children: (data: T) => ReactNode;
  /** 判空；命中时渲染 emptyNode（默认 EmptyState empty） */
  isEmpty?: (data: T) => boolean;
  emptyNode?: ReactNode;
  skeleton?: ReactNode;
  className?: string;
}

export function QueryBoundary<T>({
  query,
  children,
  isEmpty,
  emptyNode,
  skeleton,
  className,
}: QueryBoundaryProps<T>) {
  if (query.isPending) {
    return <div className={className}>{skeleton ?? <PanelSkeleton />}</div>;
  }
  if (query.isError) {
    const error = query.error;
    if (error instanceof ApiError && (error.code === 'FORBIDDEN' || error.status === 403)) {
      return (
        <div className={className}>
          <EmptyState kind="forbidden" description={error.message} />
        </div>
      );
    }
    return (
      <div className={className}>
        <ErrorState
          description={error.message}
          onRetry={() => {
            void query.refetch();
          }}
          retrying={query.isFetching}
        />
      </div>
    );
  }
  const data = query.data;
  if (isEmpty?.(data)) {
    return <div className={className}>{emptyNode ?? <EmptyState kind="empty" />}</div>;
  }
  return <div className={cn('min-w-0', className)}>{children(data)}</div>;
}

/**
 * PrincipalGate：会话就绪前的统一占位。
 * principal 为 null（会话加载中）→ PanelSkeleton；
 * authenticated false → 登录提示（EmptyState forbidden + /login 动作）；
 * 已登录 → render(principalId)。
 */
export function PrincipalGate({
  principal,
  children,
}: {
  principal: Pick<CsrfSession, 'authenticated' | 'principalId'> | null;
  children: (principalId: string) => ReactNode;
}) {
  if (!principal) return <PanelSkeleton />;
  if (!principal.authenticated || !principal.principalId) {
    return (
      <EmptyState
        kind="forbidden"
        title="请先登录"
        description="使用校园 CAS 账号登录后即可查看此面板。"
        action={
          <a
            href="/login"
            className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            前往登录
          </a>
        }
      />
    );
  }
  return <>{children(principal.principalId)}</>;
}

/**
 * 学生成员资源必须绑定 userId。staff principal 可以进入授权管理面板，
 * 但不能借 principalId 冒充学生读取成员端资料。
 */
export function MemberGate({
  principal,
  children,
}: {
  principal: Pick<CsrfSession, 'authenticated' | 'principalId' | 'userId'> | null;
  children: (userId: string) => ReactNode;
}) {
  if (!principal) return <PanelSkeleton />;
  if (!principal.authenticated || !principal.principalId) {
    return (
      <EmptyState
        kind="forbidden"
        title="请先登录"
        description="使用校园 CAS 账号登录后即可查看此面板。"
        action={
          <a
            href="/login"
            className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            前往登录
          </a>
        }
      />
    );
  }
  if (!principal.userId) {
    return (
      <EmptyState
        kind="forbidden"
        title="仅协会成员可使用"
        description="当前校园账号未绑定学生成员记录；指导教师请前往管理工作台。"
        action={
          <a
            href="/admin"
            className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            前往管理工作台
          </a>
        }
      />
    );
  }
  return <>{children(principal.userId)}</>;
}
