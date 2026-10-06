import { CalendarDaysIcon, CoinsIcon, FileSignatureIcon, HouseIcon, TrophyIcon, UserRoundIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * 手机六项底栏（320–767px）：首页 / 活动 / 竞赛 / 贡献 / 积分 / 我的。
 * - `attendance` 归入“活动”高亮；
 * - `ranking` 归入“积分”高亮（从积分页“榜单”标签进入）；
 * - 标签均为两字，320px 下每项约 53px 可容纳；
 * - 高度 56px + 安全区，固定在底部。
 */

interface MobileNavItem {
  key: string;
  label: string;
  icon: LucideIcon;
  /** 高亮此项的 section 集合 */
  matches: string[];
}

const ITEMS: readonly MobileNavItem[] = [
  { key: 'overview', label: '首页', icon: HouseIcon, matches: ['overview'] },
  { key: 'activities', label: '活动', icon: CalendarDaysIcon, matches: ['activities', 'attendance'] },
  { key: 'contests', label: '竞赛', icon: TrophyIcon, matches: ['contests'] },
  { key: 'contributions', label: '贡献', icon: FileSignatureIcon, matches: ['contributions'] },
  { key: 'points', label: '积分', icon: CoinsIcon, matches: ['points', 'ranking'] },
  { key: 'profile', label: '我的', icon: UserRoundIcon, matches: ['profile'] },
];

export interface MobileNavigationProps {
  currentSection: string;
  onNavigate: (sectionKey: string) => void;
}

export function MobileNavigation({ currentSection, onNavigate }: MobileNavigationProps) {
  return (
    <nav
      data-slot="mobile-navigation"
      aria-label="主导航"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="flex h-14 items-stretch">
        {ITEMS.map((item) => {
          const active = item.matches.includes(currentSection);
          const Icon = item.icon;
          return (
            <li key={item.key} className="flex-1">
              <button
                type="button"
                onClick={() => onNavigate(item.key)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-full w-full flex-col items-center justify-center gap-0.5 rounded-[10px] text-[11px] leading-4 outline-none transition-[color,background-color] duration-150',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon
                  className="size-[18px]"
                  strokeWidth={active ? 2 : 1.75}
                  aria-hidden="true"
                />
                <span className={cn('font-medium', active && 'font-semibold')}>{item.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
