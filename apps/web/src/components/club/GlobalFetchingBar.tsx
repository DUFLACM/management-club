/**
 * 顶栏全局加载进度条 + 手动刷新按钮：
 * - 基于 TanStack Query 的 useIsFetching() 自动感应任意面板的数据加载与后台刷新；
 * - 120ms 防抖避免缓存秒回时闪动；点击刷新按钮会平滑刷新当前页全部活跃查询并给出旋转与完成反馈。
 */
import { useEffect, useState } from 'react';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, RefreshCwIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export function GlobalFetchingBar() {
  const fetching = useIsFetching();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (fetching > 0) {
      const timer = window.setTimeout(() => setVisible(true), 120);
      return () => window.clearTimeout(timer);
    }
    const hideTimer = window.setTimeout(() => setVisible(false), 180);
    return () => window.clearTimeout(hideTimer);
  }, [fetching]);

  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden transition-opacity duration-200',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      <div className="club-progress-bar h-full w-1/2 rounded-full bg-gradient-to-r from-primary/20 via-primary to-primary/20" />
    </div>
  );
}

export function GlobalRefreshButton() {
  const queryClient = useQueryClient();
  const fetching = useIsFetching();
  const [justDone, setJustDone] = useState(false);
  const [manualPending, setManualPending] = useState(false);

  const handleRefresh = async () => {
    if (manualPending) return;
    setManualPending(true);
    setJustDone(false);
    try {
      await queryClient.invalidateQueries({ type: 'active' });
      setJustDone(true);
      window.setTimeout(() => setJustDone(false), 1200);
    } finally {
      setManualPending(false);
    }
  };

  const spinning = manualPending || fetching > 0;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="刷新当前页面数据"
      title="刷新当前页面数据"
      disabled={manualPending}
      onClick={() => void handleRefresh()}
      className="relative"
    >
      {justDone && !spinning ? (
        <CheckIcon className="size-[18px] text-success transition-transform duration-150" aria-hidden="true" />
      ) : (
        <RefreshCwIcon
          className={cn(
            'size-[18px] transition-transform duration-200',
            spinning && 'animate-spin text-primary',
          )}
          aria-hidden="true"
        />
      )}
    </Button>
  );
}
