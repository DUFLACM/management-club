import { useState } from 'react';
import { Link } from 'react-router';
import { LoaderCircleIcon, LogInIcon, ShieldCheckIcon, TicketIcon } from 'lucide-react';

import { UniversityBrand } from '@/components/club/UniversityBrand';
import { WelcomeTrainingArt } from '@/components/club/WelcomeTrainingArt';
import { AuthMobileBackdrop, AuthMobileHeader } from '@/components/club/AuthMobileHeader';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { startCasLogin } from '@/features/auth/cas';
import { ThemeToggle } from './ThemeToggle';

/** 会话确认后的匿名品牌入口，不挂载工作台导航或私人业务面板。 */
export function AuthWorkspaceEntry({ loading, error, onRetry }: {
  loading: boolean;
  error?: string | null;
  onRetry: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [casError, setCasError] = useState<string | null>(null);
  const entryError = casError ?? error;

  async function handleCasLogin() {
    if (loading || submitting) return;
    setCasError(null);
    setSubmitting(true);
    try {
      await startCasLogin();
    } catch (cause) {
      setSubmitting(false);
      setCasError(cause instanceof ApiError ? cause.message : '暂时无法发起校园认证，请稍后重试。');
    }
  }

  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-background">
      <AuthMobileBackdrop />
      <div aria-hidden="true" className="pointer-events-none absolute -top-32 -right-40 -z-10 hidden size-[600px] rounded-full bg-secondary/70 blur-[100px] md:block" />
      <div aria-hidden="true" className="pointer-events-none absolute bottom-0 -left-44 -z-10 hidden size-[480px] rounded-full bg-success-subtle/50 blur-[100px] md:block" />
      <AuthMobileHeader showTheme />
      <header className="hidden shrink-0 md:block">
        <div className="mx-auto flex min-h-[100px] w-full max-w-6xl items-center gap-4 px-6 py-5 sm:min-h-[112px] sm:px-8">
          <div data-slot="entry-brand"><UniversityBrand /></div>
          <div className="ml-auto"><ThemeToggle /></div>
        </div>
        <div className="mx-6 h-px bg-border/70 sm:mx-auto sm:max-w-[1088px]" />
      </header>

      <main className="mx-auto flex w-full max-w-[460px] flex-1 items-start px-4 pt-5 pb-6 md:max-w-[1104px] md:items-center md:px-10 md:py-12 lg:py-20">
        <section className="grid w-full grid-cols-1 items-center gap-y-6 rounded-3xl border border-border bg-card p-4 text-center shadow-card min-[375px]:p-5 md:gap-y-4 md:rounded-none md:border-0 md:bg-transparent md:p-0 md:shadow-none lg:grid-cols-[1.12fr_1fr] lg:gap-x-16 lg:gap-y-8 lg:text-left">
          <div className="flex flex-col items-center gap-5 md:gap-4 lg:items-start">
            <p className="hidden items-center gap-2 text-[11px] font-semibold tracking-[0.22em] text-muted-foreground md:flex">
              <span aria-hidden="true" className="h-px w-6 bg-primary/60" />ACM CLUB<span aria-hidden="true" className="h-px w-6 bg-primary/60 lg:hidden" />
            </p>
            <h1 className="flex w-full flex-col gap-2 font-semibold tracking-tight text-foreground md:gap-3">
              <span className="whitespace-nowrap text-[18px] leading-7 md:text-[26px] md:leading-9">欢迎来到大连外国语大学</span>
              <span className="flex items-center justify-center gap-2 lg:justify-start">
                <span className="text-[36px] leading-[1.2] text-primary md:text-[52px]">ACM 社团</span>
                <WelcomeTrainingArt className="-my-2 w-[78px] md:hidden" />
              </span>
            </h1>
            <p className="text-sm leading-6 text-muted-foreground md:text-[15px] md:leading-7">
              使用校园账号登录，继续你的训练。<br />首次加入可凭邀请提交入社申请。
            </p>
          </div>

          <div className="hidden flex-col items-center md:flex lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <WelcomeTrainingArt className="w-[320px] max-w-full lg:w-full" />
            <p className="mt-3 hidden text-sm leading-6 text-muted-foreground lg:block">从一道题开始，认识一群一起写代码的人</p>
          </div>

          <div data-slot="entry-actions" aria-busy={loading || submitting} className="mx-auto flex w-full max-w-[352px] flex-col gap-4 border-t border-border pt-5 md:border-0 md:pt-0 lg:mx-0">
            {entryError && (
              <Alert variant="destructive" className="text-left">
                <AlertDescription>{entryError}</AlertDescription>
                {error && !casError && <Button type="button" size="sm" variant="outline" onClick={onRetry}>重新连接</Button>}
              </Alert>
            )}
            <div className="flex flex-col gap-3">
              <Button type="button" disabled={loading || submitting} size="lg" className="h-[52px] rounded-xl shadow-sm shadow-primary/10 disabled:opacity-75" onClick={() => void handleCasLogin()}>
                {loading || submitting ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : <LogInIcon aria-hidden="true" />}
                <span role={loading || submitting ? 'status' : undefined}>{loading ? '正在确认登录状态…' : submitting ? '正在跳转学校认证…' : '校园 CAS 登录'}</span>
              </Button>
              {loading || submitting ? (
                  <Button type="button" disabled size="lg" variant="outline" className="h-[52px] rounded-xl bg-card/70 disabled:opacity-75">
                    <TicketIcon aria-hidden="true" />使用邀请入社
                  </Button>
              ) : (
                  <Button asChild size="lg" variant="outline" className="h-[52px] rounded-xl bg-card/70">
                    <Link to="/register"><TicketIcon aria-hidden="true" />使用邀请入社</Link>
                  </Button>
              )}
            </div>
            <div className="flex justify-center border-t border-border pt-1">
              {loading || submitting ? (
                <Button type="button" disabled variant="ghost" className="h-11 rounded-xl px-4 text-muted-foreground disabled:opacity-75">
                  <ShieldCheckIcon aria-hidden="true" />管理员登录
                </Button>
              ) : (
                <Button asChild variant="ghost" className="h-11 rounded-xl px-4 text-muted-foreground hover:text-foreground">
                  <Link to="/admin/login"><ShieldCheckIcon aria-hidden="true" />管理员登录</Link>
                </Button>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="shrink-0 px-4 pt-2 pb-6 text-center text-[11px] leading-5 text-muted-foreground sm:pb-8 sm:text-xs">
        大连外国语大学 ACM 算法协会
      </footer>
    </div>
  );
}
