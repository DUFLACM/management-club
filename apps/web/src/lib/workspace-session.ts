import { useQuery } from '@tanstack/react-query';

import { api, type ApiError } from './api';
import { usePrincipalQuery } from './session';
import type { WorkspaceUser } from '@/workspaces/shared/WorkspaceShell';

interface SessionDetails {
  principalId: string;
  principalKind: string;
  userId: string | null;
  realName: string | null;
  roles: string[];
}

/** 外壳姓名与授权角色取自服务端会话，业务面板继续共用 usePrincipal。 */
export function useWorkspaceSession() {
  const principalQuery = usePrincipalQuery();
  const principal = principalQuery.data ?? null;
  const details = useQuery<SessionDetails, ApiError>({
    queryKey: ['session', 'details'],
    queryFn: async () => (await api.get<SessionDetails>('/auth/session')).data,
    enabled: principal?.authenticated === true,
    staleTime: 60_000,
  });
  const principalKind = details.data?.principalKind ?? principal?.principalKind ?? null;
  const fallbackName = principalKind === 'system'
    ? '管理员'
    : principalKind === 'staff'
      ? '教职工账号'
      : '校园账号';
  const displayName = details.data?.realName || (principal?.authenticated ? fallbackName : '未登录');
  const user: WorkspaceUser = {
    displayName,
    avatarText: displayName.slice(0, 1),
    membershipLabel: principal?.authenticated
      ? principalKind === 'system'
        ? '本地管理员'
        : principalKind === 'staff'
          ? '教职工账号'
          : '校园账号'
      : '请先登录',
    roles: details.data?.roles ?? principal?.roles ?? [],
  };
  return { principal, user, isPending: principalQuery.isPending,
    error: principalQuery.error, refetch: principalQuery.refetch };
}
