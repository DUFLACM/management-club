import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * PanelSkeleton：与真实业务面板结构一致的卡片级流光骨架。
 * 保留页面标题、主卡、指标卡与列表行的真实边距与边框，避免数据返回后布局跳动。
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
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-40 rounded-lg" />
          <Skeleton className="h-4 w-64 max-w-full rounded-md" />
        </div>
        <Skeleton className="hidden h-9 w-28 rounded-lg sm:block" />
      </div>

      {/* 主卡 + 侧卡 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="flex h-[220px] flex-col justify-between rounded-2xl border border-border bg-card p-5 lg:col-span-8">
          <div className="flex flex-col gap-2.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-10 w-36 rounded-lg" />
            <Skeleton className="h-3.5 w-3/4" />
          </div>
          <div className="flex gap-3">
            <Skeleton className="h-8 w-24 rounded-lg" />
            <Skeleton className="h-8 w-24 rounded-lg" />
          </div>
        </div>
        <div className="hidden h-[220px] flex-col justify-between rounded-2xl border border-border bg-card p-5 lg:col-span-4 lg:flex">
          <Skeleton className="h-4 w-32" />
          <div className="flex flex-col gap-2.5">
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </div>
        </div>
      </div>

      {/* 摘要三卡 */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className={cn(
              'flex h-[120px] flex-col justify-between rounded-2xl border border-border bg-card p-5',
              index > 0 && 'hidden md:flex',
            )}
          >
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-20 rounded-lg" />
            <Skeleton className="h-3 w-36" />
          </div>
        ))}
      </div>

      {/* 列表卡片 */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-8 w-32 rounded-lg" />
        </div>
        <div className="flex flex-col divide-y divide-border">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center justify-between gap-4 py-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-2/5 max-w-xs" />
                <Skeleton className="h-3 w-1/4 max-w-40" />
              </div>
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
