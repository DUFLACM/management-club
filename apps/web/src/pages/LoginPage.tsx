import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { LoaderCircleIcon, LogInIcon } from 'lucide-react';

import { UniversityBrand } from '@/components/club/UniversityBrand';
import { AuthBackButton } from '@/components/club/AuthBackButton';
import { AuthMobileBackdrop, AuthMobileHeader } from '@/components/club/AuthMobileHeader';
import { TrainingRoomArt } from '@/components/club/TrainingRoomArt';
import { WelcomeTrainingArt } from '@/components/club/WelcomeTrainingArt';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { startCasLogin } from '@/features/auth/cas';
import { casErrorMessage } from '@/features/auth/cas-errors';

/**
 * 登录页（/login）。
 * 桌面：左 42% 品牌图区（训练室线稿 320×214 + 标语）+ 右 58% 表单区（max-width 400px）；
 * 手机：隐藏品牌区，顶部保留括号 logo 与协会名。
 * 主动作“使用校园 CAS 登录”：取 CSRF → POST /auth/cas/start → 顶层导航。
 */
export function LoginPage() {
  const [searchParams] = useSearchParams();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(() => casErrorMessage(searchParams.get('error')));

  async function handleCasLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await startCasLogin();
      // 成功时页面即将跳转，无需恢复状态
    } catch (cause) {
      setSubmitting(false);
      setError(
        cause instanceof ApiError
          ? cause.message
          : '暂时无法发起校园认证，请稍后重试。',
      );
    }
  }

  return (
    <div className="relative isolate flex min-h-dvh flex-col bg-background md:grid md:grid-cols-[42%_58%]">
      <AuthMobileBackdrop />
      {/* 品牌图区：手机隐藏 */}
      <aside className="relative hidden flex-col items-center justify-center gap-8 border-r border-border bg-secondary px-12 md:flex">
        <UniversityBrand stacked />
        <TrainingRoomArt width={320} height={214} className="max-w-full" />
        <p className="max-w-[320px] text-center text-base leading-[26px] text-muted-foreground">
          从一道题开始，认识一群一起写代码的人
        </p>
      </aside>

      {/* 表单区 */}
      <main className="flex flex-1 flex-col">
        <AuthMobileHeader showBack />
        <div className="hidden px-8 pt-6 md:block">
          <AuthBackButton />
        </div>

        <div className="mx-auto flex w-full max-w-[460px] flex-col px-4 pt-5 pb-10 md:max-w-[400px] md:flex-1 md:justify-center md:gap-8 md:px-8 md:py-10">
          <section data-slot="auth-form-panel" className="flex flex-col gap-6 rounded-3xl border border-border bg-card p-4 shadow-card min-[375px]:p-5 md:contents">
          <header className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
            <h1 className="text-[22px] leading-[30px] font-semibold text-foreground md:text-[28px] md:leading-9">
              登录
            </h1>
            <WelcomeTrainingArt className="-my-2 w-[90px] md:hidden" />
            </div>
            <p className="text-sm leading-[22px] text-muted-foreground">
              使用学校统一认证登录协会系统。
            </p>
          </header>

          <form className="flex flex-col gap-4" onSubmit={handleCasLogin}>
            {error && (
              <Alert variant="destructive">
                <LogInIcon aria-hidden="true" />
                <AlertTitle>校园认证未完成</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {/* 关键操作 48px；提交中保留宽度与任务文案 */}
            <Button type="submit" size="lg" disabled={submitting} className="h-[52px] w-full rounded-xl md:h-12 md:rounded-lg">
              {submitting ? (
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
              ) : (
                <LogInIcon aria-hidden="true" />
              )}
              {submitting ? '正在跳转学校认证…' : '使用校园 CAS 登录'}
            </Button>
          </form>

          <p className="-mx-4 -mb-4 rounded-b-3xl border-t border-border bg-muted/35 px-4 py-5 text-center text-sm leading-[22px] text-muted-foreground min-[375px]:-mx-5 min-[375px]:-mb-5 min-[375px]:px-5 md:mx-0 md:mb-0 md:rounded-none md:border-0 md:bg-transparent md:p-0 md:text-left">
            收到入社邀请？{' '}
            <Link
              to="/register"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              使用邀请码注册
            </Link>
          </p>
          </section>
        </div>
      </main>
    </div>
  );
}
