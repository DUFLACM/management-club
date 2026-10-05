import * as React from 'react';

import { cn } from '@/lib/utils';

/** 静态骨架：保留最终尺寸/列数，不使用大面积闪烁或扫光。 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}

export { Skeleton };
