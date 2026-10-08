import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { LucideIcon } from 'lucide-react';
import {
  ChevronsLeftIcon,
  ChevronsRightIcon,
  ChevronsUpDownIcon,
  KeyRoundIcon,
  LogOutIcon,
  MenuIcon,
  ShieldCheckIcon,
  UserRoundIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { api, resetCsrfToken } from '@/lib/api';
import { SESSION_CHANGED_EVENT } from '@/lib/query';
import { ClubMark } from '@/components/club/ClubMark';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { ThemeToggle } from '@/workspaces/shared/ThemeToggle';
import { MobileNavigation } from '@/workspaces/shared/MobileNavigation';
import { ChangePasswordDialog } from '@/workspaces/shared/ChangePasswordDialog';

/**
 * 统一工作台外框。
 *
 * - ≥1024px：232px 侧栏 + 64px 顶栏，内容 max-width 1440px、padding 32px；
 * - 768–1023px：72px 图标侧栏，可展开为 232px 浮层，不压缩内容区；
 * - 320–767px：56px 顶栏 + 56px 加安全区的六项底栏（成员端）；
 *   管理端手机使用顶栏菜单按钮 + 导航 Sheet。
 * - 选中项：淡蓝底、蓝字、左侧 3px 标记、圆角 10px；
 * - 内容容器 min-w-0，避免表格/长字段撑破布局。
 */

export interface WorkspaceSection {
  key: string;
  title: string;
  icon: LucideIcon;
  /** 实际待办数量徽标（仅承载真实数量） */
  badge?: number;
}

export interface WorkspaceUser {
  displayName: string;
  avatarText: string;
  avatarAssetId: string | null;
  principalKind: string | null;
  membershipLabel: string;
  roles: string[];
}

export interface WorkspaceShellProps {
  variant: 'member' | 'admin';
  currentSection: string;
  sections: readonly WorkspaceSection[];
  onNavigate: (sectionKey: string) => void;
  user: WorkspaceUser;
  headerRight?: ReactNode;
  /** 当前账号是否有管理入口权限；仅控制入口展示，API 仍独立鉴权 */
  manageAccess?: boolean;
  children: ReactNode;
}

function isActive(section: WorkspaceSection, current: string): boolean {
  return section.key === current;
}

const ROLE_LABELS: Record<string, string> = {
  member: '成员',
  activity_manager: '活动负责人',
  points_reviewer: '积分审核员',
  presidium: '主席团',
  advisor: '指导教师',
  system_admin: '系统管理员',
};

function roleLabels(roles: string[]): string {
  return roles.map((role) => ROLE_LABELS[role] ?? role).join(' / ');
}

function navigationGroups(variant: 'member' | 'admin', sections: readonly WorkspaceSection[]) {
  const groups = variant === 'member'
    ? [
      { label: '训练室', keys: ['overview', 'activities', 'attendance', 'contests', 'contributions'] },
      { label: '积分与资料', keys: ['points', 'ranking', 'profile'] },
    ]
    : [
      { label: '业务管理', keys: ['overview', 'members', 'activities', 'contests', 'points', 'evaluation'] },
      { label: '系统与授权', keys: ['invites', 'sync', 'audit', 'settings'] },
    ];
  const grouped = groups.map((group) => ({
    label: group.label,
    sections: sections.filter((section) => group.keys.includes(section.key)),
  }));
  // 未列入任何分组的 section 归入最后一组，避免新增 section 在侧边栏静默消失
  const known = new Set(groups.flatMap((group) => group.keys));
  const ungrouped = sections.filter((section) => !known.has(section.key));
  const last = grouped.at(-1);
  if (last && ungrouped.length > 0) last.sections = [...last.sections, ...ungrouped];
  return grouped.filter((group) => group.sections.length > 0);
}

function NavItemLabel({ section, expanded }: { section: WorkspaceSection; expanded: boolean }) {
  return (
    <>
      <span
        className={cn(
          'truncate',
          // 768–1023px 展开时显示文字，收起时仅图标；≥1024px 始终显示
          expanded ? 'md:inline' : 'md:hidden',
          'lg:inline',
        )}
      >
        {section.title}
      </span>
      {section.badge != null && section.badge > 0 && (
        <span
          className={cn(
            'ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-3 font-semibold text-primary-foreground tabular-nums',
            expanded ? 'md:inline-block' : 'md:hidden',
            'lg:inline-block',
          )}
        >
          {section.badge > 99 ? '99+' : section.badge}
        </span>
      )}
    </>
  );
}

function SidebarNavItem({
  section,
  active,
  expanded,
  onSelect,
}: {
  section: WorkspaceSection;
  active: boolean;
  expanded: boolean;
  onSelect: (key: string) => void;
}) {
  const Icon = section.icon;
  return (
    <li className="w-full">
      <button
        type="button"
        onClick={() => onSelect(section.key)}
        aria-current={active ? 'page' : undefined}
        title={section.title}
        className={cn(
          'relative mx-auto flex h-11 w-full items-center gap-3 rounded-[10px] text-sm outline-none transition-[color,background-color,box-shadow] duration-150',
          'focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar',
          // 收起的图标栏（768–1023px）：居中 44px 方块
          'justify-center md:w-11 md:shrink-0 lg:w-full lg:justify-start lg:px-3',
          // 展开状态（平板展开或 ≥1024px）
          expanded && 'md:w-full md:justify-start md:px-3',
          active
            ? 'bg-sidebar-accent font-semibold text-sidebar-accent-foreground ring-1 ring-sidebar-border shadow-sm'
            : 'text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
        )}
      >
        {active && (
          <span
            aria-hidden="true"
            className={cn(
              'absolute top-1/2 left-0.5 h-5 w-[3px] -translate-y-1/2 rounded-full bg-primary',
            )}
          />
        )}
        <Icon className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden="true" />
        <NavItemLabel section={section} expanded={expanded} />
      </button>
    </li>
  );
}

/**
 * 退出登录：撤销服务端会话 → 清掉 CSRF 与全部私人查询缓存 → 离开当前工作台。
 * 本地管理员回 /admin/login；校园账号走 CAS 联动登出（共用机器上必须把 CAS 会话也断掉）。
 * 接口失败也照常清本地状态并跳走——用户的意图是离开，不能把人卡在已登录界面。
 */
export async function performLogout(principalKind: string | null): Promise<void> {
  let casLogoutUrl: string | null = null;
  try {
    const { data } = await api.post<{ casLogoutUrl?: string }>('/auth/logout', {});
    casLogoutUrl = data?.casLogoutUrl ?? null;
  } catch {
    // 忽略：会话可能已过期或网络失败，下面仍然清本地状态
  }
  resetCsrfToken();
  window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
  if (principalKind === 'system') {
    window.location.assign('/admin/login');
    return;
  }
  window.location.assign(casLogoutUrl ?? '/login');
}

/** 账户菜单内容：侧栏底部与手机顶栏共用，保证手机端同样能退出登录。 */
function AccountMenuContent({
  variant,
  user,
  manageAccess,
  onNavigate,
  onChangePassword,
  align,
  side,
}: {
  variant: 'member' | 'admin';
  user: WorkspaceUser;
  manageAccess?: boolean;
  onNavigate: (key: string) => void;
  onChangePassword: () => void;
  align: 'start' | 'end';
  side: 'top' | 'bottom';
}) {
  return (
    <DropdownMenuContent align={align} side={side} className="w-56">
      <DropdownMenuLabel>
        <span className="block truncate text-sm font-medium text-foreground">
          {user.displayName}
        </span>
        <span className="block truncate font-normal">
          {user.membershipLabel}
          {user.roles.length > 0 ? ` · ${roleLabels(user.roles)}` : ''}
        </span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      {variant === 'member' && (
        <DropdownMenuItem onSelect={() => onNavigate('profile')}>
          <UserRoundIcon aria-hidden="true" />
          我的资料
        </DropdownMenuItem>
      )}
      {/* 管理入口：仅当前账号有权限时出现（API 仍独立鉴权） */}
      {variant === 'member' && manageAccess && (
        <DropdownMenuItem asChild>
          <a href="/admin?section=overview">
            <ShieldCheckIcon aria-hidden="true" />
            管理工作台
          </a>
        </DropdownMenuItem>
      )}
      {variant === 'admin' && (
        <DropdownMenuItem asChild>
          <a href="/app?section=overview">
            <UserRoundIcon aria-hidden="true" />
            返回成员工作台
          </a>
        </DropdownMenuItem>
      )}
      {/* 本地管理员账号（principalKind=system）才有可修改的管理员密码 */}
      {user.principalKind === 'system' && (
        <DropdownMenuItem onSelect={onChangePassword}>
          <KeyRoundIcon aria-hidden="true" />
          修改密码
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        onSelect={() => void performLogout(user.principalKind)}
      >
        <LogOutIcon aria-hidden="true" />
        退出登录
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

function UserAvatar({ user }: { user: WorkspaceUser }) {
  return (
    <Avatar className="size-8 shrink-0 ring-1 ring-sidebar-border">
      {user.avatarAssetId && (
        <AvatarImage
          src={`/api/v1/me/avatar/${user.avatarAssetId}?size=64`}
          alt={`${user.displayName} 的头像`}
        />
      )}
      <AvatarFallback>{user.avatarText}</AvatarFallback>
    </Avatar>
  );
}

function SidebarFooter({
  variant,
  user,
  manageAccess,
  onNavigate,
  onChangePassword,
  expanded,
}: {
  variant: 'member' | 'admin';
  user: WorkspaceUser;
  manageAccess?: boolean;
  onNavigate: (key: string) => void;
  onChangePassword: () => void;
  expanded: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-sidebar-border p-2 lg:p-3">
      {(variant === 'admin' || manageAccess) && (
        <a
          href={variant === 'member' ? '/admin?section=overview' : '/app?section=overview'}
          title={variant === 'member' ? '切换管理工作台' : '返回成员工作台'}
          className={cn(
            'flex h-11 items-center justify-center gap-2 rounded-[10px] text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
            'lg:justify-start lg:px-3', expanded && 'md:justify-start md:px-3',
          )}
        >
          {variant === 'member' ? <ShieldCheckIcon className="size-4 shrink-0" aria-hidden="true" /> : <UserRoundIcon className="size-4 shrink-0" aria-hidden="true" />}
          <span className={cn('hidden', expanded ? 'md:inline' : 'md:hidden', 'lg:inline')}>
            {variant === 'member' ? '切换管理工作台' : '返回成员工作台'}
          </span>
        </a>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${user.displayName}，账户菜单`}
            title={`${user.displayName} · ${user.membershipLabel}`}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-xl border border-sidebar-border bg-card p-2 text-left outline-none transition-[background-color] duration-150',
              'lg:justify-start', expanded && 'md:justify-start',
              'hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar',
            )}
          >
            <UserAvatar user={user} />
            <span className={cn('hidden min-w-0 flex-1 flex-col', expanded ? 'md:flex' : 'md:hidden', 'lg:flex')}>
              <span className="truncate text-sm leading-5 font-medium text-sidebar-foreground">
                {user.displayName}
              </span>
              <span className="truncate text-xs leading-[18px] text-muted-foreground">
                {user.membershipLabel}
              </span>
            </span>
            <ChevronsUpDownIcon className={cn('hidden size-3.5 shrink-0 text-muted-foreground', expanded ? 'md:block' : 'md:hidden', 'lg:block')} aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <AccountMenuContent
          variant={variant}
          user={user}
          manageAccess={manageAccess}
          onNavigate={onNavigate}
          onChangePassword={onChangePassword}
          align="start"
          side="top"
        />
      </DropdownMenu>
    </div>
  );
}

export function WorkspaceShell({
  variant,
  currentSection,
  sections,
  onNavigate,
  user,
  headerRight,
  manageAccess = false,
  children,
}: WorkspaceShellProps) {
  const [railExpanded, setRailExpanded] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  useEffect(() => {
    if (!railExpanded) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRailExpanded(false);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [railExpanded]);

  const currentTitle =
    sections.find((section) => isActive(section, currentSection))?.title ?? '';
  const workspaceLabel = variant === 'member' ? '成员工作台' : '管理工作台';
  const navGroups = navigationGroups(variant, sections);

  return (
    <div className="flex min-h-dvh flex-col bg-background md:flex-row">
      {/* 平板展开为浮层，72px 轨道始终保留，业务内容不会被挤窄。 */}
      <div className="hidden w-[72px] shrink-0 md:block lg:w-[232px]">
      {railExpanded && (
        <button
          type="button"
          aria-label="关闭展开的侧栏"
          className="fixed inset-0 z-40 hidden bg-foreground/20 backdrop-blur-[2px] md:block lg:hidden"
          onClick={() => setRailExpanded(false)}
        />
      )}
      <aside
        data-slot="workspace-sidebar"
        className={cn(
          'top-0 hidden h-dvh flex-col border-r border-sidebar-border bg-sidebar md:flex',
          railExpanded ? 'md:fixed md:left-0 md:z-50 md:w-[232px] md:shadow-xl' : 'md:sticky md:w-[72px]',
          'lg:sticky lg:z-auto lg:w-[232px] lg:shadow-none',
        )}
      >
        <div
          className={cn(
            'flex h-16 items-center gap-2 border-b border-sidebar-border px-3',
            !railExpanded && 'md:justify-center md:px-0 lg:justify-start lg:px-3',
          )}
        >
          <Link to="/app" aria-label="返回首页" className="flex min-w-0 items-center gap-2 rounded-xl">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-sidebar-border bg-card">
              <ClubMark className="size-7" />
            </span>
            <div className={cn('hidden flex-col', railExpanded ? 'md:flex' : 'md:hidden', 'lg:flex')}>
              <span className="text-sm leading-5 font-semibold text-sidebar-foreground">
                ACM 协会
              </span>
              <span className="text-[10px] leading-3 tracking-[0.12em] text-muted-foreground">
                ACM CLUB
              </span>
            </div>
          </Link>
        </div>

        <nav aria-label="侧栏导航" className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-5">
          {navGroups.map((group, index) => (
            <section key={group.label} aria-label={group.label} className="flex flex-col gap-2">
              <p className={cn('px-3 text-[11px] font-medium tracking-wide text-muted-foreground', railExpanded ? 'md:block' : 'md:hidden', 'lg:block')}>
                {group.label}
              </p>
              {index > 0 && !railExpanded && <span aria-hidden="true" className="mx-auto block h-px w-7 bg-sidebar-border lg:hidden" />}
              <ul className="flex flex-col gap-1.5">
                {group.sections.map((section) => (
                  <SidebarNavItem
                    key={section.key}
                    section={section}
                    active={isActive(section, currentSection)}
                    expanded={railExpanded}
                    onSelect={(key) => { onNavigate(key); setRailExpanded(false); }}
                  />
                ))}
              </ul>
            </section>
          ))}
        </nav>

        {/* 平板图标栏展开开关（仅 768–1023px 可见） */}
        <div className="hidden border-t border-sidebar-border p-2 md:block lg:hidden">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={railExpanded ? '收起侧栏' : '展开侧栏'}
            aria-expanded={railExpanded}
            onClick={() => setRailExpanded((value) => !value)}
            className="hidden w-full md:flex lg:hidden"
          >
            {railExpanded ? (
              <ChevronsLeftIcon aria-hidden="true" />
            ) : (
              <ChevronsRightIcon aria-hidden="true" />
            )}
            {railExpanded && <span>收起</span>}
          </Button>
        </div>

        <SidebarFooter
          variant={variant}
          user={user}
          manageAccess={manageAccess}
          onNavigate={onNavigate}
          onChangePassword={() => setPasswordOpen(true)}
          expanded={railExpanded}
        />
      </aside>
      </div>

      {/* 主区域 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏：桌面 64px / 手机 56px */}
        <header
          data-slot="workspace-topbar"
          className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-card/95 px-4 md:h-16 md:px-6"
        >
          {/* 管理端手机导航入口（成员端使用底栏） */}
          {variant === 'admin' && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="打开导航菜单"
              onClick={() => setMobileNavOpen(true)}
            >
              <MenuIcon aria-hidden="true" />
            </Button>
          )}

          {variant === 'member' && <Link to="/app" aria-label="返回首页" className="flex size-11 shrink-0 items-center justify-center md:hidden"><ClubMark className="size-7" /></Link>}

          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'truncate text-sm leading-[22px] font-semibold text-foreground',
                variant === 'admin' && 'text-primary',
              )}
            >
              <span className="flex flex-col">
                <span>{workspaceLabel}</span>
                {variant === 'admin' && user.roles.length > 0 && (
                  <span className="max-w-56 truncate text-[10px] leading-4 font-normal text-muted-foreground">
                    {roleLabels(user.roles)}
                  </span>
                )}
              </span>
            </span>
            <span className="hidden truncate text-sm leading-[22px] text-muted-foreground sm:inline">
              · {currentTitle}
            </span>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {headerRight ?? <ThemeToggle />}
            {/* 手机端侧栏隐藏，账户菜单（含退出登录）放到顶栏 */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`${user.displayName}，账户菜单`}
                  className="flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
                >
                  <UserAvatar user={user} />
                </button>
              </DropdownMenuTrigger>
              <AccountMenuContent
                variant={variant}
                user={user}
                manageAccess={manageAccess}
                onNavigate={onNavigate}
                onChangePassword={() => setPasswordOpen(true)}
                align="end"
                side="bottom"
              />
            </DropdownMenu>
          </div>
        </header>

        {/* 内容：max-width 1440px；桌面 padding 32px、平板 24px、手机 16px */}
        <main className="flex-1">
          <div
            data-slot="workspace-content"
            className={cn(
              'mx-auto w-full max-w-[1440px] min-w-0 p-4 md:p-6 lg:p-8',
              // 预留手机底栏高度与安全区
              'pb-[calc(72px+env(safe-area-inset-bottom))] md:pb-6 lg:pb-8',
            )}
          >
            {children}
          </div>
        </main>

        {/* 手机六项底栏：仅成员端；管理端用顶栏菜单 + Sheet */}
        {variant === 'member' && (
          <MobileNavigation currentSection={currentSection} onNavigate={onNavigate} />
        )}
      </div>

      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />

      {/* 管理端手机导航 Sheet */}
      {variant === 'admin' && (
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="w-72 p-0" showCloseButton={false}>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <ClubMark className="size-6" />
                管理工作台
              </SheetTitle>
              <SheetDescription>选择要进入的管理面板</SheetDescription>
            </SheetHeader>
            <nav aria-label="管理导航" className="flex-1 overflow-y-auto p-3">
              <ul className="flex flex-col gap-1">
                {sections.map((section) => {
                  const Icon = section.icon;
                  const active = isActive(section, currentSection);
                  return (
                    <li key={section.key}>
                      <button
                        type="button"
                        onClick={() => {
                          setMobileNavOpen(false);
                          onNavigate(section.key);
                        }}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'relative flex h-11 w-full items-center gap-3 rounded-[10px] px-3 text-sm outline-none transition-[color,background-color] duration-150',
                          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                          active
                            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                            : 'text-foreground hover:bg-muted',
                        )}
                      >
                        {active && (
                          <span
                            aria-hidden="true"
                            className="absolute top-1/2 left-0.5 h-5 w-[3px] -translate-y-1/2 rounded-full bg-primary"
                          />
                        )}
                        <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
                        <span className="truncate">{section.title}</span>
                        {section.badge != null && section.badge > 0 && (
                          <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-3 font-semibold text-primary-foreground tabular-nums">
                            {section.badge > 99 ? '99+' : section.badge}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
