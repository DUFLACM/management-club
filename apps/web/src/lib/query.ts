/**
 * TanStack Query 全局配置与私人缓存隔离。
 *
 * - 默认 staleTime 30s：列表进入 30s 内不重复请求；
 * - 私人数据 key 规范 ['principal', principalId, resource, scope]，
 *   通过 usePrivateQuery 构造，保证不同账号缓存永不混用；
 * - 登录/登出（含 401）时 queryClient.clear() 清空全部缓存，
 *   通过 'club:session-changed' 与 'club:unauthorized' 事件驱动。
 */
import {
  QueryClient,
  useQuery,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApiError, UNAUTHORIZED_EVENT } from './api';

export const SESSION_CHANGED_EVENT = 'club:session-changed';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            return false;
          }
          return failureCount < 2;
        },
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/** 监听会话事件：登录/登出/401 后清空缓存（私人缓存隔离的兜底）。 */
export function attachSessionListeners(queryClient: QueryClient): () => void {
  const clear = () => {
    queryClient.clear();
    queryClient.cancelQueries();
  };
  window.addEventListener(SESSION_CHANGED_EVENT, clear);
  window.addEventListener(UNAUTHORIZED_EVENT, clear);
  return () => {
    window.removeEventListener(SESSION_CHANGED_EVENT, clear);
    window.removeEventListener(UNAUTHORIZED_EVENT, clear);
  };
}

/** 应用启动时创建唯一 QueryClient 并挂接会话事件。 */
export function setupQueryClient(): QueryClient {
  const client = createQueryClient();
  attachSessionListeners(client);
  return client;
}

export type PrivateQueryKey = readonly [
  'principal',
  principal: string,
  resource: string,
  ...scope: unknown[],
];

/**
 * 私人数据查询：key 固定为 ['principal', principalId, resource, ...scope]。
 * principalId 未知（会话尚未加载）时不发起请求。
 */
export function usePrivateQuery<
  TQueryFnData,
  TError = ApiError,
  TData = TQueryFnData,
>(
  principalId: string | null | undefined,
  key: [resource: string, ...scope: unknown[]],
  queryFn: () => Promise<TQueryFnData>,
  options?: Omit<
    UseQueryOptions<TQueryFnData, TError, TData, PrivateQueryKey>,
    'queryKey' | 'queryFn' | 'enabled'
  > & { enabled?: boolean },
): UseQueryResult<TData, TError> {
  const principal = principalId ?? 'anonymous';
  const { enabled, ...rest } = options ?? {};
  return useQuery<TQueryFnData, TError, TData, PrivateQueryKey>({
    queryKey: ['principal', principal, ...key],
    queryFn,
    enabled: principalId != null && (enabled ?? true),
    ...rest,
  });
}

/** 组件卸载防护的便捷 hook：确保监听器在 App 根挂接一次。 */
export function useSessionCacheClear(queryClient: QueryClient): void {
  useEffect(() => attachSessionListeners(queryClient), [queryClient]);
}
