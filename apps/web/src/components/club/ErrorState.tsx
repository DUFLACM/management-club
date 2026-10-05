import type * as React from 'react';
import { RotateCcwIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/club/EmptyState';

/**
 * ErrorState：加载/渲染失败的统一呈现。关键错误持续可见，
 * toast 只作补充；提供真实“重试”动作。
 */
export interface ErrorStateProps {
  title?: string;
  description?: string;
  /** 重试回调；不提供时仅展示错误说明 */
  onRetry?: () => void;
  retrying?: boolean;
  /** 附加的错误详情（如 requestId），折叠展示由调用方决定 */
  detail?: React.ReactNode;
}

export function ErrorState({
  title,
  description,
  onRetry,
  retrying = false,
  detail,
}: ErrorStateProps) {
  return (
    <EmptyState
      kind="error"
      title={title}
      description={description}
      action={
        <div className="flex flex-col items-center gap-2">
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
              <RotateCcwIcon aria-hidden="true" />
              {retrying ? '正在重试' : '重试'}
            </Button>
          )}
          {detail}
        </div>
      }
    />
  );
}
