import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { useWorkspaceSession } from '@/lib/workspace-session';
import { AuthWorkspaceEntry } from '@/workspaces/shared/AuthWorkspaceEntry';
import {
  CalendarDaysIcon,
  CoinsIcon,
  LayoutDashboardIcon,
  LoaderCircleIcon,
  ListOrderedIcon,
  ScanLineIcon,
  TrophyIcon,
  UserRoundIcon,
} from 'lucide-react';

import {
  MemberPanels,
  MEMBER_DEFAULT_SECTION,
  MEMBER_SECTION_KEYS,
} from '@/workspaces/lazy-panels';
import { resolveSection, SectionRouter } from '@/workspaces/shared/SectionRouter';
import {
  WorkspaceShell,
  type WorkspaceSection,
  type WorkspaceUser,
} from '@/workspaces/shared/WorkspaceShell';

/**
 * 成员工作台（/app）。
 * - section/tab 均来自 URL query（白名单解析，非法值回 overview）；
 * - 面板内部子标签（tab）由各面板自行读取 searchParams；
 * - 导航通过 setSearchParams 写 URL，浏览器后退/前进由 react-router 统一处理。
 */

/** 成员导航顺序：概览、活动、签到与出勤、竞赛与贡献、积分、榜单、我的 */
export const MEMBER_SECTIONS: readonly WorkspaceSection[] = [
  { key: 'overview', title: '概览', icon: LayoutDashboardIcon },
  { key: 'activities', title: '活动', icon: CalendarDaysIcon },
  { key: 'attendance', title: '签到与出勤', icon: ScanLineIcon },
  { key: 'contests', title: '竞赛与贡献', icon: TrophyIcon },
  { key: 'points', title: '积分', icon: CoinsIcon },
  { key: 'ranking', title: '榜单', icon: ListOrderedIcon },
  { key: 'profile', title: '我的', icon: UserRoundIcon },
];

export interface MemberWorkspaceProps {
  user?: WorkspaceUser;
  /** 是否展示“管理工作台”入口（仅入口；API 仍独立鉴权） */
  manageAccess?: boolean;
}

export function MemberWorkspace({ user: providedUser, manageAccess }: MemberWorkspaceProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const session = useWorkspaceSession();
  const user = providedUser ?? session.user;
  const canManage = manageAccess ?? user.roles.some((role) =>
    ['activity_manager', 'points_reviewer', 'presidium', 'advisor', 'system_admin'].includes(role),
  );

  const currentSection = resolveSection(
    searchParams.get('section'),
    MEMBER_SECTION_KEYS,
    MEMBER_DEFAULT_SECTION,
  );

  const handleNavigate = useCallback(
    (sectionKey: string) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams();
          // 默认面板保持 URL 干净；非默认面板写入 section
          if (sectionKey !== MEMBER_DEFAULT_SECTION) next.set('section', sectionKey);
          else if (previous.get('section') === sectionKey) return previous;
          // 切换面板时丢弃旧面板的 tab/detail 等局部参数
          return next;
        },
        { replace: false },
      );
    },
    [setSearchParams],
  );

  // 身份尚未确定时只展示加载状态，避免已登录用户先看到匿名欢迎首页。
  if (session.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background px-4 text-sm text-muted-foreground" role="status">
        <LoaderCircleIcon className="mr-2 animate-spin" aria-hidden="true" />
        正在确认登录状态…
      </div>
    );
  }

  if (!session.principal?.authenticated) {
    return <AuthWorkspaceEntry loading={false} error={session.error?.message} onRetry={() => void session.refetch()} />;
  }

  return (
    <WorkspaceShell
      variant="member"
      currentSection={currentSection}
      sections={MEMBER_SECTIONS}
      onNavigate={handleNavigate}
      user={user}
      manageAccess={canManage}
    >
      <SectionRouter
        currentSection={currentSection}
        panels={MemberPanels}
        defaultSection={MEMBER_DEFAULT_SECTION}
      />
    </WorkspaceShell>
  );
}
