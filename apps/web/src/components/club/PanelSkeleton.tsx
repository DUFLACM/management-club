import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * PanelSkeleton：与最终面板尺寸相近的加载骨架。
 * 结构：标题行 → 大卡（240px 级）→ 两/三张窄卡 → 列表行。
 * 静态骨架，避免数据返回后高度跳动。
 */
export function PanelSkeleton({ className }: { className?: string }) {
  return (
    <div
      data-slot="panel-skeleton"
      aria-busy="true"
      aria-live="polite"
      className={cn('flex flex-col gap-4', className)}
    >
      {/* 页面标题行 */}
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-56 max-w-full" />
        </div>
        <Skeleton className="hidden h-10 w-28 sm:block" />
      </div>
      {/* 欢迎主卡 + 窄卡 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Skeleton className="h-[240px] rounded-2xl lg:col-span-8" />
        <Skeleton className="hidden h-[240px] rounded-2xl lg:col-span-4 lg:block" />
      </div>
      {/* 摘要三卡 */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Skeleton className="h-[136px] rounded-2xl" />
        <Skeleton className="hidden h-[136px] rounded-2xl md:block" />
        <Skeleton className="hidden h-[136px] rounded-2xl md:block" />
      </div>
      {/* 列表区 */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-14 w-full rounded-lg" />
        <Skeleton className="h-14 w-full rounded-lg" />
        <Skeleton className="h-14 w-full rounded-lg" />
      </div>
    </div>
  );
}
