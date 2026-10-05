/**
 * 管理端 · 赛事：GET /admin/freezes + POST /admin/freezes（competitions.manage）。
 * 冻结榜详情行通过 GET /me/leaderboard?kind=frozen&ref= 读取；
 * 赛事报名列表暂以冻结榜快照展示（正式名单以平台报名为准）。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon, PlusIcon } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrincipal } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { PanelHeader } from '@/components/club/PanelHeader';
import { PrincipalGate, QueryBoundary } from '@/components/club/QueryBoundary';
import { StatusBadge } from '@/components/club/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface FreezeDto {
  id: string;
  contestKey: string;
  title: string;
  freezeAt: string;
  status: string;
  rows: Array<{ id: string; position: number; userId: string; eSnapshot: string; eligible: boolean }>;
}

interface FrozenBoardDto {
  kind: string;
  title: string;
  frozenAt: string;
  rows: Array<{
    position: number;
    userId: string;
    eSnapshot: string;
    qScore: string | null;
    eligible: boolean;
  }>;
}

export default function ContestsPanel() {
  const principal = usePrincipal();
  return (
    <PrincipalGate principal={principal}>
      {(principalId) => <ContestsBody principalId={principalId} />}
    </PrincipalGate>
  );
}

function ContestsBody({ principalId }: { principalId: string }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const listQuery = usePrivateQuery<FreezeDto[], ApiError>(
    principalId,
    ['admin', 'freezes'],
    async () => (await api.get<FreezeDto[]>('/admin/freezes')).data,
    { refetchInterval: 15_000 },
  );

  const boardQuery = usePrivateQuery<FrozenBoardDto, ApiError>(
    principalId,
    ['me', 'leaderboard', 'frozen', selectedId ?? 'none'],
    async () =>
      (await api.get<FrozenBoardDto>(`/me/leaderboard?kind=frozen&ref=${selectedId}`)).data,
    { enabled: selectedId != null },
  );

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="赛事"
        description="赛事冻结榜的创建与查看；报名截止前一日 22:00 冻结。"
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon aria-hidden="true" />
            创建冻结
          </Button>
        }
      />

      <QueryBoundary
        query={listQuery}
        isEmpty={(list) => list.length === 0}
        emptyNode={
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              暂无冻结榜；比赛报名截止前创建，冻结后回填不改变名单。
            </CardContent>
          </Card>
        }
      >
        {(list) => (
          <Card>
            <CardContent className="p-0 pb-2">
              <ul className="flex flex-col divide-y divide-border">
                {list.map((freeze) => (
                  <li key={freeze.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(freeze.id === selectedId ? null : freeze.id)}
                      disabled={freeze.status !== 'frozen'}
                      aria-expanded={freeze.id === selectedId}
                      className="flex w-full flex-wrap items-center justify-between gap-2 p-4 text-left hover:bg-muted/40"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-foreground">
                          {freeze.title}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {freeze.contestKey} · {freeze.status === 'frozen' ? '冻结于' : '计划冻结于'} {formatDateTime(freeze.freezeAt)}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <StatusBadge kind="disclosure" value={freeze.status === 'frozen' ? '已冻结' : '待冻结'} />
                        <span className="text-xs text-muted-foreground tabular-nums">
                          预览 {freeze.rows.length} 行
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </QueryBoundary>

      {selectedId && (
        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            <QueryBoundary query={boardQuery}>
              {(board) => (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      {board.title}
                      <StatusBadge kind="disclosure" value="已冻结" />
                    </h2>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      冻结于 {formatDateTime(board.frozenAt)}；赛事报名名单以此快照为准。
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-20">名次</TableHead>
                          <TableHead>成员</TableHead>
                          <TableHead className="text-right">E 快照</TableHead>
                          <TableHead className="text-right">Q 分</TableHead>
                          <TableHead>出场资格</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {board.rows.map((row) => (
                          <TableRow key={row.userId}>
                            <TableCell className="tabular-nums">{row.position}</TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">
                              {row.userId.slice(0, 8)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{row.eSnapshot}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {row.qScore ?? '—'}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {row.eligible ? '具备' : '不具备'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    平台侧报名以平台为准；此表为社团冻结快照（回填成绩不改变出场资格）。
                  </p>
                </>
              )}
            </QueryBoundary>
          </CardContent>
        </Card>
      )}

      {createOpen && (
        <CreateFreezeDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'freezes'] });
          }}
        />
      )}
    </div>
  );
}

function CreateFreezeDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [contestKey, setContestKey] = useState('');
  const [title, setTitle] = useState('');
  const [freezeAt, setFreezeAt] = useState('');
  const mutation = useMutation({
    mutationFn: async () => {
      await api.post('/admin/freezes', {
        contestKey: contestKey.trim(),
        title: title.trim(),
        freezeAt: new Date(freezeAt).toISOString(),
      });
      return true;
    },
    onSuccess: onCreated,
  });

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">创建赛事冻结榜</h2>
          <Button size="sm" variant="ghost" onClick={onClose}>
            收起
          </Button>
        </div>
        {mutation.isError && (
          <Alert variant="destructive">
            <AlertTitle>创建失败</AlertTitle>
            <AlertDescription>{(mutation.error as ApiError).message}</AlertDescription>
          </Alert>
        )}
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (contestKey.trim().length >= 2 && title.trim().length >= 2 && freezeAt) {
              mutation.mutate();
            }
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="freeze-key">赛事键（2-120 字）</Label>
            <Input
              id="freeze-key"
              value={contestKey}
              onChange={(event) => setContestKey(event.target.value)}
              placeholder="如 ccpc-2026-selection"
              required
              minLength={2}
              maxLength={120}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="freeze-title">名称</Label>
            <Input
              id="freeze-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              minLength={2}
              maxLength={120}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="freeze-at">冻结时间</Label>
            <Input
              id="freeze-at"
              type="datetime-local"
              value={freezeAt}
              onChange={(event) => setFreezeAt(event.target.value)}
              required
            />
          </div>
          <div className="sm:col-span-3">
            <Button
              type="submit"
              disabled={
                mutation.isPending || contestKey.trim().length < 2 || !freezeAt || title.trim().length < 2
              }
            >
              {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
              创建（默认报名截止前一日 22:00）
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
