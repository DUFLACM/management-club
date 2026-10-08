import * as React from 'react';
import { Tabs as TabsPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

/**
 * 区域内下划线样式；当前项主蓝。手机可容器内横向滚动。
 * 只允许横向滑动：overflow-x 非 visible 时浏览器会把 y 轴也算作可滚动，触发项 -mb-px
 * 溢出 1px 就能被上下拖动——锁死 y 轴、触控只走横向平移，并隐藏滚动条。
 * 底线改用内阴影绘制（不占盒子），选中项的下划线直接盖在上面，不再需要负外边距溢出。
 */

const Tabs = TabsPrimitive.Root;

function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'inline-flex w-full items-center gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain touch-pan-x shadow-[inset_0_-1px_0_var(--color-border)] text-muted-foreground',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground outline-none transition-[color,border-color] duration-150',
        'hover:text-foreground',
        'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        'data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:font-semibold',
        'disabled:pointer-events-none disabled:opacity-50',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('min-w-0 outline-none flex-1', className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
