import { Link } from 'react-router';
import { ClubMark } from '@/components/club/ClubMark';
import { ThemeToggle } from '@/workspaces/shared/ThemeToggle';
import { SectionRouter } from '@/workspaces/shared/SectionRouter';
import { MemberPanels } from '@/workspaces/lazy-panels';

export function PublicityPage() {
  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-8">
          <Link to="/app" className="flex items-center gap-2 font-semibold">
            <ClubMark />大连外国语大学 ACM 协会
          </Link>
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-9">
        <SectionRouter currentSection="publicity" defaultSection="publicity" panels={MemberPanels} />
      </main>
    </div>
  );
}
