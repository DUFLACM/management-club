import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  ArrowLeftIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  LogInIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from 'lucide-react';

import { AuthBackButton } from '@/components/club/AuthBackButton';
import { AuthMobileBackdrop, AuthMobileHeader } from '@/components/club/AuthMobileHeader';
import { TrainingRoomArt } from '@/components/club/TrainingRoomArt';
import { UniversityBrand } from '@/components/club/UniversityBrand';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError, fetchCsrfToken, resetCsrfToken } from '@/lib/api';

export interface AdminGateResponse {
  verified: boolean;
}

export interface AdminCaptchaResponse {
  challengeId: string;
  imageDataUrl?: string | null;
  imageUrl?: string | null;
  expiresAt?: string | null;
}

export interface AdminLoginResponse {
  authenticated: boolean;
  next?: string | null;
}

export function captchaImageSource(captcha: AdminCaptchaResponse | null): string | null {
  const dataUrl = captcha?.imageDataUrl?.trim();
  if (dataUrl?.startsWith('data:image/')) return dataUrl;
  const imageUrl = captcha?.imageUrl?.trim();
  if (imageUrl?.startsWith('/')) return imageUrl;
  return null;
}

export function adminLoginNextTarget(next: string | null | undefined): string {
  return next === '/admin' || next?.startsWith('/admin?') ? next : '/admin';
}

function isGateSessionError(cause: unknown): cause is ApiError {
  return cause instanceof ApiError
    && (cause.code === 'ADMIN_GATE_REQUIRED' || cause.code === 'ADMIN_GATE_EXPIRED');
}

