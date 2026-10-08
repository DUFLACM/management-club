/**
 * 管理端 · 历史积分导入（points.review），全部基于 Excel 模板：
 * 1. 下载模板 → 填写 → 上传，本地校验格式；参与分留空按活动类型默认，加分项从固定选项里选；
 * 2. POST /admin/history-import/excel/preview：核对学号；表格里填了平台 + 比赛场次的行，
 *    抓取这些比赛的榜单、按平台账号查成绩（表格留空则用成员在系统绑定的账号），积分留空的按 W 公式计算，比赛名称 / 日期留空的用平台数据补全；
 * 3. POST /admin/history-import/excel 入账：按活动建归档存档（同一场平台比赛归为一个活动），成员端活动详情与流水可见。
 */
import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
// xlsx 体积大（gzip 约 140 KB），只在下载模板 / 读取文件时按需加载
import { CheckCircle2Icon, DownloadIcon, ExternalLinkIcon, LoaderCircleIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrincipal } from '@/lib/session';
import { platformLabel } from '@/lib/format';
import {
  HISTORY_BONUS_ITEMS,
  HISTORY_CATEGORY_LABELS,
  HISTORY_TEMPLATE_EXAMPLES,
  HISTORY_TEMPLATE_GUIDE,
  HISTORY_TEMPLATE_HEADERS,
  HISTORY_TEMPLATE_TEXT_COLUMNS,
  bonusLabel,
  parseHistoryRows,
  type HistoryImportRow,
} from '@/lib/history-import';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const MAX_EXCEL_ROWS = 2000;

const LAMBDA_OPTIONS = [
  { value: 'auto', label: 'λ 自动（指定目录匹配，默认乙类）' },
  { value: 'A', label: 'λ 甲类 1.2' },
  { value: 'B', label: 'λ 乙类 1.0' },
  { value: 'C', label: 'λ 丙类 0.8' },
];

interface PreviewRow extends HistoryImportRow {
  memberName: string | null;
  /** 参与分来源：表格手填 / 按活动类型默认 / 按榜单 W 公式 */
  amountSource?: 'sheet' | 'default' | 'formula';
  /** 平台账号来源：表格手填 / 成员在系统绑定的账号 */
  handleSource?: 'sheet' | 'bound';
  /** 加分来源：表格手填 / 加分项标准分 */
  bonusSource?: 'sheet' | 'standard';
  contestStartAt?: string;
  contestEndAt?: string;
  computed?: {
    platformRank: number | null;
    solvedCount: number;
    score: number;
    formula: { B: number; lambda: number; S: number; R: number; X: number; W: number } | null;
  };
}

interface PreviewContest {
  platform: string;
  contestId: string;
  available: boolean;
  reason: string | null;
  name: string | null;
  startAt: string | null;
  url: string | null;
  totalEntries: number;
  problemCount: number;
  lambda: { key: string; source: string } | null;
  existingActivity: { id: string; title: string } | null;
}

interface PreviewResult {
  rows: PreviewRow[];
  contests: PreviewContest[];
  validCount: number;
}

interface ImportResult {
  posted: number;
  duplicate: number;
  failed: number;
  activities: Array<{ id: string; title: string; date: string; created: boolean }>;
  rows: Array<{ row: number; studentNo: string; status: 'posted' | 'duplicate' | 'failed'; error?: string }>;
}

