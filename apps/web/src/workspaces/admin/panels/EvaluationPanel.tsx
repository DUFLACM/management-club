/**
 * 管理端 · 综评导出（evaluation.manage）：按附录三《综合素质评价建议折算表》生成学期建议分。
 * - GET/POST /admin/evaluation/batches、GET /admin/evaluation/batches/:id
 * - POST /admin/evaluation/batches/:id/rows/:rowId（逐人修改，保存后自动重算定档）
 * - GET /admin/evaluation/batches/:id/export（学号/姓名/加分，UTF-8 BOM）
 * 学期结束后才开放生成；未结束学期仅在服务端 EVALUATION_TEST_MODE 下可生成，产物标为测试数据。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DownloadIcon,
  FlaskConicalIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  Trash2Icon,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrincipal } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { PanelHeader } from '@/components/club/PanelHeader';
import { PrincipalGate, QueryBoundary } from '@/components/club/QueryBoundary';
import { EmptyState } from '@/components/club/EmptyState';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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

  const semesters = semestersQuery.data?.semesters ?? [];
  const testMode = semestersQuery.data?.testMode ?? false;
  const selectedSemester = semesters.find((s) => s.id === semesterId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="综评导出"
        description="按附录三《综合素质评价建议折算表》生成学期建议加分，可逐人修改后导出 学号/姓名/加分。"
      />

      {testMode && (
        <Alert>
          <FlaskConicalIcon aria-hidden="true" />
          <AlertTitle>测试口已开启（EVALUATION_TEST_MODE）</AlertTitle>
          <AlertDescription>
            未结束的学期也能生成批次，结果固定标记为「测试数据」，导出文件名同样带标记。正式上报请在学期结束后重新生成。
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="flex flex-col gap-3 p-5">
          <h2 className="text-sm font-semibold text-foreground">生成学期批次</h2>
          <QueryBoundary query={semestersQuery}>
            {() =>
              semesters.length === 0 ? (
                <EmptyState kind="empty" description="还没有学期记录，先在设置中建立学期。" />
              ) : (
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
                          {semester.ended ? '（已结束）' : '（进行中）'}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button
                    disabled={!selectedSemester?.canGenerate || generateMutation.isPending}
                    onClick={() => selectedSemester && generateMutation.mutate(selectedSemester.id)}
                  >
                    {generateMutation.isPending ? (
                      <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                    ) : (
                      <PlusIcon aria-hidden="true" />
                    )}
                    生成批次
                  </Button>
                </div>
              )
            }
          </QueryBoundary>

          {selectedSemester && !selectedSemester.canGenerate && (
            <p className="text-xs leading-5 text-muted-foreground">
              该学期 {formatDateTime(selectedSemester.endsOn)} 结束，未到时点不开放折算；本地测试可在服务端设置
              EVALUATION_TEST_MODE=true。
            </p>
          )}
          {actionError && (
            <Alert variant="destructive">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}

          <details className="rounded-lg bg-muted/60 p-3 text-xs leading-5 text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">折算口径（附录三）</summary>
            <p className="mt-2">H = 0.70×积分标准分 + 0.20×竞赛标准分 + 0.10×服务标准分 − 纪律扣减。</p>
            <ul className="mt-1 list-disc pl-4">
              <li>积分标准分：学期各月有效积分平均值在符合评价条件成员中的百分位（0–100）</li>
              <li>竞赛标准分：学期内 正式赛/远程赛/获奖 账目合计的百分位</li>
              <li>服务标准分：学期内 贡献/服务 账目合计的百分位</li>
              <li>纪律扣减：学期内 penalty 账目金额合计 1:1 扣减 H，上限 20 分</li>
              <li>按 H 降序 1:2:7 定 A/B/C 档；A 档 1.0，B 档 1.0→0.5 等差，C 档 0.5→0 等差</li>
              <li>并列按近三个月有效积分 → 正式竞赛积分 → 活动积分比较，仍相同者标注「需人工认定」</li>
            </ul>
            <p className="mt-2">
              干部口径（社长按部长级、副社长按副部长级）需另行申报，系统无法区分社长/副社长，主席团成员单列在下方由你手工给分。
              结果只是社团内部排序与建议值，不等同学院最终记分。
            </p>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <h2 className="border-b border-border p-5 pb-3 text-sm font-semibold text-foreground">历史批次</h2>
          <QueryBoundary query={batchesQuery}>
            {(batches) =>
              batches.length === 0 ? (
                <div className="p-5">
                  <EmptyState kind="empty" description="还没有综评批次；选择学期后点「生成批次」。" />
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
                        {batch.isTest && (
                          <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                            测试数据
                          </span>
                        )}
                        <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {batch.status === 'published' ? '已发布' : '草稿'}
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
    mutationFn: async (action: 'recompute' | 'publish' | 'delete') => {
      if (action === 'delete') await api.delete(`/admin/evaluation/batches/${batchId}`);
      else await api.post(`/admin/evaluation/batches/${batchId}/${action}`);
      return action;
    },
    onSuccess: (action) => {
      setError(null);
      if (action === 'delete') onDeleted();
      invalidate();
    },
    onError: (err: ApiError) => setError(err.message),
  });

  return (
    <QueryBoundary query={detailQuery}>
      {({ batch, rows }) => {
        const tiered = rows.filter((r) => r.tier != null && !r.excluded && !r.cadre);
        const cadres = rows.filter((r) => r.cadre && !r.excluded);
        const excluded = rows.filter((r) => r.excluded);
        const locked = batch.status === 'published';
        return (
          <Card>
            <CardContent className="flex flex-col gap-4 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-foreground">
                  {batch.semesterCode} {batch.semesterName} · 建议名单
                </h2>
                {batch.isTest && (
                  <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                    测试数据，不可作为正式结果上报
                  </span>
                )}
                {locked && (
                  <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    已发布 {batch.publishedAt ? formatDateTime(batch.publishedAt) : ''}
                  </span>
                )}
              </div>

              {batch.note && <p className="text-xs leading-5 text-muted-foreground">{batch.note}</p>}

              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <a href={`/api/v1/admin/evaluation/batches/${batch.id}/export`}>
                    <DownloadIcon aria-hidden="true" />
                    导出表格
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={locked || actionMutation.isPending}
                  onClick={() => actionMutation.mutate('recompute')}
                >
                  <RefreshCwIcon aria-hidden="true" />
                  重算定档
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={locked || actionMutation.isPending}
                  onClick={() => actionMutation.mutate('publish')}
                >
                  <SendIcon aria-hidden="true" />
                  发布锁定
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionMutation.isPending}
                  onClick={() => actionMutation.mutate('delete')}
                >
                  <Trash2Icon aria-hidden="true" />
                  删除批次
                </Button>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                导出仅含定档成员与已手工给分者；发布后批次锁定，如需更正请重新生成。
              </p>

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
                locked={locked}
                editing={editing}
                setEditing={setEditing}
                onSaved={invalidate}
              />
              <RowGroup
                title={`干部口径（${cadres.length} 人，需手工给分）`}
                rows={cadres}
                emptyHint="本学期没有主席团成员在册。"
                batchId={batchId}
                locked={locked}
                editing={editing}
                setEditing={setEditing}
                onSaved={invalidate}
              />
              <RowGroup
                title={`不纳入名单（${excluded.length} 人）`}
                rows={excluded}
                emptyHint="没有被排除的成员。"
                batchId={batchId}
                locked={locked}
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
  locked,
  editing,
  setEditing,
  onSaved,
}: {
  title: string;
  rows: RowDto[];
  emptyHint: string;
  batchId: string;
  locked: boolean;
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
                  {row.finalScore.toFixed(3)} 分
                </span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
                <span>H {row.hScore.toFixed(2)}</span>
                <span>积分 {row.pointsStd.toFixed(1)}</span>
                <span>竞赛 {row.contestStd.toFixed(1)}</span>
                <span>服务 {row.serviceStd.toFixed(1)}</span>
                <span>扣减 {row.disciplinePenalty.toFixed(1)}</span>
                <span>月均积分 {row.pointsAvg.toFixed(2)}</span>
                {row.overridden && <span className="text-amber-700 dark:text-amber-400">已手工修改</span>}
                {row.tiebreak?.needsManual && (
                  <span className="text-amber-700 dark:text-amber-400">并列需人工认定</span>
                )}
              </div>
              {row.excludeReason && <p className="text-xs text-muted-foreground">{row.excludeReason}</p>}
              {row.overrideReason && <p className="text-xs text-muted-foreground">修改理由：{row.overrideReason}</p>}
              {!locked && (
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing(editing === row.id ? null : row.id)}
                  >
                    {editing === row.id ? '收起' : '修改'}
                  </Button>
                </div>
              )}
              {editing === row.id && !locked && (
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
      // 空字符串代表撤销覆盖，显式传 null；非法数字在这里拦住，避免把 NaN 发给服务端
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