/** 独立管理员认证：入口密语通过后，才加载账号、密码和服务端验证码。 */
export function AdminLoginPage() {
  const [stage, setStage] = useState<'gate' | 'credentials'>('gate');
  const [gateSecret, setGateSecret] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [captchaText, setCaptchaText] = useState('');
  const [captcha, setCaptcha] = useState<AdminCaptchaResponse | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [captchaError, setCaptchaError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [captchaLoading, setCaptchaLoading] = useState(false);

  async function loadCaptcha() {
    setCaptchaLoading(true);
    setCaptchaError(null);
    try {
      const csrfToken = await fetchCsrfToken();
      if (!csrfToken) throw new ApiError('CSRF_UNAVAILABLE', '安全令牌获取失败，请刷新页面重试。');
      const { data } = await api.post<AdminCaptchaResponse>('/auth/admin/captcha', {
        csrfToken,
      });
      if (!data.challengeId || !captchaImageSource(data)) {
        throw new ApiError('CAPTCHA_INVALID', '验证码暂时无法显示，请刷新重试。');
      }
      setCaptcha(data);
    } catch (cause) {
      if (isGateSessionError(cause)) {
        returnToGate();
        setGateError(cause.message);
        return;
      }
      setCaptcha(null);
      setCaptchaError(
        cause instanceof ApiError ? cause.message : '验证码加载失败，请刷新重试。',
      );
    } finally {
      setCaptchaLoading(false);
    }
  }

  async function handleGateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!gateSecret || submitting) return;
    setSubmitting(true);
    setGateError(null);
    try {
      const csrfToken = await fetchCsrfToken();
      if (!csrfToken) throw new ApiError('CSRF_UNAVAILABLE', '安全令牌获取失败，请刷新页面重试。');
      const { data } = await api.post<AdminGateResponse>('/auth/admin/gate', {
        secret: gateSecret,
        csrfToken,
      });
      if (!data.verified) {
        throw new ApiError('ADMIN_GATE_DENIED', '管理入口密语不正确。');
      }
      setGateSecret('');
      setStage('credentials');
      await loadCaptcha();
    } catch (cause) {
      setGateError(
        cause instanceof ApiError ? cause.message : '暂时无法验证管理入口，请稍后重试。',
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLoginSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!captcha || !captchaText.trim() || submitting) return;
    setSubmitting(true);
    setLoginError(null);
    try {
      const csrfToken = await fetchCsrfToken();
      if (!csrfToken) throw new ApiError('CSRF_UNAVAILABLE', '安全令牌获取失败，请刷新页面重试。');
      const { data } = await api.post<AdminLoginResponse>('/auth/admin/login', {
        username: username.trim(),
        password,
        challengeId: captcha.challengeId,
        captcha: captchaText.trim(),
        csrfToken,
      });
      if (!data.authenticated) {
        throw new ApiError('ADMIN_LOGIN_FAILED', '管理员身份验证未完成。');
      }
      resetCsrfToken();
      window.location.assign(adminLoginNextTarget(data.next));
    } catch (cause) {
      if (isGateSessionError(cause)) {
        returnToGate();
        setGateError(cause.message);
        setSubmitting(false);
        return;
      }
      setLoginError(
        cause instanceof ApiError ? cause.message : '管理员登录失败，请检查后重试。',
      );
      setCaptchaText('');
      await loadCaptcha();
      setSubmitting(false);
    }
  }

  function returnToGate() {
    setStage('gate');
    setUsername('');
    setPassword('');
    setCaptchaText('');
    setCaptcha(null);
    setCaptchaError(null);
    setLoginError(null);
  }

  const captchaSource = captchaImageSource(captcha);

  return (
    <div className="relative isolate flex min-h-dvh flex-col bg-background md:grid md:grid-cols-[42%_58%]">
      <AuthMobileBackdrop />
      <aside className="relative hidden flex-col items-center justify-center gap-8 border-r border-border bg-secondary px-12 md:flex">
        <UniversityBrand stacked />
        <TrainingRoomArt width={320} height={214} className="max-w-full" />
        <p className="max-w-[320px] text-center text-base leading-[26px] text-muted-foreground">
          管理入口仅供已授权的协会负责人使用
        </p>
      </aside>

      <main className="flex flex-1 flex-col">
        <AuthMobileHeader showBack />
        <div className="hidden px-8 pt-6 md:block">
          <AuthBackButton />
        </div>

        <div className="mx-auto flex w-full max-w-[460px] flex-col px-4 pt-5 pb-10 md:max-w-[420px] md:flex-1 md:justify-center md:px-8 md:py-10">
          <section className="flex flex-col gap-6 rounded-3xl border border-border bg-card p-4 shadow-card min-[375px]:p-5 md:rounded-none md:border-0 md:bg-transparent md:p-0 md:shadow-none">
            <header className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-secondary text-primary">
                  <ShieldCheckIcon aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h1 className="text-[22px] leading-[30px] font-semibold text-foreground md:text-[28px] md:leading-9">
                    管理员登录
                  </h1>
                  <p className="text-sm leading-[22px] text-muted-foreground">
                    {stage === 'gate' ? '先验证管理入口密语' : '继续完成管理员身份验证'}
                  </p>
                </div>
              </div>
              <ol aria-label="管理员登录步骤" className="grid grid-cols-2 gap-2 text-xs">
                <li className={stage === 'gate' ? 'rounded-lg bg-secondary px-3 py-2 font-medium text-secondary-foreground' : 'rounded-lg bg-muted px-3 py-2 text-muted-foreground'}>
                  1&nbsp; 验证密语
                </li>
                <li className={stage === 'credentials' ? 'rounded-lg bg-secondary px-3 py-2 font-medium text-secondary-foreground' : 'rounded-lg bg-muted px-3 py-2 text-muted-foreground'}>
                  2&nbsp; 账号验证
                </li>
              </ol>
            </header>

            {stage === 'gate' ? (
              <form className="flex flex-col gap-4" onSubmit={(event) => void handleGateSubmit(event)}>
                <div className="grid gap-2">
                  <Label htmlFor="admin-gate-secret">管理入口密语</Label>
                  <Input
                    id="admin-gate-secret"
                    name="gate-secret"
                    type="password"
                    autoComplete="off"
                    required
                    maxLength={256}
                    value={gateSecret}
                    onChange={(event) => setGateSecret(event.target.value)}
                    className="h-12 rounded-xl md:h-10 md:rounded-lg"
                  />
                </div>
                {gateError && (
                  <Alert variant="destructive">
                    <AlertTitle>密语验证未通过</AlertTitle>
                    <AlertDescription>{gateError}</AlertDescription>
                  </Alert>
                )}
                <Button type="submit" size="lg" className="h-[52px] w-full rounded-xl md:h-12 md:rounded-lg" disabled={submitting || !gateSecret}>
                  {submitting ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : <KeyRoundIcon aria-hidden="true" />}
                  {submitting ? '正在验证…' : '验证密语'}
                </Button>
              </form>
            ) : (
              <form className="flex flex-col gap-4" onSubmit={(event) => void handleLoginSubmit(event)}>
                <div className="grid gap-2">
                  <Label htmlFor="admin-username">管理员用户名</Label>
                  <Input
                    id="admin-username"
                    name="username"
                    autoComplete="username"
                    required
                    maxLength={64}
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="admin-password">管理员密码</Label>
                  <Input
                    id="admin-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={512}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <div className="flex min-h-11 items-center justify-between gap-2">
                    <Label htmlFor="admin-captcha">验证码</Label>
                    <Button type="button" size="sm" variant="ghost" className="h-11 shrink-0 px-2" disabled={captchaLoading || submitting} onClick={() => void loadCaptcha()}>
                      {captchaLoading ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : <RefreshCwIcon aria-hidden="true" />}
                      刷新验证码
                    </Button>
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_128px] gap-2">
                    <Input
                      id="admin-captcha"
                      name="captcha"
                      inputMode="text"
                      autoCapitalize="none"
                      autoComplete="off"
                      spellCheck={false}
                      required
                      maxLength={12}
                      value={captchaText}
                      onChange={(event) => setCaptchaText(event.target.value)}
                      aria-describedby={captchaError ? 'admin-captcha-error' : undefined}
                    />
                    <div className="flex h-10 items-center justify-center overflow-hidden rounded-lg border border-input bg-background">
                      {captchaLoading ? (
                        <LoaderCircleIcon className="animate-spin text-muted-foreground" aria-label="正在加载验证码" />
                      ) : captchaSource ? (
                        <img src={captchaSource} alt="管理员登录验证码" className="h-full w-full object-contain" />
                      ) : (
                        <span className="text-xs text-muted-foreground">无法显示</span>
                      )}
                    </div>
                  </div>
                  {captchaError && <p id="admin-captcha-error" role="alert" className="text-xs leading-5 text-destructive">{captchaError}</p>}
                </div>
                {loginError && (
                  <Alert variant="destructive">
                    <AlertTitle>管理员登录未完成</AlertTitle>
                    <AlertDescription>{loginError}</AlertDescription>
                  </Alert>
                )}
                <Button type="submit" size="lg" className="h-[52px] w-full rounded-xl md:h-12 md:rounded-lg" disabled={submitting || captchaLoading || !username.trim() || !password || !captcha || !captchaText.trim()}>
                  {submitting ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : <LogInIcon aria-hidden="true" />}
                  {submitting ? '正在登录…' : '登录管理工作台'}
                </Button>
                <Button type="button" variant="ghost" className="h-11 w-full" disabled={submitting} onClick={returnToGate}>
                  <ArrowLeftIcon aria-hidden="true" />返回密语验证
                </Button>
              </form>
            )}

            <p className="border-t border-border pt-4 text-center text-xs leading-5 text-muted-foreground md:text-left">
              普通成员请返回 <Link to="/app" className="font-medium text-primary underline-offset-4 hover:underline">协会首页</Link> 使用校园认证。
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
