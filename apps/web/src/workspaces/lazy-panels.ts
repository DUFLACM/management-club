import { lazy, type LazyExoticComponent, type ComponentType } from 'react';

/**
 * 面板懒加载注册表（模块顶层声明 React.lazy，配合 SectionRouter 的
 * Suspense + 错误边界；切换 section 时仅加载/挂载当前面板）。
 *
 * 成员端 7 个与管理端 10 个业务面板按需加载；规则面板为本地只读参考。
 */

type LazyPanel = LazyExoticComponent<ComponentType>;

/** 成员端 7 个面板（/app?section=…） */
export const MemberPanels: Readonly<Record<string, LazyPanel>> = {
  overview: lazy(() => import('@/workspaces/member/panels/OverviewPanel')),
  activities: lazy(() => import('@/workspaces/member/panels/ActivitiesPanel')),
  attendance: lazy(() => import('@/workspaces/member/panels/AttendancePanel')),
  contests: lazy(() => import('@/workspaces/member/panels/ContestsPanel')),
  points: lazy(() => import('@/workspaces/member/panels/PointsPanel')),
  ranking: lazy(() => import('@/workspaces/member/panels/RankingPanel')),
  profile: lazy(() => import('@/workspaces/member/panels/ProfilePanel')),
};

/** 管理端 10 个面板（/admin?section=…） */
export const AdminPanels: Readonly<Record<string, LazyPanel>> = {
  overview: lazy(() => import('@/workspaces/admin/panels/OverviewPanel')),
  members: lazy(() => import('@/workspaces/admin/panels/MembersPanel')),
  activities: lazy(() => import('@/workspaces/admin/panels/ActivitiesPanel')),
  contests: lazy(() => import('@/workspaces/admin/panels/ContestsPanel')),
  points: lazy(() => import('@/workspaces/admin/panels/PointsPanel')),
  rules: lazy(() => import('@/workspaces/admin/panels/RulesPanel')),
  invites: lazy(() => import('@/workspaces/admin/panels/InvitesPanel')),
  sync: lazy(() => import('@/workspaces/admin/panels/SyncPanel')),
  audit: lazy(() => import('@/workspaces/admin/panels/AuditPanel')),
  settings: lazy(() => import('@/workspaces/admin/panels/SettingsPanel')),
};

export const MEMBER_DEFAULT_SECTION = 'overview';
export const ADMIN_DEFAULT_SECTION = 'overview';

export const MEMBER_SECTION_KEYS = Object.keys(MemberPanels) as readonly string[];
export const ADMIN_SECTION_KEYS = Object.keys(AdminPanels) as readonly string[];
