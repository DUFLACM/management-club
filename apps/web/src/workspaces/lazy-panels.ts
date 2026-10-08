import { lazy, type LazyExoticComponent, type ComponentType } from 'react';

/**
 * 面板懒加载注册表（模块顶层声明 React.lazy，配合 SectionRouter 的
 * Suspense + 错误边界；切换 section 时仅挂载当前面板）。
 *
 * 成员端 7 个与管理端 11 个业务面板按需加载；首屏渲染后由 prefetchPanels 在浏览器空闲时
 * 预取其余面板代码，切换导航时不再等待下载（同一个 import() 只会请求一次）。
 */

type LazyPanel = LazyExoticComponent<ComponentType>;
type PanelLoader = () => Promise<{ default: ComponentType }>;

const MEMBER_LOADERS: Readonly<Record<string, PanelLoader>> = {
  overview: () => import('@/workspaces/member/panels/OverviewPanel'),
  activities: () => import('@/workspaces/member/panels/ActivitiesPanel'),
  contests: () => import('@/workspaces/member/panels/ContestsPanel'),
  contributions: () => import('@/workspaces/member/panels/ContributionsPanel'),
  points: () => import('@/workspaces/member/panels/PointsPanel'),
  ranking: () => import('@/workspaces/member/panels/RankingPanel'),
  profile: () => import('@/workspaces/member/panels/ProfilePanel'),
};

const ADMIN_LOADERS: Readonly<Record<string, PanelLoader>> = {
  overview: () => import('@/workspaces/admin/panels/OverviewPanel'),
  members: () => import('@/workspaces/admin/panels/MembersPanel'),
  activities: () => import('@/workspaces/admin/panels/ActivitiesPanel'),
  contests: () => import('@/workspaces/admin/panels/ContestsPanel'),
  teams: () => import('@/workspaces/admin/panels/TeamsPanel'),
  points: () => import('@/workspaces/admin/panels/PointsPanel'),
  evaluation: () => import('@/workspaces/admin/panels/EvaluationPanel'),
  invites: () => import('@/workspaces/admin/panels/InvitesPanel'),
  sync: () => import('@/workspaces/admin/panels/SyncPanel'),
  audit: () => import('@/workspaces/admin/panels/AuditPanel'),
  settings: () => import('@/workspaces/admin/panels/SettingsPanel'),
};

function toLazy(loaders: Readonly<Record<string, PanelLoader>>): Readonly<Record<string, LazyPanel>> {
  return Object.fromEntries(Object.entries(loaders).map(([key, loader]) => [key, lazy(loader)]));
}

/** 成员端 7 个面板（/app?section=…；签到/签出已并入活动详情页） */
export const MemberPanels = toLazy(MEMBER_LOADERS);

/** 管理端 11 个面板（/admin?section=…） */
export const AdminPanels = toLazy(ADMIN_LOADERS);

/**
 * 空闲时逐个预取面板代码（只预取有权限看到的 section）。省流量模式 / 2G 网络下不预取。
 * 返回取消函数，供 useEffect 清理。
 */
export function prefetchPanels(workspace: 'member' | 'admin', keys: readonly string[]): () => void {
  const loaders = workspace === 'member' ? MEMBER_LOADERS : ADMIN_LOADERS;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (connection?.saveData || connection?.effectiveType === '2g' || connection?.effectiveType === 'slow-2g') return () => {};
  const queue = keys.filter((key) => loaders[key]);
  let cancelled = false;
  let handle: number | undefined;
  const idle: (callback: () => void) => number =
    typeof window.requestIdleCallback === 'function'
      ? (callback) => window.requestIdleCallback(callback, { timeout: 3000 })
      : (callback) => window.setTimeout(callback, 1500);
  const next = () => {
    if (cancelled) return;
    const key = queue.shift();
    if (!key) return;
    void loaders[key]!()
      .catch(() => undefined)
      .finally(() => {
        handle = idle(next);
      });
  };
  handle = idle(next);
  return () => {
    cancelled = true;
    if (handle != null) {
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(handle);
      window.clearTimeout(handle);
    }
  };
}

export const MEMBER_DEFAULT_SECTION = 'overview';
export const ADMIN_DEFAULT_SECTION = 'overview';

export const MEMBER_SECTION_KEYS = Object.keys(MemberPanels) as readonly string[];
export const ADMIN_SECTION_KEYS = Object.keys(AdminPanels) as readonly string[];
