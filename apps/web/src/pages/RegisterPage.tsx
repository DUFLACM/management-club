import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  ArrowLeftIcon,
  BadgeCheckIcon,
  CheckIcon,
  LoaderCircleIcon,
  SendIcon,
  ScanQrCodeIcon,
  ShieldCheckIcon,
  TicketIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { UniversityBrand } from '@/components/club/UniversityBrand';
import { AuthBackButton } from '@/components/club/AuthBackButton';
import { AuthMobileBackdrop, AuthMobileHeader } from '@/components/club/AuthMobileHeader';
import { TrainingRoomArt } from '@/components/club/TrainingRoomArt';
import { WelcomeTrainingArt } from '@/components/club/WelcomeTrainingArt';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, ApiError, resetCsrfToken } from '@/lib/api';
import { startCasLogin } from '@/features/auth/cas';
import { INVITE_PATTERN, normalizeInviteCode, parseInvitationQr } from '@/lib/invitation-qr';

const QrScanner = lazy(() => import('@/components/club/QrScanner'));

/**
 * 注册页（/register）。
 * 桌面 42% 品牌图区 + 58% 表单区（max-width 400px）；手机隐藏品牌区。
 * 步骤条固定：验证邀请 → 校园认证 → 提交申请；
 * 第一步为可见 label 的邀请码输入（12 位去混淆格式提示 + 错误说明）；
 * 完成后显示“申请已提交，等待审核”（申请进度与下一步，不用庆祝插画）。
 */

type RegisterStep = 1 | 2 | 3;

const STEPS: readonly { index: RegisterStep; title: string; hint: string }[] = [
  { index: 1, title: '验证邀请', hint: '输入 12 位邀请码' },
  { index: 2, title: '校园认证', hint: '学校统一认证确认校园编号' },
  { index: 3, title: '提交申请', hint: '补全资料并提交' },
];

