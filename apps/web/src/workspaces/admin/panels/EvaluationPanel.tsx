/**
 * 管理端 · 综评导出（evaluation.manage）：按附录三《综合素质评价建议折算表》实时生成与导出学期建议分及积分。
 * - 不限学期结束时间，任何时候均可实时导出或生成可编辑快照，且不锁定；
 * - 表单内支持「实时导出综评表（含积分）」与「导出成员积分表」；
 * - GET/POST /admin/evaluation/batches、GET /admin/evaluation/batches/:id
 * - POST /admin/evaluation/batches/:id/rows/:rowId（逐人修改，保存后自动重算定档）
 * - POST /admin/evaluation/batches/:id/refresh（同步最新实时积分）
 * - GET /admin/evaluation/semesters/:id/export & /points-export（按学期实时直接导出）
 * - GET /admin/evaluation/batches/:id/export & /points-export（按快照导出综评含积分 / 全员积分明细）
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DownloadIcon,
  FileSpreadsheetIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCwIcon,
  Trash2Icon,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrincipal } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { PanelHeader } from '@/components/club/PanelHeader';
import { PrincipalGate, QueryBoundary } from '@/components/club/QueryBoundary';
import { EmptyState } from '@/components/club/EmptyState';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface SemesterDto {
  id: string;
  code: string;
  name: string;
  startsOn: string;
  endsOn: string;
  ended: boolean;
  canGenerate: boolean;
}

interface SemestersDto {
  testMode: boolean;
  semesters: SemesterDto[];
}

interface BatchSummaryDto {
  id: string;
  semesterCode: string;
  semesterName: string;
  status: string;
  isTest: boolean;
  memberCount: number;
  rowCount: number;
  generatedAt: string;
  publishedAt: string | null;
}

interface RowDto {
  id: string;
  studentNo: string;
  realName: string;
  membership?: string;
  currentE?: number;
  semesterTotal?: number;
  activityRaw?: number;
  contestRaw?: number;
  serviceRaw?: number;
  pointsAvg: number;
  pointsStd: number;
  contestStd: number;
  serviceStd: number;
  disciplinePenalty: number;
  hScore: number;
  rankNo: number | null;
  tier: string | null;
  suggestedScore: number;
  finalScore: number;
  overridden: boolean;
  computed: { pointsStd: number; contestStd: number; serviceStd: number; penalty: number };
  overrides: {
    pointsStd: number | null;
    contestStd: number | null;
    serviceStd: number | null;
    penalty: number | null;
    score: number | null;
  };
  overrideReason: string | null;
  excluded: boolean;
  excludeReason: string | null;
  cadre: boolean;
  tiebreak: { recentPoints: number; recentContest: number; recentActivity: number; needsManual: boolean } | null;
}

interface BatchDetailDto {
  batch: {
    id: string;
    semesterCode: string;
    semesterName: string;
    status: string;
    isTest: boolean;
    memberCount: number;
    note: string | null;
    generatedAt: string;
    publishedAt: string | null;
  };
  rows: RowDto[];
}

export default function EvaluationPanel() {
  const principal = usePrincipal();
  return (
    <PrincipalGate principal={principal}>
      {(principalId) => <EvaluationBody principalId={principalId} />}
    </PrincipalGate>
  );
}

function EvaluationBody({ principalId }: { principalId: string }) {
  const queryClient = useQueryClient();
  const [semesterId, setSemesterId] = useState('');
  const [batchId, setBatchId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'evaluation'] });
  };

  const semestersQuery = usePrivateQuery<SemestersDto>(principalId, ['admin', 'evaluation', 'semesters'], async () => {
    const { data } = await api.get<SemestersDto>('/admin/evaluation/semesters');
    return data;
  });

  const batchesQuery = usePrivateQuery<BatchSummaryDto[]>(principalId, ['admin', 'evaluation', 'batches'], async () => {
    const { data } = await api.get<BatchSummaryDto[]>('/admin/evaluation/batches');
    return data;
  });

  const semesters = semestersQuery.data?.semesters ?? [];

  // 默认选中最新学期，打开页面即可一键实时生成或导出
  useEffect(() => {
    if (!semesterId && semesters.length > 0) {
      setSemesterId(semesters[0]!.id);
    }
  }, [semesterId, semesters]);

  const generateMutation = useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<{ batchId: string; isTest: boolean; rowCount: number }>(
        '/admin/evaluation/batches',
        { semesterId: id },
      );
      return data;
    },
    onSuccess: (result) => {
      setActionError(null);
      setBatchId(result.batchId);
      invalidate();
    },
    onError: (error: ApiError) => setActionError(error.message),
  });

  const selectedSemester = semesters.find((s) => s.id === semesterId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="综评与积分导出"
        description="按附录三实时生成学期综合素质评价建议分与成员积分，不受学期结束时间限制，不锁定，支持随时调整与导出。"
      />

      <Card>
        <CardContent className="flex flex-col gap-3 p-5">
          <h2 className="text-sm font-semibold text-foreground">实时生成与导出</h2>
          <QueryBoundary query={semestersQuery}>
            {() =>
              semesters.length === 0 ? (
                <EmptyState kind="empty" description="还没有学期记录，先在设置中建立学期。" />
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <div className="grid flex-1 gap-1.5">
                      <Label htmlFor="evaluation-semester">学期</Label>
                      <select
                        id="evaluation-semester"
                        value={semesterId}
                        onChange={(event) => setSemesterId(event.target.value)}
                        className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        <option value="">请选择学期</option>
                        {semesters.map((semester) => (
                          <option key={semester.id} value={semester.id}>
                            {semester.code} {semester.name}
                            {semester.ended ? '（已结束）' : '（进行中 · 实时）'}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={!selectedSemester || generateMutation.isPending}
                        onClick={() => selectedSemester && generateMutation.mutate(selectedSemester.id)}
                      >
                        {generateMutation.isPending ? (
                          <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                        ) : (
                          <PlusIcon aria-hidden="true" />
                        )}
                        生成实时名单
                      </Button>
                      {selectedSemester ? (
                        <>
                          <Button asChild variant="outline">
                            <a href={`/api/v1/admin/evaluation/semesters/${selectedSemester.id}/export`}>
                              <DownloadIcon aria-hidden="true" />
                              实时导出综评表（含积分）
                            </a>
                          </Button>
                          <Button asChild variant="outline">
                            <a href={`/api/v1/admin/evaluation/semesters/${selectedSemester.id}/points-export`}>
                              <FileSpreadsheetIcon aria-hidden="true" />
                              实时导出积分表
                            </a>
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button variant="outline" disabled>
                            <DownloadIcon aria-hidden="true" />
                            实时导出综评表（含积分）
                          </Button>
                          <Button variant="outline" disabled>
                            <FileSpreadsheetIcon aria-hidden="true" />
                            实时导出积分表
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    「实时导出综评表（含积分）」直接导出当前最新定档结果（含学号、姓名、有效积分、学期总积分、月均积分、H 分、档位与加分）；
                    「实时导出积分表」导出全员积分明细（含活动/竞赛/服务/扣分构成）；如需逐人手工调整后再导出，可点击「生成实时名单」。
                  </p>
                </div>
              )
            }
          </QueryBoundary>

          {actionError && (
            <Alert variant="destructive">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}

          <details className="rounded-lg bg-muted/60 p-3 text-xs leading-5 text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">折算口径（附录三）</summary>
            <p className="mt-2">H = 0.70×积分标准分 + 0.20×竞赛标准分 + 0.10×服务标准分 − 纪律扣减。</p>
            <ul className="mt-1 list-disc pl-4">
              <li>积分标准分：学期各月积分平均值在符合评价条件成员中的百分位（0–100）；未发布月度积分的月份自动按实时流水聚合</li>
              <li>竞赛标准分：学期内 正式赛/远程赛/获奖 账目合计的百分位</li>
              <li>服务标准分：学期内 贡献/服务 账目合计的百分位</li>
              <li>纪律扣减：学期内 penalty 账目金额合计 1:1 扣减 H，上限 20 分</li>
              <li>按 H 降序 1:2:7 定 A/B/C 档；A 档 1.0，B 档 1.0→0.5 等差，C 档 0.5→0 等差</li>
              <li>并列按近三个月有效积分 → 正式竞赛积分 → 活动积分比较，仍相同者标注「需人工认定」</li>
            </ul>
            <p className="mt-2">
              干部口径（社长按部长级、副社长按副部长级）需另行申报，主席团成员单列在下方可随时手工给分。
              结果只是社团内部排序与建议值，不等同学院最终记分。
            </p>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <h2 className="border-b border-border p-5 pb-3 text-sm font-semibold text-foreground">已生成名单快照（随时可改、不锁定）</h2>
          <QueryBoundary query={batchesQuery}>
            {(batches) =>
              batches.length === 0 ? (
                <div className="p-5">
                  <EmptyState kind="empty" description="还没有已保存的综评快照；可直接点击上方实时导出，或点「生成实时名单」进行逐人调整。" />
                </div>
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {batches.map((batch) => (
                    <li key={batch.id}>
                      <button
                        type="button"
                        onClick={() => setBatchId(batch.id === batchId ? null : batch.id)}
                        className={`flex w-full flex-wrap items-center gap-2 p-4 text-left transition-colors hover:bg-muted/60 ${batch.id === batchId ? 'bg-muted/60' : ''}`}
                      >
                        <span className="text-sm font-medium text-foreground">
                          {batch.semesterCode} {batch.semesterName}
                        </span>
                        <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          可编辑
                        </span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          定档 {batch.memberCount} / 共 {batch.rowCount} 人 · {formatDateTime(batch.generatedAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </QueryBoundary>
        </CardContent>
      </Card>

      {batchId && <BatchDetail principalId={principalId} batchId={batchId} onDeleted={() => setBatchId(null)} />}
    </div>
  );
}

function BatchDetail({
  principalId,
  batchId,
  onDeleted,
}: {
  principalId: string;
  batchId: string;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const detailQuery = usePrivateQuery<BatchDetailDto>(
    principalId,
    ['admin', 'evaluation', 'batch', batchId],
    async () => {
      const { data } = await api.get<BatchDetailDto>(`/admin/evaluation/batches/${batchId}`);
      return data;
    },
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin', 'evaluation'] });
  };

  const actionMutation = useMutation({
    mutationFn: async (action: 'recompute' | 'refresh' | 'delete') => {
      if (action === 'delete') await api.delete(`/admin/evaluation/batches/${batchId}`);
      else await api.post(`/admin/evaluation/batches/${batchId}/${action}`);
      return action;
    },
    onSuccess: (action) => {
      setError(null);
      if (action === 'delete') {
        onDeleted();
      } else if (action === 'refresh') {
        setNotice('已按最新积分账本同步并重新定档（已保留手工修改项）。');
      } else {
        setNotice('已按当前分量重新计算 H 分与定档。');
      }
      invalidate();
    },
    onError: (err: ApiError) => {
      setNotice(null);
      setError(err.message);
    },
  });

  return (
    <QueryBoundary query={detailQuery}>
      {({ batch, rows }) => {
        const tiered = rows.filter((r) => r.tier != null && !r.excluded && !r.cadre);
        const cadres = rows.filter((r) => r.cadre && !r.excluded);
        const excluded = rows.filter((r) => r.excluded);
        return (
          <Card>
            <CardContent className="flex flex-col gap-4 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-foreground">
                  {batch.semesterCode} {batch.semesterName} · 建议名单与积分
                </h2>
                <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground tabular-nums">
                  更新于 {formatDateTime(batch.generatedAt)}
                </span>
              </div>

              {batch.note && <p className="text-xs leading-5 text-muted-foreground">{batch.note}</p>}

              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <a href={`/api/v1/admin/evaluation/batches/${batch.id}/export`}>
                    <DownloadIcon aria-hidden="true" />
                    导出综评表（含积分）
                  </a>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <a href={`/api/v1/admin/evaluation/batches/${batch.id}/points-export`}>
                    <FileSpreadsheetIcon aria-hidden="true" />
                    导出积分明细表
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionMutation.isPending}
                  onClick={() => actionMutation.mutate('refresh')}
                >
                  {actionMutation.isPending && actionMutation.variables === 'refresh' ? (
                    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  ) : (
                    <RotateCwIcon aria-hidden="true" />
                  )}
                  同步最新积分
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionMutation.isPending}
                  onClick={() => actionMutation.mutate('recompute')}
                >
                  <RefreshCwIcon aria-hidden="true" />
                  重算定档
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionMutation.isPending}
                  onClick={() => actionMutation.mutate('delete')}
                >
                  <Trash2Icon aria-hidden="true" />
                  删除快照
                </Button>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                批次永不锁定，随时可逐人修改、同步最新积分并反复导出；「导出综评表（含积分）」含定档成员与手工给分者，「导出积分明细表」含全员完整积分。
              </p>

              {notice && (
                <Alert variant="info">
                  <AlertDescription>{notice}</AlertDescription>
                </Alert>
              )}
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <RowGroup
                title={`定档名单（N=${batch.memberCount}）`}
                rows={tiered}
                emptyHint="没有符合评价条件的成员。"
                batchId={batchId}
                editing={editing}
                setEditing={setEditing}
                onSaved={invalidate}
              />
              <RowGroup
                title={`干部口径（${cadres.length} 人，可手工给分）`}
                rows={cadres}
                emptyHint="本学期没有主席团成员在册。"
                batchId={batchId}
                editing={editing}
                setEditing={setEditing}
                onSaved={invalidate}
              />
              <RowGroup
                title={`不纳入名单（${excluded.length} 人）`}
                rows={excluded}
                emptyHint="没有被排除的成员。"
                batchId={batchId}
                editing={editing}
                setEditing={setEditing}
                onSaved={invalidate}
              />
            </CardContent>
          </Card>
        );
      }}
    </QueryBoundary>
  );
}

function RowGroup({
  title,
  rows,
  emptyHint,
  batchId,
  editing,
  setEditing,
  onSaved,
}: {
  title: string;
  rows: RowDto[];
  emptyHint: string;
  batchId: string;
  editing: string | null;
  setEditing: (id: string | null) => void;
  onSaved: () => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-2 p-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {row.rankNo != null && (
                  <span className="text-xs text-muted-foreground tabular-nums">#{row.rankNo}</span>
                )}
                {row.tier && (
                  <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    {row.tier} 档
                  </span>
                )}
                <span className="text-sm font-medium text-foreground tabular-nums">{row.studentNo}</span>
                <span className="text-sm text-foreground">{row.realName}</span>
                <span className="ml-auto text-sm font-semibold text-foreground tabular-nums">
                  加分 {row.finalScore.toFixed(3)}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
                {row.currentE != null && <span className="font-medium text-foreground">有效积分 E {row.currentE.toFixed(1)}</span>}
                {row.semesterTotal != null && <span>学期总积分 {row.semesterTotal.toFixed(2)}</span>}
                <span>月均积分 {row.pointsAvg.toFixed(2)}</span>
                <span>H {row.hScore.toFixed(2)}</span>
                <span>积分标 {row.pointsStd.toFixed(1)}</span>
                <span>竞赛标 {row.contestStd.toFixed(1)}</span>
                <span>服务标 {row.serviceStd.toFixed(1)}</span>
                <span>扣减 {row.disciplinePenalty.toFixed(1)}</span>
                {row.overridden && <span className="text-amber-700 dark:text-amber-400">已手工修改</span>}
                {row.tiebreak?.needsManual && (
                  <span className="text-amber-700 dark:text-amber-400">并列需人工认定</span>
                )}
              </div>
              {row.excludeReason && <p className="text-xs text-muted-foreground">{row.excludeReason}</p>}
              {row.overrideReason && <p className="text-xs text-muted-foreground">修改理由：{row.overrideReason}</p>}
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(editing === row.id ? null : row.id)}
                >
                  {editing === row.id ? '收起' : '修改'}
                </Button>
              </div>
              {editing === row.id && (
                <RowEditor batchId={batchId} row={row} onSaved={onSaved} onClose={() => setEditing(null)} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const NUMBER_FIELDS = [
  { key: 'pointsStd', label: '积分标准分', max: 100 },
  { key: 'contestStd', label: '竞赛标准分', max: 100 },
  { key: 'serviceStd', label: '服务标准分', max: 100 },
  { key: 'penalty', label: '纪律扣减', max: 100 },
  { key: 'score', label: '最终加分（直接定值）', max: 5 },
] as const;

type NumberField = (typeof NUMBER_FIELDS)[number]['key'];

function RowEditor({
  batchId,
  row,
  onSaved,
  onClose,
}: {
  batchId: string;
  row: RowDto;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<NumberField, string>>({
    pointsStd: row.overrides.pointsStd?.toString() ?? '',
    contestStd: row.overrides.contestStd?.toString() ?? '',
    serviceStd: row.overrides.serviceStd?.toString() ?? '',
    penalty: row.overrides.penalty?.toString() ?? '',
    score: row.overrides.score?.toString() ?? '',
  });
  const [excluded, setExcluded] = useState(row.excluded);
  const [cadre, setCadre] = useState(row.cadre);
  const [excludeReason, setExcludeReason] = useState(row.excludeReason ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const placeholder = (key: NumberField) =>
    key === 'score' ? `定档建议 ${row.suggestedScore.toFixed(3)}` : `引擎值 ${row.computed[key].toFixed(2)}`;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = { reason: reason.trim(), excluded, cadre };
      for (const field of NUMBER_FIELDS) {
        const raw = values[field.key].trim();
        if (raw === '') {
          payload[field.key] = null;
          continue;
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > field.max) {
          throw new ApiError('INVALID_INPUT', `${field.label}需为 0–${field.max} 之间的数字`);
        }
        payload[field.key] = parsed;
      }
      payload.excludeReason = excluded ? excludeReason.trim() || null : null;
      await api.post(`/admin/evaluation/batches/${batchId}/rows/${row.id}`, payload);
    },
    onSuccess: () => {
      setError(null);
      onSaved();
      onClose();
    },
    onError: (err: ApiError) => setError(err.message),
  });

  return (
    <form
      className="flex flex-col gap-3 rounded-lg bg-muted/60 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        saveMutation.mutate();
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {NUMBER_FIELDS.map((field) => (
          <div key={field.key} className="grid gap-1.5">
            <Label htmlFor={`${row.id}-${field.key}`} className="text-xs">
              {field.label}
            </Label>
            <Input
              id={`${row.id}-${field.key}`}
              inputMode="decimal"
              value={values[field.key]}
              placeholder={placeholder(field.key)}
              onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
            />
          </div>
        ))}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        留空表示不覆盖、沿用引擎值。填写「最终加分」后该行直接按此值导出，不再跟随定档。
      </p>

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={excluded}
            onChange={(event) => setExcluded(event.target.checked)}
            className="size-4 rounded border-input"
          />
          不纳入名单（附录三·六）
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={cadre}
            onChange={(event) => setCadre(event.target.checked)}
            className="size-4 rounded border-input"
          />
          按干部口径单列
        </label>
      </div>

      {excluded && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${row.id}-exclude-reason`} className="text-xs">
            不纳入理由
          </Label>
          <Input
            id={`${row.id}-exclude-reason`}
            value={excludeReason}
            maxLength={300}
            onChange={(event) => setExcludeReason(event.target.value)}
            placeholder="如：当学期长期无故不参加活动且经提醒不改"
          />
        </div>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor={`${row.id}-reason`} className="text-xs">
          修改理由（留档，必填）
        </Label>
        <Textarea
          id={`${row.id}-reason`}
          value={reason}
          maxLength={500}
          rows={2}
          onChange={(event) => setReason(event.target.value)}
          placeholder="如：公示期申诉复核，补记 11 月讲题贡献"
        />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={reason.trim().length < 3 || saveMutation.isPending}>
          {saveMutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
          保存并重算
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onClose}>
          取消
        </Button>
      </div>
    </form>
  );
}
