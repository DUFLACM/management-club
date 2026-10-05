import { Link } from 'react-router';
import { cn } from '@/lib/utils';

/** 学校提供的校名标识保持原比例；深色主题使用浅色单色版本。 */
export function UniversityBrand({ className, stacked = false, compact = false }: { className?: string; stacked?: boolean; compact?: boolean }) {
  if (compact) {
    return (
      <Link to="/app" aria-label="返回首页" className={cn('flex min-w-0 items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4', className)}>
        <img src="/brand/nav-logo-dark.png" alt="大连外国语大学" width={595} height={128} className="h-auto w-[148px] shrink-0 min-[375px]:w-[172px] dark:brightness-0 dark:invert dark:opacity-90" />
        <span className="flex shrink-0 flex-col gap-0.5 border-l border-border pl-3">
          <span className="text-[13px] leading-4 font-semibold tracking-wide text-primary">ACM</span>
          <span className="text-[9px] leading-3 tracking-wide text-muted-foreground">算法协会</span>
        </span>
      </Link>
    );
  }
  return (
    <Link to="/app" aria-label="返回首页" className={cn('flex min-w-0 items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4', stacked ? 'flex-col gap-4 text-center' : 'flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-5', className)}>
      <img
        src="/brand/nav-logo-dark.png"
        alt="大连外国语大学"
        width={595}
        height={128}
        className={cn('h-auto shrink-0 dark:brightness-0 dark:invert dark:opacity-90', stacked ? 'w-[240px] max-w-full' : 'w-[188px] sm:w-[248px]')}
      />
      <span aria-hidden="true" className={cn('bg-border', stacked ? 'h-px w-10' : 'hidden h-8 w-px sm:block')} />
      <span className={cn('flex items-baseline gap-2 whitespace-nowrap', stacked && 'gap-2.5')}>
        <span className={cn('font-semibold tracking-tight text-primary', stacked ? 'text-2xl' : 'text-sm sm:text-xl')}>ACM</span>
        <span className={cn('font-medium tracking-[0.08em] text-foreground', stacked ? 'text-sm' : 'text-[11px] sm:text-sm')}>算法协会</span>
      </span>
    </Link>
  );
}