function StepIndicator({ current }: { current: RegisterStep }) {
  return (
    <ol className="grid grid-cols-3 gap-2 rounded-xl border border-border bg-muted/50 p-3 md:flex md:items-center md:rounded-none md:border-0 md:bg-transparent md:p-0" aria-label="注册步骤">
      {STEPS.map((step, order) => {
        const done = step.index < current;
        const active = step.index === current;
        const last = order === STEPS.length - 1;
        return (
          <li key={step.index} className="flex min-w-0 flex-col items-center gap-1.5 md:flex-1 md:flex-row md:gap-2">
            <span
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs leading-4 font-semibold tabular-nums',
                done && 'border-primary bg-primary text-primary-foreground',
                active && 'border-primary bg-primary text-primary-foreground md:bg-transparent md:text-primary',
                !done && !active && 'border-border text-muted-foreground',
              )}
            >
              {done ? <CheckIcon className="size-3.5" aria-hidden="true" /> : step.index}
            </span>
            <span
              className={cn(
                'whitespace-nowrap text-[11px] leading-[18px] font-medium md:truncate md:text-xs',
                active ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {step.title}
            </span>
            {!last && (
              <span aria-hidden="true" className="hidden h-px min-w-4 flex-1 bg-border md:block" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function RegisterPage() {
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState<RegisterStep>(searchParams.get('step') === 'cas_done' ? 3 : 1);
  const [inviteCode, setInviteCode] = useState('');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [casError, setCasError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [invitationSummary, setInvitationSummary] = useState<{ batchLabel: string | null; remainingUses: number } | null>(null);
  const [grade, setGrade] = useState('');
  const [phone, setPhone] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const code = fragment.get('invite');
    if (code) setInviteCode(normalizeInviteCode(code));
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, []);

  async function handleVerifyInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await verifyInvitation(inviteCode);
  }

  async function verifyInvitation(rawCode: string) {
    const code = normalizeInviteCode(rawCode);
    setInviteError(null);
    if (code.length === 0) {
      setInviteError('请输入邀请码。');
      return;
    }
    if (code.length !== 12) {
      setInviteError(`邀请码应为 12 位字符，当前为 ${code.length} 位，请核对来源后重试。`);
      return;
    }
    if (!INVITE_PATTERN.test(code)) {
      setInviteError('邀请码不包含 0、1、I、L、O 等易混淆字符，请检查输入。');
      return;
    }
    setSubmitting(true);
    try {
      const { data } = await api.post<{ intentId: string; invitationSummary: { batchLabel: string | null; remainingUses: number } }>(
        '/auth/invitations/exchange', { code },
      );
      setInviteCode(code);
      setIntentId(data.intentId);
      setInvitationSummary(data.invitationSummary);
      setStep(2);
    } catch (cause) {
      setInviteError(cause instanceof ApiError ? cause.message : '邀请码验证失败，请重试。');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCasLogin() {
    setCasError(null);
    setSubmitting(true);
    try {
      if (!intentId) throw new ApiError('INTENT_MISSING', '请先验证邀请码。');
      await startCasLogin({ purpose: 'register', registrationIntentId: intentId });
    } catch (cause) {
      setSubmitting(false);
      setCasError(
        cause instanceof ApiError ? cause.message : '暂时无法发起校园认证，请稍后重试。',
      );
    }
  }

  async function handleSubmitApplication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCasError(null);
    const year = grade.trim() ? Number(grade) : undefined;
    if (year != null && (!Number.isInteger(year) || year < 1900 || year > 2100)) {
      setCasError('请填写有效的入学年份。');
      return;
    }
    setSubmitting(true);
    try {
      const { data } = await api.post<{ ok: boolean }>('/auth/register/complete', {
        ...(year != null ? { grade: year } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
      });
      if (!data.ok) throw new ApiError('REGISTER_FAILED', '申请未提交成功，请重试。');
      resetCsrfToken();
      setSubmitted(true);
    } catch (cause) {
      setCasError(cause instanceof ApiError ? cause.message : '申请提交失败，请重试。');
    } finally {
      setSubmitting(false);
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
          <header className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
            <h1 className="text-[22px] leading-[30px] font-semibold text-foreground md:text-[28px] md:leading-9">
              入社注册
            </h1>
            <WelcomeTrainingArt className="-my-2 w-[90px] md:hidden" />
            </div>
            <StepIndicator current={submitted ? 3 : step} />
          </header>

          {submitted ? (
            <section aria-live="polite" className="flex flex-col gap-6">
              <Alert variant="success">
                <BadgeCheckIcon aria-hidden="true" />
                <AlertTitle>申请已提交，等待审核</AlertTitle>
                <AlertDescription>
                  账号已建立，当前身份为申请者。进入工作台查看进度，正式入社仍需协会审核。
                </AlertDescription>
              </Alert>
              <Button asChild variant="outline" className="w-full">
                <Link to="/app">进入工作台</Link>
              </Button>
            </section>
          ) : step === 1 ? (
            <form className="flex flex-col gap-4" onSubmit={(event) => void handleVerifyInvite(event)} noValidate>
              <div className="flex flex-col gap-2">
                <div className="flex min-h-11 items-center justify-between gap-2">
                <Label htmlFor="invite-code">邀请码</Label>
                <Button type="button" size="sm" variant="ghost" className="h-11 shrink-0 gap-1.5 rounded-lg px-2 text-primary" disabled={submitting} onClick={() => setScannerOpen(true)}>
                  <ScanQrCodeIcon aria-hidden="true" />扫描邀请码
                </Button>
                </div>
                <Input
                  id="invite-code"
                  name="invite-code"
                  inputMode="text"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="例如 7K2M-QR4T-9WXZ"
                  value={inviteCode}
                  aria-invalid={inviteError != null}
                  aria-describedby={inviteError ? 'invite-code-error' : undefined}
                  className="h-12 rounded-xl font-mono tracking-[0.14em] uppercase md:h-10 md:rounded-lg"
                  onChange={(event) => setInviteCode(event.target.value)}
                />
                {inviteError && (
                  <p id="invite-code-error" role="alert" className="text-xs leading-[18px] text-destructive">
                    {inviteError}
                  </p>
                )}
              </div>
              <Button type="submit" size="lg" className="h-[52px] w-full rounded-xl md:h-12 md:rounded-lg" disabled={submitting}>
                {submitting ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : <TicketIcon aria-hidden="true" />}
                {submitting ? '正在验证…' : '验证邀请码'}
              </Button>
            </form>
          ) : step === 2 ? (
            <section className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <p className="text-sm leading-[22px] font-medium text-foreground">
                  校园认证
                </p>
                <p className="text-sm leading-[22px] text-muted-foreground">
                  跳转学校统一认证完成登录；你的校园编号由 CAS 确定，无需手填。
                  认证完成后回到本页继续提交申请。
                </p>
                {invitationSummary && <p className="text-xs text-muted-foreground">{invitationSummary.batchLabel ?? '入社邀请'} · 剩余 {invitationSummary.remainingUses} 次。验证邀请尚未占用名额。</p>}
              </div>
              {casError && (
                <Alert variant="destructive">
                  <ShieldCheckIcon aria-hidden="true" />
                  <AlertTitle>无法发起校园认证</AlertTitle>
                  <AlertDescription>{casError}</AlertDescription>
                </Alert>
              )}
              <Button
                type="button"
                size="lg"
                className="w-full"
                disabled={submitting}
                onClick={() => void handleCasLogin()}
              >
                {submitting ? (
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                ) : (
                  <ShieldCheckIcon aria-hidden="true" />
                )}
                {submitting ? '正在跳转学校认证…' : '使用校园 CAS 登录'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => setStep(1)}
              >
                <ArrowLeftIcon aria-hidden="true" />
                返回上一步
              </Button>
            </section>
          ) : (
            <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmitApplication(event)}>
              <div className="flex flex-col gap-1">
                <p className="text-sm leading-[22px] font-medium text-foreground">提交申请</p>
                <p className="text-sm leading-[22px] text-muted-foreground">
                  校园认证已返回。补充入学年份与联系方式后提交，服务端会再次核验邀请与认证凭证。
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="registration-grade">入学年份（选填）</Label>
                <Input id="registration-grade" type="number" min="1900" max="2100" inputMode="numeric" value={grade} onChange={(event) => setGrade(event.target.value)} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="registration-phone">联系方式（选填）</Label>
                <Input id="registration-phone" type="tel" maxLength={32} autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />
              </div>
              {casError && <Alert variant="destructive"><AlertTitle>申请未提交成功</AlertTitle><AlertDescription>{casError}</AlertDescription></Alert>}
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={submitting}
              >
                {submitting ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : <SendIcon aria-hidden="true" />}
                {submitting ? '正在提交…' : '提交入社申请'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => { setStep(1); setCasError(null); }}
              >
                <ArrowLeftIcon aria-hidden="true" />
                重新验证邀请
              </Button>
            </form>
          )}

          <p className="-mx-4 -mb-4 rounded-b-3xl border-t border-border bg-muted/35 px-4 py-5 text-center text-sm leading-[22px] text-muted-foreground min-[375px]:-mx-5 min-[375px]:-mb-5 min-[375px]:px-5 md:mx-0 md:mb-0 md:rounded-none md:border-0 md:bg-transparent md:p-0 md:text-left">
            已经有账号？{' '}
            <Link
              to="/login"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              直接登录
            </Link>
          </p>
          </section>
        </div>
      </main>
      <Dialog open={scannerOpen} onOpenChange={setScannerOpen}>
        <DialogContent className="p-4 sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>扫描邀请码</DialogTitle>
            <DialogDescription>将协会邀请二维码放入取景框，也可以手动输入。</DialogDescription>
          </DialogHeader>
          {scannerOpen && (
            <Suspense fallback={<p role="status" className="py-8 text-center text-sm text-muted-foreground">正在准备扫码…</p>}>
              <QrScanner
                purpose="invitation"
                parseValue={(raw) => parseInvitationQr(raw, window.location.origin)}
                onToken={(code) => {
                  setScannerOpen(false);
                  setInviteCode(code);
                  void verifyInvitation(code);
                }}
              />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
