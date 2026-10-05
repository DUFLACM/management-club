import { AuthBackButton } from './AuthBackButton';
import { UniversityBrand } from './UniversityBrand';
import { ThemeToggle } from '@/workspaces/shared/ThemeToggle';

/** 三个手机认证入口共用的紧凑校名与协会标识。 */
export function AuthMobileHeader({ showBack = false, showTheme = false }: { showBack?: boolean; showTheme?: boolean }) {
  return (
    <header className="flex h-[72px] shrink-0 items-center gap-3 border-b border-border/70 bg-card/60 px-4 md:hidden">
      {showBack && <AuthBackButton iconOnly />}
      <div data-slot="entry-brand" className="min-w-0"><UniversityBrand compact /></div>
      {showTheme && <div className="ml-auto"><ThemeToggle className="size-11" /></div>}
    </header>
  );
}

/** 统一手机底色，装饰不占内容高度。 */
export function AuthMobileBackdrop() {
  return <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[440px] bg-gradient-to-b from-secondary/70 via-background to-background md:hidden" />;
}
