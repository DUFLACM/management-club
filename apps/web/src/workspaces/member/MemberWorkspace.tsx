import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { useWorkspaceSession } from '@/lib/workspace-session';
import { AuthWorkspaceEntry } from '@/workspaces/shared/AuthWorkspaceEntry';
import {
  CalendarDaysIcon,
  CoinsIcon,
  FileSignatureIcon,
  LayoutDashboardIcon,
  LoaderCircleIcon,
  ListOrderedIcon,
  TrophyIcon,
  UserRoundIcon,
} from 'lucide-react';

import {
  MemberPanels,
  MEMBER_DEFAULT_SECTION,
  MEMBER_SECTION_KEYS,
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
 * 成员工作台（/app）。
 * - section/tab 均来自 URL query（白名单解析，非法值回 overview）；
 * - 面板内部子标签（tab）由各面板自行读取 searchParams；
 * - 导航通过 setSearchParams 写 URL，浏览器后退/前进由 react-router 统一处理。
 * - 签到/签出已并入活动详情页（section=attendance 旧链接自动重定向，保留 id 参数）；
 * - 竞赛与贡献已拆为两个 section（contests&tab=claims 旧链接自动重定向到 contributions）。
 */

/** 成员导航顺序：概览、活动、竞赛、贡献、积分、榜单、我的 */
export const MEMBER_SECTIONS: readonly WorkspaceSection[] = [
  { key: 'overview', title: '概览', icon: LayoutDashboardIcon },
  { key: 'activities', title: '活动', icon: CalendarDaysIcon },
  { key: 'contests', title: '竞赛', icon: TrophyIcon },
  { key: 'contributions', title: '贡献', icon: FileSignatureIcon },
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

  // 旧「签到与出勤」面板已并入活动详情：section=attendance&id=X → activities&activity=X（保留 #q= 深链）
  useEffect(() => {
    if (searchParams.get('section') !== 'attendance') return;
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        const legacyId = next.get('id');
        next.delete('id');
        next.set('section', 'activities');
        if (legacyId) next.set('activity', legacyId);
        else next.delete('activity');
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);

  // 贡献申报已拆出独立 section：contests&tab=claims → contributions
  useEffect(() => {
    if (searchParams.get('section') !== 'contests' || searchParams.get('tab') !== 'claims') return;
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete('tab');
        next.set('section', 'contributions');
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);

  // 登录后在空闲时预取其余面板代码，切换导航不再等下载
  const authenticated = session.principal?.authenticated === true;
  useEffect(() => {
    if (!authenticated) return;
    return prefetchPanels('member', MEMBER_SECTION_KEYS);
  }, [authenticated]);

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
    <PlatformBindingGate principal={session.principal}>
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
    </PlatformBindingGate>
  );
}
