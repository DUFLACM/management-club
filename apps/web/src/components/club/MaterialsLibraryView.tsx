/**
 * 成员端 · 资料与题解中心（跨活动检索）：
 * GET /materials?q=&kind=&cursor=
 * 汇总全部已发布/归档活动下的讲题幻灯片、题解与测试数据，支持按关键词和类型筛选、PDF/文本在线预览及下载。
 */
import { useState } from 'react';
import {
  BookOpenIcon,
  EyeIcon,
  FileDownIcon,
  SearchIcon,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateInfiniteQuery } from '@/lib/private-infinite';
import { LoadMoreButton, useDebouncedValue } from '@/lib/hooks';
import { activityTypeLabel, formatDateTime } from '@/lib/format';
import { EmptyState } from '@/components/club/EmptyState';
import { ErrorState } from '@/components/club/ErrorState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

interface LibraryMaterialDto {
  id: string;
  activityId: string;
  activityTitle: string;
  activityType: string;
  activityStartAt: string;
  title: string;
  kind: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  uploaderName: string;
  createdAt: string;
}

const KIND_LABELS: Record<string, string> = {
  solution: '题解',
  slides: '讲题幻灯片',
  data: '测试数据',
  other: '其他资料',
};

function formatFileSize(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function canInlinePreview(mimeType: string | null, fileName: string): boolean {
  if (mimeType === 'application/pdf' || mimeType === 'text/plain' || mimeType === 'text/markdown') {
    return true;
  }
  return /\.(pdf|md|txt)$/i.test(fileName);
}

export function MaterialsLibraryView({
  principalId,
  onOpenActivity,
}: {
  principalId: string;
  onOpenActivity: (activityId: string) => void;
}) {
  const [searchInput, setSearchInput] = useState('');
  const [kind, setKind] = useState('all');
  const debounced = useDebouncedValue(searchInput, 400);

  const query = usePrivateInfiniteQuery<
    { items: LibraryMaterialDto[]; nextCursor?: string | null },
    ApiError
  >(
    principalId,
    ['materials', 'library', kind, debounced],
    async (cursor) => {
      const params = new URLSearchParams();
      if (kind !== 'all') params.set('kind', kind);
      if (debounced) params.set('q', debounced);
      if (cursor) params.set('cursor', cursor);
      const qs = params.toString();
      return (await api.get<{ items: LibraryMaterialDto[]; nextCursor?: string | null }>(`/materials${qs ? `?${qs}` : ''}`)).data;
    },
  );

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:w-72">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="搜索题解标题、文件名或所属活动"
            className="pl-9"
            aria-label="搜索资料库"
          />
        </div>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="sm:w-44" aria-label="按资料类型筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部资料类型</SelectItem>
            {Object.entries(KIND_LABELS).map(([v, label]) => (
              <SelectItem key={v} value={v}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {query.isPending ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {[0, 1, 2, 3].map((idx) => (
            <Skeleton key={idx} className="h-32 rounded-2xl" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState description={query.error.message} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10">
            <EmptyState
              kind="empty"
              title="暂无匹配的资料"
              description={
                debounced || kind !== 'all'
                  ? '尝试放宽关键词或切换资料类型。'
                  : '讲题人上传幻灯片或题解后，所有社团资料会自动沉淀到这里供检索下载。'
              }
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {items.map((item) => {
              const downloadHref = `/api/v1/activities/${item.activityId}/materials/${item.id}/download`;
              const previewable = canInlinePreview(item.mimeType, item.fileName);
              return (
                <Card key={item.id} className="transition-colors hover:border-primary/35">
                  <CardContent className="flex h-full flex-col justify-between gap-3 p-4 sm:p-5">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{KIND_LABELS[item.kind] ?? item.kind}</Badge>
                        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground" title={item.title}>
                          {item.title}
                        </h3>
                      </div>
                      <p className="truncate text-xs text-muted-foreground" title={item.fileName}>
                        {item.fileName} · {formatFileSize(item.sizeBytes)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        上传者：{item.uploaderName} · {formatDateTime(item.createdAt)}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                      <button
                        type="button"
                        onClick={() => onOpenActivity(item.activityId)}
                        className="inline-flex min-w-0 items-center gap-1.5 truncate text-xs font-medium text-primary hover:underline"
                      >
                        <BookOpenIcon className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="truncate">
                          {item.activityTitle}（{activityTypeLabel(item.activityType)}）
                        </span>
                      </button>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {previewable && (
                          <Button asChild size="sm" variant="ghost">
                            <a href={`${downloadHref}?inline=1`} target="_blank" rel="noreferrer">
                              <EyeIcon className="size-3.5" aria-hidden="true" />
                              预览
                            </a>
                          </Button>
                        )}
                        <Button asChild size="sm" variant="outline">
                          <a href={downloadHref} download={item.fileName}>
                            <FileDownIcon className="size-3.5" aria-hidden="true" />
                            下载
                          </a>
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <LoadMoreButton
            onClick={() => void query.fetchNextPage()}
            loading={query.isFetchingNextPage}
            hasNext={Boolean(query.data?.pages.at(-1)?.nextCursor)}
            hint="已展示全部资料"
          />
        </>
      )}
    </div>
  );
}
