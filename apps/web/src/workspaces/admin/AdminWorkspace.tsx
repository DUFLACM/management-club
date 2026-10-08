import { useCallback, useEffect } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { hasAnyAction } from '@/lib/session';
import { useWorkspaceSession } from '@/lib/workspace-session';
import { EmptyState } from '@/components/club/EmptyState';
import {
  CalendarDaysIcon,
  CoinsIcon,
  GraduationCapIcon,
  LayoutDashboardIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  SettingsIcon,
  TicketIcon,
  TrophyIcon,
  UsersIcon,
  UsersRoundIcon,
  LoaderCircleIcon,
} from 'lucide-react';

import {
  AdminPanels,
  ADMIN_DEFAULT_SECTION,
  prefetchPanels,
} from '@/workspaces/lazy-panels';
import { resolveSection, SectionRouter } from '@/workspaces/shared/SectionRouter';
import { PlatformBindingGate } from '@/components/club/PlatformBindingGate';
import {
  WorkspaceShell,
  type WorkspaceSection,
  type WorkspaceUser,
} from '@/workspaces/shared/WorkspaceShell';

/**
 * 管理工作台（/admin）。
 * - 顶栏明确“管理工作台”与当前授权角色，避免与成员端混淆；
 * - section/tab 来自 URL query（白名单解析，非法值回 overview）；
 *   面板内子标签（如 activities 的 venues、现场码显示模式）由面板自读 searchParams；
 * - 手机端使用顶部菜单按钮 + 导航 Sheet，不挤入成员六项底栏。
 */

export const ADMIN_SECTIONS: readonly WorkspaceSection[] = [
  { key: 'overview', title: '概览', icon: LayoutDashboardIcon },
  { key: 'members', title: '成员', icon: UsersIcon },
  { key: 'activities', title: '活动', icon: CalendarDaysIcon },
  { key: 'contests', title: '赛事', icon: TrophyIcon },
  { key: 'teams', title: '组队', icon: UsersRoundIcon },
  { key: 'points', title: '积分审核', icon: CoinsIcon },
  { key: 'evaluation', title: '综评导出', icon: GraduationCapIcon },
  { key: 'invites', title: '邀请码', icon: TicketIcon },
  { key: 'sync', title: '平台同步', icon: RefreshCwIcon },
  { key: 'audit', title: '审计', icon: ScrollTextIcon },
  { key: 'settings', title: '设置', icon: SettingsIcon },
];

const SECTION_ACTIONS: Record<string, string[]> = {
  members: ['members.read', 'members.review'],
  activities: ['activity.manage', 'venue.manage'],
  contests: ['competitions.manage'],
  teams: ['competitions.manage'],
  points: ['points.review'],
  evaluation: ['evaluation.manage'],
  invites: ['invitations.manage'],
  sync: ['sync.manage'],
  audit: ['audit.read'],
  settings: ['settings.manage'],
};

export interface AdminWorkspaceProps {
  user?: WorkspaceUser;
}

export function AdminWorkspace({ user: providedUser }: AdminWorkspaceProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const session = useWorkspaceSession();
  const user = providedUser ?? session.user;
  const isManager = user.roles.some((role) =>
    ['activity_manager', 'points_reviewer', 'presidium', 'advisor', 'system_admin'].includes(role),
  );
  const sections = isManager ? ADMIN_SECTIONS.filter((section) =>
    section.key === 'overview' || hasAnyAction(user.roles, SECTION_ACTIONS[section.key] ?? []),
  ) : [];

  const currentSection = resolveSection(
    searchParams.get('section'),
    sections.map((section) => section.key),
    ADMIN_DEFAULT_SECTION,
  );

  // 只预取有权限看到的面板代码
  const sectionKeys = sections.map((section) => section.key).join(',');
  useEffect(() => {
    if (!sectionKeys) return;
    return prefetchPanels('admin', sectionKeys.split(','));
  }, [sectionKeys]);

  const handleNavigate = useCallback(
    (sectionKey: string) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams();
          if (sectionKey !== ADMIN_DEFAULT_SECTION) next.set('section', sectionKey);
          else if (previous.get('section') === sectionKey) return previous;
          // 切换面板时丢弃旧面板的 tab 等局部参数
          return next;
        },
        { replace: false },
      );
    },
    [setSearchParams],
  );

  if (session.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background px-4 text-sm text-muted-foreground" role="status">
        <LoaderCircleIcon className="mr-2 animate-spin" aria-hidden="true" />
        正在确认管理员登录状态…
      </div>
    );
  }

  if (!session.principal?.authenticated) {
    return <Navigate to="/admin/login" replace />;
  }

  return (
    <PlatformBindingGate principal={session.principal}>
      <WorkspaceShell
        variant="admin"
        currentSection={currentSection}
        sections={sections}
        onNavigate={handleNavigate}
        user={user}
      >
        {isManager ? (
          <SectionRouter
            currentSection={currentSection}
            panels={AdminPanels}
            defaultSection={ADMIN_DEFAULT_SECTION}
          />
        ) : (
          <EmptyState kind="forbidden" title="暂无管理权限" description="当前账号没有管理工作台授权。" />
        )}
      </WorkspaceShell>
    </PlatformBindingGate>
  );
}
