/**
 * 面板通用小工具：媒体查询、防抖值、分页加载更多。
 */
import { useEffect, useState } from 'react';
import { ChevronDownIcon, LoaderCircleIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export function useDebouncedValue<T>(value: T, delay = 400): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** 游标分页「加载更多」：.hasNext 由调用方计算（nextCursor != null）。 */
export function LoadMoreButton({
  onClick,
  loading,
  hasNext,
  hint = '没有更多了',
}: {
  onClick: () => void;
  loading: boolean;
  hasNext: boolean;
  hint?: string;
}) {
  if (!hasNext) {
    return (
      <p className="py-3 text-center text-sm text-muted-foreground" aria-live="polite">
        {hint}
      </p>
    );
  }
  return (
    <div className="flex justify-center py-2">
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          if (!loading) onClick();
        }}
        disabled={loading}
        className="min-w-32"
      >
        {loading ? (
          <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
        ) : (
          <ChevronDownIcon aria-hidden="true" />
        )}
        {loading ? '正在加载' : '加载更多'}
      </Button>
    </div>
  );
}
