import type { ReactNode } from 'react';
import { LinkIcon, LoaderCircleIcon } from 'lucide-react';

import { api, type ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import type { CsrfSession } from '@/lib/session';
import { ErrorState } from '@/components/club/ErrorState';
import { BindForm, BindingGuide, useBindPlatformAccount } from '@/components/club/BindPlatformAccountDialog';
import { performLogout } from '@/workspaces/shared/WorkspaceShell';

/**
 * 登录绑定门：校园账号（学生）登录后若没有未解绑的牛客账号，整个工作台替换为牛客绑定页
 * （默认展开教程），只能提交绑定或退出登录。Codeforces / AtCoder 不强制，可在「竞赛」页自愿绑定。
 * 提交后状态为待核验即可放行——历史成绩导入与平台赛计分都按绑定账号自动匹配。
 * 教职工与本地管理员没有平台账号，不拦截。
 * 是否已绑定优先取会话（GET /auth/csrf 的 nowcoderBound），不再额外串行请求；旧版接口没有该字段时才查平台账号列表。
 */
export function PlatformBindingGate({ principal, children }: { principal: CsrfSession; children: ReactNode }) {
  const isStudent = principal.principalKind === 'student' && principal.userId != null;
  const knownBound = principal.nowcoderBound;
  const accountsQuery = usePrivateQuery<Array<{ id: string; platform: string }>, ApiError>(
    principal.principalId,
    ['me', 'platform-accounts'],
    async () => (await api.get<Array<{ id: string; platform: string }>>('/me/platform-accounts')).data,
    { enabled: isStudent && knownBound == null },
  );

  if (!isStudent || knownBound === true) return <>{children}</>;
  if (knownBound === false) {
    return <BindingRequired principalId={principal.principalId!} principalKind={principal.principalKind} />;
  }

  if (accountsQuery.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background px-4 text-sm text-muted-foreground" role="status">
        <LoaderCircleIcon className="mr-2 animate-spin" aria-hidden="true" />
        正在检查平台账号绑定…
      </div>
    );
  }

  if (accountsQuery.isError) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background px-4">
        <ErrorState
          title="无法检查平台账号绑定"
          description={accountsQuery.error.message}
          onRetry={() => void accountsQuery.refetch()}
          retrying={accountsQuery.isFetching}
        />
      </div>
    );
  }

  if (accountsQuery.data.some((account) => account.platform === 'nowcoder')) return <>{children}</>;

  return <BindingRequired principalId={principal.principalId!} principalKind={principal.principalKind} />;
}

function BindingRequired({ principalId, principalKind }: { principalId: string; principalKind: string | null }) {
  const mutation = useBindPlatformAccount(principalId);
  return (
    <main className="flex min-h-dvh justify-center bg-background px-4 py-8 sm:py-14">
      <div className="flex w-full max-w-lg flex-col gap-5">
        <header className="flex flex-col gap-2">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <LinkIcon className="size-5" aria-hidden="true" />
          </span>
          <h1 className="text-xl font-semibold text-foreground">先绑定牛客账号</h1>
          <p className="text-sm text-muted-foreground">
            社团周赛、月赛和历史积分都按绑定的牛客账号自动计分，绑定后才能进入系统。Codeforces、AtCoder 不强制，需要的话以后在「竞赛」页绑定。
          </p>
        </header>
        <BindingGuide defaultOpen />
        <BindForm
          defaultPlatform="nowcoder"
          lockPlatform
          submitting={mutation.isPending}
          onSubmit={(input) => mutation.mutate(input)}
          onCancel={() => void performLogout(principalKind)}
          cancelLabel="退出登录"
          error={mutation.isError ? (mutation.error as ApiError).message : null}
        />
      </div>
    </main>
  );
}
