import * as React from 'react';

import { cn } from '@/lib/utils';

/** 流光骨架屏：保留最终尺寸/列数，细腻平滑扫光，自动兼容深浅主题与减少动效偏好。 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('club-skeleton rounded-md', className)}
      {...props}
    />
  );
}

export { Skeleton };
