import { useEffect, useState } from 'react';
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * 主题切换：浅色 / 深色 / 跟随系统 三态。
 * - 通过切换 html 上的 .dark 类生效（@custom-variant dark）；
 * - 仅主题偏好允许持久化（localStorage 键 club-theme）；
 * - “跟随系统”时监听系统变化实时切换；初始未选择时为浅色。
 */

export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'club-theme';

export function applyThemeMode(mode: ThemeMode): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = mode === 'dark' || (mode === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', dark);
}

function readStoredMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    /* 隐私模式等无 localStorage 环境保持默认 */
  }
  return 'light';
}

export function ThemeToggle({ className }: { className?: string } = {}) {
  const [mode, setMode] = useState<ThemeMode>(readStoredMode);

  useEffect(() => {
    applyThemeMode(mode);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      /* 持久化失败时仅本次会话生效 */
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyThemeMode('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [mode]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={className} aria-label="切换主题">
          {mode === 'dark' ? (
            <MoonIcon aria-hidden="true" />
          ) : mode === 'light' ? (
            <SunIcon aria-hidden="true" />
          ) : (
            <MonitorIcon aria-hidden="true" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>主题外观</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value) => setMode(value as ThemeMode)}
        >
          <DropdownMenuRadioItem value="light">
            <SunIcon aria-hidden="true" />
            浅色
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <MoonIcon aria-hidden="true" />
            深色
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <MonitorIcon aria-hidden="true" />
            跟随系统
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