async function downloadTemplate() {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([[...HISTORY_TEMPLATE_HEADERS], ...HISTORY_TEMPLATE_EXAMPLES]);
  sheet['!cols'] = [12, 8, 22, 12, 12, 8, 12, 8, 10, 12, 16, 14, 10, 30].map((wch) => ({ wch }));
  // 学号、日期、场次、账号、月份按文本存，避免 Excel 吞掉前导零或自动转日期 / 数字
  const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
  for (let r = 1; r <= range.e.r; r++) {
    for (const c of HISTORY_TEMPLATE_TEXT_COLUMNS) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell) {
        cell.t = 's';
        cell.z = '@';
      }
    }
  }
  XLSX.utils.book_append_sheet(workbook, sheet, '积分导入');
  const guide = XLSX.utils.aoa_to_sheet(HISTORY_TEMPLATE_GUIDE);
  guide['!cols'] = [{ wch: 12 }, { wch: 18 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(workbook, guide, '填写说明');
  const bonus = XLSX.utils.aoa_to_sheet([
    ['加分项（复制到「加分项」列）', '标准加分', '记入类别', '说明'],
    ...HISTORY_BONUS_ITEMS.map((item) => [item.label, item.amount ?? '手填', item.category, item.note]),
    [],
    ['讲题 / 分享按满意度 V = 1.0 取基础分；「加分」列填了数字则以表格为准。'],
  ]);
  bonus['!cols'] = [{ wch: 26 }, { wch: 10 }, { wch: 10 }, { wch: 28 }];
  XLSX.utils.book_append_sheet(workbook, bonus, '加分项');
  XLSX.writeFile(workbook, '历史积分导入模板.xlsx');
}

/** 发给服务端的行字段（去掉本地展示用字段） */
function toPayload(row: PreviewRow | HistoryImportRow) {
  const { row: line, studentNo, amount, bonus, bonusAmount, category, activityTitle, activityDate, platform, contestId, handle, activityType, scoreMonth, note } = row;
  const base = { row: line, studentNo, amount, bonus, bonusAmount, category, activityTitle, activityDate, platform, contestId, handle, activityType, scoreMonth, note };
  if ('contestStartAt' in row) return { ...base, contestStartAt: row.contestStartAt, contestEndAt: row.contestEndAt };
  return base;
}

export function HistoryImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const principalId = usePrincipal()?.principalId ?? null;
  const queryClient = useQueryClient();
  const [parsed, setParsed] = useState<HistoryImportRow[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [lambdaKey, setLambdaKey] = useState('auto');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const localValid = parsed.filter((row) => !row.error);
  const localInvalid = parsed.filter((row) => row.error);
  const contestRowCount = localValid.filter((row) => row.platform).length;

  const previewMutation = useMutation({
    mutationFn: async (input: { rows: HistoryImportRow[]; lambdaKey: string }) =>
      (await api.post<PreviewResult>('/admin/history-import/excel/preview', {
        rows: input.rows.map(toPayload),
        lambdaKey: input.lambdaKey,
      })).data,
    onSuccess: setPreview,
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      const rows = (preview?.rows ?? []).filter((row) => !row.error);
      return (await api.post<ImportResult>('/admin/history-import/excel', { rows: rows.map(toPayload) })).data;
    },
    onSuccess: (data) => {
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin'] });
    },
  });

  const reset = () => {
    setParsed([]);
    setFileName(null);
    setParseError(null);
    setPreview(null);
    setResult(null);
    previewMutation.reset();
    importMutation.reset();
  };

  const runPreview = (rows: HistoryImportRow[], key: string) => {
    setPreview(null);
    if (rows.length > 0) previewMutation.mutate({ rows, lambdaKey: key });
  };

  const previewRows = preview?.rows ?? [];
  const readyRows = previewRows.filter((row) => !row.error);
  const serverErrors = previewRows.filter((row) => row.error);
  const activityCount = new Set(
    readyRows.map((row) => (row.platform ? `${row.platform}:${row.contestId}` : `${row.activityTitle}\u0000${row.activityDate}`)),
  ).size;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (previewMutation.isPending || importMutation.isPending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>历史积分导入</DialogTitle>
          <DialogDescription>
            导入系统上线前已有的积分。每行对应成员参加的一个活动，导入时自动在「活动管理」建立已归档的活动存档，成员可在活动详情和积分流水里看到来源。
            参加即得默认参与分（按活动类型）；填写了「平台 + 比赛场次」的行按榜单成绩自动计分；讲题、主持等额外加分在「加分项」列选择，单独记一条。重复导入不会重复计分。
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <ImportResultView result={result} onAgain={reset} />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid min-w-56 flex-1 gap-1.5">
                <Label htmlFor="history-excel-file">Excel 文件（.xlsx / .xls / .csv）</Label>
                <Input
                  id="history-excel-file"
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  disabled={previewMutation.isPending || importMutation.isPending}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file) return;
                    reset();
                    setFileName(file.name);
                    const reader = new FileReader();
                    reader.onload = async () => {
                      try {
                        const XLSX = await import('xlsx');
                        const workbook = XLSX.read(reader.result, { type: 'array', cellDates: true });
                        const sheetName = workbook.SheetNames[0];
                        const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
                        const records = sheet
                          ? XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false, dateNF: 'yyyy-mm-dd' })
                          : [];
                        const rows = parseHistoryRows(records);
                        if (rows.length === 0) {
                          setParseError('未解析出任何数据行，请使用模板并保留首行表头。');
                          return;
                        }
                        if (rows.length > MAX_EXCEL_ROWS) {
                          setParseError(`单次最多导入 ${MAX_EXCEL_ROWS} 行，请拆分文件。`);
                          return;
                        }
                        setParsed(rows);
                        runPreview(rows.filter((row) => !row.error), lambdaKey);
                      } catch {
                        setParseError('文件解析失败，请确认是有效的 Excel 文件。');
                      }
                    };
                    reader.readAsArrayBuffer(file);
                  }}
                />
              </div>
              <div className="grid w-60 gap-1.5">
                <Label htmlFor="history-lambda">比赛自动计分 λ 档</Label>
                <Select
                  value={lambdaKey}
                  onValueChange={(value) => {
                    setLambdaKey(value);
                    if (contestRowCount > 0) runPreview(localValid, value);
                  }}
                >
                  <SelectTrigger id="history-lambda"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LAMBDA_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button variant="outline" onClick={() => void downloadTemplate()}>
                <DownloadIcon aria-hidden="true" />
                下载模板
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              普通行必填：学号、活动名称、活动日期、活动类型（参与分留空按类型给默认分）。平台比赛行填「平台 + 比赛场次」即可，平台账号留空自动用成员在系统绑定的账号，比赛分 / 名称 / 日期由系统补全。
              加分项可选：{HISTORY_BONUS_ITEMS.map((item) => `${item.label}${item.amount != null ? ` +${item.amount}` : ''}`).join('、')}。模板里有逐列说明。
            </p>

            {parseError && (
              <Alert variant="destructive">
                <AlertDescription>{parseError}</AlertDescription>
              </Alert>
            )}

            {localInvalid.length > 0 && (
              <Alert variant="destructive">
                <AlertTitle>{localInvalid.length} 行格式有误，不会提交</AlertTitle>
                <AlertDescription>
                  <ul className="mt-1 flex max-h-32 flex-col gap-0.5 overflow-y-auto text-xs">
                    {localInvalid.map((row) => (
                      <li key={row.row}>第 {row.row} 行（{row.studentNo || '无学号'}）：{row.error}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {previewMutation.isPending && (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
                {contestRowCount > 0 ? `正在核对学号并抓取比赛榜单（${contestRowCount} 行比赛数据）…` : '正在核对学号…'}
              </div>
            )}
            {previewMutation.error && (
              <Alert variant="destructive">
                <AlertTitle>预览失败</AlertTitle>
                <AlertDescription className="flex flex-wrap items-center gap-2">
                  {(previewMutation.error as ApiError).message}
                  <Button size="sm" variant="outline" onClick={() => runPreview(localValid, lambdaKey)}>
                    <RefreshCwIcon aria-hidden="true" />
                    重试
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {preview && preview.contests.length > 0 && <ContestSummary contests={preview.contests} />}

            {preview && (
              <>
                <p className="text-xs text-muted-foreground">
                  {fileName}：{readyRows.length} 行可导入，涉及 {activityCount} 个活动
                  {serverErrors.length > 0 && <span className="text-destructive">；{serverErrors.length} 行有问题，不会提交</span>}
                </p>
                <PreviewTable rows={previewRows} />
              </>
            )}

            {importMutation.error && (
              <Alert variant="destructive">
                <AlertDescription>{(importMutation.error as ApiError).message}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end">
              <Button
                disabled={!preview || readyRows.length === 0 || importMutation.isPending || previewMutation.isPending}
                onClick={() => importMutation.mutate()}
              >
                {importMutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
                导入 {readyRows.length} 条积分
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ContestSummary({ contests }: { contests: PreviewContest[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">表格中的比赛（{contests.length} 场）</p>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border text-xs">
        {contests.map((contest) => (
          <li key={`${contest.platform}:${contest.contestId}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            {contest.available
              ? <CheckCircle2Icon className="size-3.5 text-success" aria-hidden="true" />
              : <TriangleAlertIcon className="size-3.5 text-destructive" aria-hidden="true" />}
            <span className="font-medium text-foreground">
              {platformLabel(contest.platform)} {contest.contestId}
            </span>
            <span className="min-w-0 truncate text-muted-foreground">{contest.name ?? '（未取得比赛名称）'}</span>
            {contest.available ? (
              <span className="text-muted-foreground tabular-nums">
                榜单 {contest.totalEntries} 人 · {contest.problemCount} 题{contest.lambda ? ` · λ ${contest.lambda.key}（${contest.lambda.source}）` : ''}
              </span>
            ) : (
              <span className="text-destructive">{contest.reason}</span>
            )}
            {contest.existingActivity && (
              <span className="text-muted-foreground">将挂到已有活动「{contest.existingActivity.title}」</span>
            )}
            {contest.url && (
              <a href={contest.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
                官方页面 <ExternalLinkIcon className="size-3" aria-hidden="true" />
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreviewTable({ rows }: { rows: PreviewRow[] }) {
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="h-8">
            <TableHead className="pl-3 text-xs">行</TableHead>
            <TableHead className="text-xs">成员</TableHead>
            <TableHead className="text-xs">参与分</TableHead>
            <TableHead className="text-xs">加分项</TableHead>
            <TableHead className="text-xs">合计</TableHead>
            <TableHead className="text-xs">类别</TableHead>
            <TableHead className="text-xs">活动</TableHead>
            <TableHead className="text-xs">日期</TableHead>
            <TableHead className="text-xs">比赛成绩</TableHead>
            <TableHead className="pr-3 text-xs">备注 / 问题</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const formula = row.computed?.formula;
            return (
              <TableRow key={row.row} className={row.error ? 'bg-destructive-subtle/40' : undefined}>
                <TableCell className="py-1.5 pl-3 text-xs tabular-nums text-muted-foreground">{row.row}</TableCell>
                <TableCell className="py-1.5 text-xs">
                  <span className="block">{row.memberName ?? row.name ?? '—'}</span>
                  <span className="block text-muted-foreground tabular-nums">{row.studentNo}</span>
                </TableCell>
                <TableCell
                  className="py-1.5 text-xs tabular-nums"
                  title={formula ? `W = B ${formula.B} + λ ${formula.lambda} × (4×S ${formula.S} + 6×R ${formula.R}) + X ${formula.X}` : undefined}
                >
                  {row.amount ?? '—'}
                  {row.amountSource === 'formula' && <SourceTag>榜单</SourceTag>}
                  {row.amountSource === 'default' && <SourceTag>默认</SourceTag>}
                </TableCell>
                <TableCell className="py-1.5 text-xs">
                  {row.bonus ? (
                    <>
                      <span className="block">{bonusLabel(row.bonus)}</span>
                      <span className="block tabular-nums text-success">
                        {row.bonusAmount != null ? `额外 +${row.bonusAmount}` : '—'}
                        {row.bonusSource === 'standard' && <SourceTag>标准</SourceTag>}
                      </span>
                    </>
                  ) : '—'}
                </TableCell>
                <TableCell className="py-1.5 text-xs font-medium tabular-nums">
                  {row.error ? '—' : rowTotal(row)}
                </TableCell>
                <TableCell className="py-1.5 text-xs">{HISTORY_CATEGORY_LABELS[row.category] ?? '—'}</TableCell>
                <TableCell className="max-w-48 truncate py-1.5 text-xs" title={row.activityTitle}>{row.activityTitle ?? '—'}</TableCell>
                <TableCell className="py-1.5 text-xs tabular-nums">{row.activityDate ?? '—'}</TableCell>
                <TableCell className="py-1.5 text-xs text-muted-foreground">
                  {row.platform ? (
                    <>
                      <span className="block text-foreground">{platformLabel(row.platform)} {row.contestId}</span>
                      <span className="block">
                        {row.handle ?? '—'}
                        {row.handleSource === 'bound' && <SourceTag>绑定</SourceTag>}
                        {row.computed && ` · 第 ${row.computed.platformRank ?? '—'} 名 · 过 ${row.computed.solvedCount} 题`}
                      </span>
                    </>
                  ) : '—'}
                </TableCell>
                <TableCell className="py-1.5 pr-3 text-xs text-muted-foreground">
                  {row.error ? <span className="text-destructive">{row.error}</span> : row.note ?? '—'}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function SourceTag({ children }: { children: ReactNode }) {
  return <span className="ml-1 rounded bg-primary/10 px-1 text-[10px] text-primary">{children}</span>;
}

/** 参与分 + 加分（两位小数以内，去掉多余的 0） */
function rowTotal(row: PreviewRow): string {
  const total = Number(row.amount ?? 0) + Number(row.bonusAmount ?? 0);
  return String(Math.round(total * 100) / 100);
}

function ImportResultView({ result, onAgain }: { result: ImportResult; onAgain: () => void }) {
  const problems = result.rows.filter((row) => row.status !== 'posted');
  return (
    <div className="flex flex-col gap-3 text-sm">
      <Alert variant={result.failed > 0 ? 'destructive' : 'info'}>
        <AlertTitle>导入完成</AlertTitle>
        <AlertDescription>
          入账 {result.posted} 条{result.duplicate > 0 ? `，已入账跳过 ${result.duplicate} 条` : ''}
          {result.failed > 0 ? `，失败 ${result.failed} 条` : ''}；涉及 {result.activities.length} 个活动
          （新建存档 {result.activities.filter((a) => a.created).length} 个）。
        </AlertDescription>
      </Alert>
      {result.activities.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">活动存档</p>
          <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto text-xs">
            {result.activities.map((activity) => (
              <li key={activity.id} className="tabular-nums">
                {activity.date} · {activity.title}
                <span className="ml-1 text-muted-foreground">{activity.created ? '（新建）' : '（已存在，复用）'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {problems.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">未入账的行</p>
          <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto text-xs text-muted-foreground">
            {problems.map((row) => (
              <li key={row.row} className={row.status === 'failed' ? 'text-destructive' : undefined}>
                第 {row.row} 行（{row.studentNo}）：{row.error}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="outline" onClick={onAgain}>继续导入</Button>
      </div>
    </div>
  );
}
