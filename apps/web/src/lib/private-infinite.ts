/**
 * 私人游标分页查询：usePrivateQuery 的无限滚动版本。
 * key 规范同为 ['principal', principalId, resource, ...scope]，
 * pageParam 为不透明 cursor（由后端 nextCursor 提供，缺省即无更多页）。
 */
import {
  useInfiniteQuery,
  type UseInfiniteQueryOptions,
  type UseInfiniteQueryResult,
  type InfiniteData,
} from '@tanstack/react-query';

import type { ApiError } from './api';
import type { PrivateQueryKey } from './query';

export interface CursorPage<T> {
  items: T[];
  /** 缺省（undefined/null）表示没有更多页 */
  nextCursor?: string | null;
}

export function usePrivateInfiniteQuery<TPage extends CursorPage<unknown>, TError = ApiError>(
  principalId: string | null | undefined,
  key: [resource: string, ...scope: unknown[]],
  queryFn: (cursor: string | undefined) => Promise<TPage>,
  options?: Omit<
    UseInfiniteQueryOptions<
      TPage,
      TError,
      InfiniteData<TPage>,
      PrivateQueryKey,
      string | undefined
    >,
    'queryKey' | 'queryFn' | 'enabled' | 'initialPageParam' | 'getNextPageParam'
  > & { enabled?: boolean },
): UseInfiniteQueryResult<InfiniteData<TPage>, TError> {
  const principal = principalId ?? 'anonymous';
  const { enabled, ...rest } = options ?? {};
  return useInfiniteQuery<
    TPage,
    TError,
    InfiniteData<TPage>,
    PrivateQueryKey,
    string | undefined
  >({
    queryKey: ['principal', principal, ...key],
    queryFn: ({ pageParam }) => queryFn(pageParam),
    enabled: principalId != null && (enabled ?? true),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    ...rest,
  });
}
