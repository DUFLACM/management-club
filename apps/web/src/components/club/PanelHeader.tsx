import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * PanelHeader：页面内标题区。
 * 桌面 28px/36px 600、手机 22px/30px；附一句说明与右侧动作区。
 * 顶栏已显示工作区与面板名，这里不再堆面包屑。
 */
export interface PanelHeaderProps {
  title: string;
  description?: string;
  /** 右侧动作区（主按钮等），手机自动换行到标题下方 */
  actions?: React.ReactNode;
  className?: string;
}

export function PanelHeader({ title, description, actions, className }: PanelHeaderProps) {
  return (
    <header
      data-slot="panel-header"
      className={cn('flex flex-col gap-3 md:flex-row md:items-start md:justify-between', className)}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-[22px] leading-[30px] font-semibold text-foreground md:text-[28px] md:leading-9">
          {title}
        </h1>
        {description && (
          <p className="text-sm leading-[22px] text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
