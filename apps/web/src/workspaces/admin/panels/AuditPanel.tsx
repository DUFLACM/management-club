/**
 * 管理端 · 审计（audit.read）：GET /admin/audit-logs?resourceType=&cursor=。
 * 筛选 + 游标分页；不展示凭证明文（脱敏说明）。
 */
import { useState } from 'react';

import { api, ApiError } from '@/lib/api';
import { usePrivateInfiniteQuery } from '@/lib/private-infinite';
import { usePrincipal } from '@/lib/session';
import { LoadMoreButton } from '@/lib/hooks';
import { formatDateTime } from '@/lib/format';
import { PanelHeader } from '@/components/club/PanelHeader';
import { PrincipalGate } from '@/components/club/QueryBoundary';
import { EmptyState } from '@/components/club/EmptyState';
import { ErrorState } from '@/components/club/ErrorState';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

interface AuditLogDto {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string;
  summary: string | null;
  createdAt: string;
}

const RESOURCE_TYPES: ReadonlyArray<string> = [
  'activity',
  'venue',
  'user',
  'invitation',
  'points_ledger',
  'attendance_result',
  'disclosure',
  'site_setting',
  'secret_reference',
];

export default function AuditPanel() {
  const principal = usePrincipal();
  return (
    <PrincipalGate principal={principal}>
      {(principalId) => <AuditBody principalId={principalId} />}
    </PrincipalGate>
  );
}

function AuditBody({ principalId }: { principalId: string }) {
  const [resourceType, setResourceType] = useState('all');

  const listQuery = usePrivateInfiniteQuery<
    { items: AuditLogDto[]; nextCursor?: string | null },
    ApiError
  >(principalId, ['admin', 'audit-logs', resourceType], async (cursor) => {
    const params = new URLSearchParams();
    if (resourceType !== 'all') params.set('resourceType', resourceType);
    if (cursor) params.set('cursor', cursor);
    const { data } = await api.get<{ items: AuditLogDto[]; nextCursor?: string | null }>(
      `/admin/audit-logs?${params.toString()}`,
    );
    return data;
  });

  const items = listQuery.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader title="审计" description="管理操作的追加式审计记录（脱敏）。" />

      <Alert>
        <AlertDescription>
          审计记录不含凭证明文：不展示 CAS ticket、邀请码明文、定位坐标原文与密钥值，
          只保留操作者、动作与资源摘要。
        </AlertDescription>
      </Alert>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select value={resourceType} onValueChange={setResourceType}>
          <SelectTrigger className="sm:w-56" aria-label="资源类型筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部资源类型</SelectItem>
            {RESOURCE_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {listQuery.isPending ? (
        <Card>
          <CardContent className="flex flex-col gap-2 p-5">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-10" />
            ))}
          </CardContent>
        </Card>
      ) : listQuery.isError ? (
        <Card>
          <CardContent className="py-10">
            {listQuery.error.status === 403 ? (
              <EmptyState kind="forbidden" description={listQuery.error.message} />
            ) : (
              <ErrorState
                description={listQuery.error.message}
                onRetry={() => void listQuery.refetch()}
                retrying={listQuery.isFetching}
              />
            )}
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10">
            <EmptyState kind="empty" description="该筛选下暂无审计记录。" />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 pb-2">
            <ul className="flex flex-col divide-y divide-border">
              {items.map((log) => (
                <li key={log.id} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-center sm:gap-4">
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums sm:w-40">
                    {formatDateTime(log.createdAt)}
                  </span>
                  <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground/80 sm:w-48">
                    {log.action}
                  </span>
                  <span className="min-w-0 flex-1 text-sm text-foreground/90">
                    {log.summary ?? `${log.resourceType}:${log.resourceId.slice(0, 8)}`}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {log.resourceType}/{log.resourceId.slice(0, 8)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="px-5">
              <LoadMoreButton
                onClick={() => {
                  void listQuery.fetchNextPage();
                }}
                loading={listQuery.isFetchingNextPage}
                hasNext={Boolean(listQuery.data?.pages.at(-1)?.nextCursor)}
                hint="已展示全部记录"
              />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
