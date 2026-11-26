/**
 * 管理端 · 正式赛报名名单与人员成绩导入（积分审核页面）。
 * 1. 填写正式赛信息（名称、日期、分类、个人/团队、可选积分档位）；
 * 2. 上传 Excel/CSV（提供模板下载）或直接粘贴名单，支持学号或姓名导入；
 * 3. 调用 POST /admin/competition-import/preview 核对账号：
 *    - 姓名重复（或仅展示名匹配）时在顶部专框与表格内同时列出候选账号，供管理员手动选择；
 *    - 未填积分时按所选赛事档位 + 奖项自动试算附录二标准分，也可直接手填或按 0 分仅登记名单；
 * 4. 调用 POST /admin/competition-import/commit 自动创建并归档正式赛、写入报名名单与成绩、归档积分并联动成员账号。
 */
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2Icon,
  DownloadIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  TrophyIcon,
  UsersIcon,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrincipal } from '@/lib/session';
import { currentMonthKey, membershipLabel } from '@/lib/format';
import { CONTEST_TIERS } from '@/lib/competitions';
import {
  COMPETITION_TEAM_TEMPLATE_EXAMPLES,
  COMPETITION_TEMPLATE_EXAMPLES,
  COMPETITION_TEMPLATE_GUIDE,
  COMPETITION_TEMPLATE_HEADERS,
  COMPETITION_TEMPLATE_TEXT_COLUMNS,
  parseCompetitionExcelRows,
  parseCompetitionPasteText,
  type ParsedCompetitionRow,
} from '@/lib/competition-import';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

const MAX_ROWS = 2000;

interface MemberCandidateDto {
  userId: string;
  studentNo: string;
  name: string;
  displayName: string | null;
  grade: number | null;
  membership: string;
  matchKind: 'real_name' | 'display_name';
}

interface PreviewRowDto {
  row: number;
  studentNo: string;
  inputName: string | null;
  userId: string | null;
  memberName: string | null;
  grade: number | null;
  membership: string | null;
  matchSource: 'selected' | 'studentNo' | 'name' | null;
  matchWarning?: string;
  needsSelection?: boolean;
  candidates?: MemberCandidateDto[];
  teamName?: string;
  awardText?: string;
  rankText?: string;
  points: string;
  pointsSource: 'sheet' | 'tier_rule' | 'roster_only';
  pointsHint?: string;
  note?: string;
  error?: string;
}

interface PreviewResponseDto {
  existingEvent: { id: string; title: string; status: string } | null;
  existingMismatch: string | null;
  scoreMonth: string;
  rows: PreviewRowDto[];
  summary: {
    total: number;
    ready: number;
    duplicateNameCount: number;
    errorCount: number;
    totalPoints: number;
    teamCount: number;
  };
}

interface CommitResponseDto {
  batchId: string;
  event: {
    id: string;
    title: string;
    created: boolean;
    status: string;
    teamSize: number | null;
    scoreMonth: string;
  };
  registeredCount: number;
  teamsCreated: number;
  posted: number;
  duplicate: number;
  rosterOnly: number;
  failed: number;
  rows: Array<{
    row: number;
    studentNo: string;
    memberName: string | null;
    teamName?: string;
    points: string;
    postedAmount?: string;
    status: 'archived' | 'roster_only' | 'duplicate' | 'failed';
    error?: string;
  }>;
}

function todayShanghai(): string {
  const d = new Date(Date.now() + 8 * 3600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function downloadCompetitionTemplate(isTeam: boolean) {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  const examples = isTeam ? COMPETITION_TEAM_TEMPLATE_EXAMPLES : COMPETITION_TEMPLATE_EXAMPLES;
  const sheet = XLSX.utils.aoa_to_sheet([[...COMPETITION_TEMPLATE_HEADERS], ...examples]);
  sheet['!cols'] = [14, 10, 16, 16, 10, 10, 32].map((wch) => ({ wch }));
  const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
  for (let r = 1; r <= range.e.r; r++) {
    for (const c of COMPETITION_TEMPLATE_TEXT_COLUMNS) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell) {
        cell.t = 's';
        cell.z = '@';
      }
    }
  }
  XLSX.utils.book_append_sheet(workbook, sheet, '名单与成绩');
  const guide = XLSX.utils.aoa_to_sheet(COMPETITION_TEMPLATE_GUIDE);
  guide['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(workbook, guide, '填写说明');
  XLSX.writeFile(workbook, isTeam ? '正式赛团队名单与成绩模板.xlsx' : '正式赛报名名单与成绩模板.xlsx');
}

export function CompetitionImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const principalId = usePrincipal()?.principalId ?? null;
  const queryClient = useQueryClient();

  const [title, setTitle] = useState('');
  const [competitionDate, setCompetitionDate] = useState(todayShanghai);
  const [scoreMonth, setScoreMonth] = useState(currentMonthKey);
  const [monthTouched, setMonthTouched] = useState(false);
  const [category, setCategory] = useState<'A' | 'B'>('A');
  const [isTeam, setIsTeam] = useState(false);
  const [teamSize, setTeamSize] = useState('3');
  const [contestTier, setContestTier] = useState('none');
  const [ledgerCategory, setLedgerCategory] = useState<'award' | 'contest'>('award');
  const [announcement, setAnnouncement] = useState('');

  const [inputMode, setInputMode] = useState<'excel' | 'paste'>('excel');
  const [fileName, setFileName] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [parsedRows, setParsedRows] = useState<ParsedCompetitionRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);

  /** 同名候选的手动选择结果：行号 → userId */
  const [selectedUsers, setSelectedUsers] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<PreviewResponseDto | null>(null);
  const [result, setResult] = useState<CommitResponseDto | null>(null);

  const localValid = parsedRows.filter((r) => !r.error);
  const localInvalid = parsedRows.filter((r) => r.error);

  const buildEventPayload = (override?: { title?: string; competitionDate?: string; scoreMonth?: string; isTeam?: boolean; teamSize?: string; contestTier?: string; category?: 'A' | 'B'; ledgerCategory?: 'award' | 'contest' }) => {
    const effTitle = (override?.title ?? title).trim();
    const effDate = override?.competitionDate ?? competitionDate;
    const effMonth = override?.scoreMonth ?? scoreMonth;
    const effIsTeam = override?.isTeam ?? isTeam;
    const effTeamSize = override?.teamSize ?? teamSize;
    const effTier = override?.contestTier ?? contestTier;
    return {
      title: effTitle,
      competitionDate: effDate,
      category: override?.category ?? category,
      teamSize: effIsTeam ? Math.min(10, Math.max(2, Number(effTeamSize) || 3)) : null,
      contestTier: effTier === 'none' ? null : effTier,
      scoreMonth: effMonth || effDate.slice(0, 7),
      ledgerCategory: override?.ledgerCategory ?? ledgerCategory,
      ...(announcement.trim() ? { announcement: announcement.trim() } : {}),
    };
  };

  const buildRowsPayload = (rows: ParsedCompetitionRow[], selections: Record<number, string>) =>
    rows.map((row) => ({
      row: row.row,
      ...(row.studentNo ? { studentNo: row.studentNo } : {}),
      ...(row.name ? { name: row.name } : {}),
      ...(selections[row.row] ? { selectedUserId: selections[row.row] } : {}),
      ...(row.teamName ? { teamName: row.teamName } : {}),
      ...(row.awardText ? { awardText: row.awardText } : {}),
      ...(row.rankText ? { rankText: row.rankText } : {}),
      ...(row.points ? { points: row.points } : {}),
      ...(row.note ? { note: row.note } : {}),
    }));

  const previewMutation = useMutation({
    mutationFn: async (payload: { event: ReturnType<typeof buildEventPayload>; rows: ReturnType<typeof buildRowsPayload> }) =>
      (await api.post<PreviewResponseDto>('/admin/competition-import/preview', payload)).data,
    onSuccess: setPreview,
  });

  const commitMutation = useMutation({
    mutationFn: async () => {
      const readyInputRows = localValid.filter((row) => {
        const previewRow = preview?.rows.find((item) => item.row === row.row);
        return previewRow && !previewRow.error && previewRow.userId != null;
      });
      return (
        await api.post<CommitResponseDto>('/admin/competition-import/commit', {
          event: buildEventPayload(),
          rows: buildRowsPayload(readyInputRows, selectedUsers),
        })
      ).data;
    },
    onSuccess: (data) => {
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'admin'] });
    },
  });

  const resetAll = () => {
    setTitle('');
    setCompetitionDate(todayShanghai());
    setScoreMonth(currentMonthKey());
    setMonthTouched(false);
    setCategory('A');
    setIsTeam(false);
    setTeamSize('3');
    setContestTier('none');
    setLedgerCategory('award');
    setAnnouncement('');
    setFileName(null);
    setPasteText('');
    setParsedRows([]);
    setParseError(null);
    setSelectedUsers({});
    setPreview(null);
    setResult(null);
    previewMutation.reset();
    commitMutation.reset();
  };

  const triggerPreview = (
    rowsToCheck: ParsedCompetitionRow[],
    selections: Record<number, string> = selectedUsers,
    eventOverride?: Parameters<typeof buildEventPayload>[0],
  ) => {
    const eventPayload = buildEventPayload(eventOverride);
    if (eventPayload.title.length < 2) {
      setPreview(null);
      return;
    }
    const valid = rowsToCheck.filter((r) => !r.error);
    if (valid.length === 0) {
      setPreview(null);
      return;
    }
    previewMutation.mutate({
      event: eventPayload,
      rows: buildRowsPayload(valid, selections),
    });
  };

  const handleChooseMember = (rowNo: number, userId: string) => {
    const next = { ...selectedUsers, [rowNo]: userId };
    setSelectedUsers(next);
    triggerPreview(parsedRows, next);
  };

  const duplicateRows = (preview?.rows ?? []).filter((row) => row.needsSelection && (row.candidates?.length ?? 0) > 0);
  const canCommit =
    title.trim().length >= 2 &&
    preview != null &&
    !preview.existingMismatch &&
    preview.summary.ready > 0 &&
    preview.summary.duplicateNameCount === 0 &&
    !previewMutation.isPending &&
    !commitMutation.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (previewMutation.isPending || commitMutation.isPending) return;
        if (!next) resetAll();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TrophyIcon className="size-4 text-primary" aria-hidden="true" />
            竞赛正式赛报名名单与成绩导入
          </DialogTitle>
          <DialogDescription>
            导入正式赛名单与成绩。积分按每位成员本场比赛的应得总分填写，已有参赛分的成员只补差额。
            支持学号或姓名导入；遇到重名成员会集中列出供手动选择。
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <CommitResultView
            result={result}
            onViewContests={() => {
              onOpenChange(false);
              resetAll();
              void navigate('/admin?section=contests');
            }}
            onAgain={resetAll}
          />
        ) : (
          <div className="flex flex-col gap-4">
            {/* 1. 比赛基础信息 */}
            <section className="flex flex-col gap-3 rounded-xl border border-border bg-muted/20 p-4">
              <h3 className="text-sm font-semibold text-foreground">一、正式赛信息（导入后自动创建并归档）</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label htmlFor="comp-import-title">比赛名称（必填）</Label>
                  <Input
                    id="comp-import-title"
                    value={title}
                    onChange={(event) => {
                      setTitle(event.target.value);
                      setPreview(null);
                    }}
                    placeholder="如：2026 第十七届蓝桥杯省赛 / 2026 ICPC 沈阳站"
                    maxLength={160}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="comp-import-date">比赛日期</Label>
                  <Input
                    id="comp-import-date"
                    type="date"
                    value={competitionDate}
                    onChange={(event) => {
                      const nextDate = event.target.value;
                      setCompetitionDate(nextDate);
                      if (!monthTouched && /^\d{4}-\d{2}/.test(nextDate)) {
                        setScoreMonth(nextDate.slice(0, 7));
                      }
                      setPreview(null);
                    }}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="comp-import-month">归档计分月份</Label>
                  <Input
                    id="comp-import-month"
                    type="month"
                    value={scoreMonth}
                    onChange={(event) => {
                      setMonthTouched(true);
                      setScoreMonth(event.target.value || currentMonthKey());
                    }}
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="comp-import-category">赛事分类</Label>
                  <Select value={category} onValueChange={(value) => setCategory(value as 'A' | 'B')}>
                    <SelectTrigger id="comp-import-category">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="A">A 类 · 学校配额统一管理</SelectItem>
                      <SelectItem value="B">B 类 · 纳入积分认定</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="comp-import-tier">积分档位（选填，用于自动算分）</Label>
                  <Select
                    value={contestTier}
                    onValueChange={(value) => {
                      setContestTier(value);
                      if (parsedRows.length > 0 && title.trim().length >= 2) {
                        triggerPreview(parsedRows, selectedUsers, { contestTier: value });
                      }
                    }}
                  >
                    <SelectTrigger id="comp-import-tier">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">不按档位（按表格积分）</SelectItem>
                      {CONTEST_TIERS.map((tier) => (
                        <SelectItem key={tier.value} value={tier.value}>
                          {tier.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="comp-import-ledger-cat">账本积分类别</Label>
                  <Select value={ledgerCategory} onValueChange={(value) => setLedgerCategory(value as 'award' | 'contest')}>
                    <SelectTrigger id="comp-import-ledger-cat">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="award">赛事获奖积分（award）</SelectItem>
                      <SelectItem value="contest">比赛积分（contest）</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col justify-end gap-1.5">
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <Checkbox
                      checked={isTeam}
                      onCheckedChange={(checked) => {
                        const nextTeam = checked === true;
                        setIsTeam(nextTeam);
                        setPreview(null);
                      }}
                    />
                    团队赛（按队名编组）
                  </label>
                  {isTeam && (
                    <div className="flex items-center gap-2">
                      <Label htmlFor="comp-import-team-size" className="text-xs whitespace-nowrap">
                        每队人数
                      </Label>
                      <Input
                        id="comp-import-team-size"
                        type="number"
                        min={2}
                        max={10}
                        value={teamSize}
                        onChange={(event) => setTeamSize(event.target.value)}
                        className="h-8 w-20"
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="comp-import-announcement">赛事说明 / 备注（选填）</Label>
                <Input
                  id="comp-import-announcement"
                  value={announcement}
                  onChange={(event) => setAnnouncement(event.target.value)}
                  placeholder="留空使用默认归档说明"
                  maxLength={500}
                />
              </div>
            </section>

            {/* 2. 名单与成绩数据来源 */}
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-foreground">二、导入报名名单与成绩</h3>
                <Button size="sm" variant="outline" onClick={() => void downloadCompetitionTemplate(isTeam)}>
                  <DownloadIcon aria-hidden="true" />
                  下载{isTeam ? '团队赛' : '个人赛'}模板
                </Button>
              </div>

              <Tabs value={inputMode} onValueChange={(v) => setInputMode(v as 'excel' | 'paste')}>
                <TabsList>
                  <TabsTrigger value="excel">上传 Excel / CSV</TabsTrigger>
                  <TabsTrigger value="paste">直接粘贴名单</TabsTrigger>
                </TabsList>

                <TabsContent value="excel" className="mt-3 flex flex-col gap-2">
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="grid min-w-56 flex-1 gap-1.5">
                      <Label htmlFor="comp-import-file">选择文件（.xlsx / .xls / .csv）</Label>
                      <Input
                        id="comp-import-file"
                        type="file"
                        accept=".xlsx,.xls,.csv"
                        disabled={previewMutation.isPending || commitMutation.isPending}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = '';
                          if (!file) return;
                          setFileName(file.name);
                          setParseError(null);
                          setSelectedUsers({});
                          setPreview(null);
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
                              const parsed = parseCompetitionExcelRows(records, { isTeam });
                              if (parsed.rows.length === 0) {
                                setParseError('未解析出任何数据行，请保留表头行（学号 / 姓名 / 奖项/成绩 / 积分）。');
                                setParsedRows([]);
                                return;
                              }
                              if (parsed.rows.length > MAX_ROWS) {
                                setParseError(`单次最多导入 ${MAX_ROWS} 行，请拆分文件。`);
                                setParsedRows([]);
                                return;
                              }
                              let effTitle = title;
                              if (!effTitle.trim() && parsed.inferredTitle) {
                                effTitle = parsed.inferredTitle;
                                setTitle(effTitle);
                              }
                              let effDate = competitionDate;
                              let effMonth = scoreMonth;
                              if (parsed.inferredDate) {
                                effDate = parsed.inferredDate;
                                setCompetitionDate(effDate);
                                if (!monthTouched) {
                                  effMonth = effDate.slice(0, 7);
                                  setScoreMonth(effMonth);
                                }
                              }
                              setParsedRows(parsed.rows);
                              if (effTitle.trim().length >= 2) {
                                triggerPreview(parsed.rows, {}, {
                                  title: effTitle,
                                  competitionDate: effDate,
                                  scoreMonth: effMonth,
                                });
                              }
                            } catch {
                              setParseError('文件解析失败，请确认是有效的 Excel 或 CSV 文件。');
                            }
                          };
                          reader.readAsArrayBuffer(file);
                        }}
                      />
                    </div>
                    <Button
                      variant="outline"
                      disabled={parsedRows.length === 0 || title.trim().length < 2 || previewMutation.isPending}
                      onClick={() => triggerPreview(parsedRows, selectedUsers)}
                    >
                      {previewMutation.isPending ? (
                        <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                      ) : (
                        <RefreshCwIcon aria-hidden="true" />
                      )}
                      核对账号与分值
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    列头支持：学号、姓名（二选一即可）、队名（团队赛必填）、奖项/成绩、排名、积分、备注。
                    选定上方「积分档位」后，积分留空将按附录二规则自动换算；未填积分且未匹配档位时按 0 分仅登记参赛名单。
                  </p>
                </TabsContent>

                <TabsContent value="paste" className="mt-3 flex flex-col gap-2">
                  <Label htmlFor="comp-import-paste">
                    {isTeam
                      ? '粘贴团队赛名单（支持直接从 Excel 复制带表头内容，或每行：队名 学号或姓名 奖项 积分 备注）'
                      : '粘贴个人赛名单（支持直接从 Excel 复制带表头内容，或每行：学号或姓名 奖项 积分 备注）'}
                  </Label>
                  <Textarea
                    id="comp-import-paste"
                    rows={6}
                    value={pasteText}
                    onChange={(event) => {
                      setPasteText(event.target.value);
                      setPreview(null);
                    }}
                    className="font-mono text-xs"
                    placeholder={
                      isTeam
                        ? '大外一队 202400001 金奖 95\n大外一队 李四 金奖 95\n大外二队 王五 铜奖 55'
                        : '202400001 张三 省一 35\n李四 省二 22\n王五 参赛'
                    }
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      分隔符支持 Tab、逗号或空格；可只填学号或只填姓名，也可只录报名名单（不填积分）。
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!pasteText.trim() || title.trim().length < 2 || previewMutation.isPending}
                      onClick={() => {
                        setParseError(null);
                        setSelectedUsers({});
                        const parsed = parseCompetitionPasteText(pasteText, { isTeam });
                        if (parsed.rows.length === 0) {
                          setParseError('未解析出任何有效行，请检查粘贴内容。');
                          setParsedRows([]);
                          setPreview(null);
                          return;
                        }
                        if (parsed.rows.length > MAX_ROWS) {
                          setParseError(`单次最多导入 ${MAX_ROWS} 行。`);
                          setParsedRows([]);
                          setPreview(null);
                          return;
                        }
                        setFileName('粘贴名单');
                        setParsedRows(parsed.rows);
                        triggerPreview(parsed.rows, {});
                      }}
                    >
                      {previewMutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
                      解析并核对账号
                    </Button>
                  </div>
                </TabsContent>
              </Tabs>

              {title.trim().length < 2 && parsedRows.length > 0 && (
                <Alert variant="info">
                  <AlertDescription>
                    已读取 {parsedRows.length} 行数据，请先在上方填写「比赛名称」，再点击「核对账号与分值」。
                  </AlertDescription>
                </Alert>
              )}

              {parseError && (
                <Alert variant="destructive">
                  <AlertDescription>{parseError}</AlertDescription>
                </Alert>
              )}

              {localInvalid.length > 0 && (
                <Alert variant="destructive">
                  <AlertTitle>{localInvalid.length} 行本地格式有误，不会提交</AlertTitle>
                  <AlertDescription>
                    <ul className="mt-1 flex max-h-28 flex-col gap-0.5 overflow-y-auto text-xs">
                      {localInvalid.map((row) => (
                        <li key={row.row}>
                          第 {row.row} 行（{row.studentNo || row.name || '空'}）：{row.error}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              {previewMutation.error && (
                <Alert variant="destructive">
                  <AlertTitle>核对失败</AlertTitle>
                  <AlertDescription>{(previewMutation.error as ApiError).message}</AlertDescription>
                </Alert>
              )}
            </section>

            {/* 3. 同名手动选择专框 */}
            {duplicateRows.length > 0 && (
              <section className="flex flex-col gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
                  <UsersIcon className="size-4" aria-hidden="true" />
                  发现 {duplicateRows.length} 行姓名重复 / 待确认账号，请手动选择对应成员
                </div>
                <p className="text-xs text-muted-foreground">
                  以下成员姓名对应多位系统账号（或仅匹配展示名），请结合学号、年级与身份手动选择后再导入：
                </p>
                <ul className="flex flex-col gap-2">
                  {duplicateRows.map((row) => (
                    <li
                      key={row.row}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2"
                    >
                      <div className="min-w-0 text-xs">
                        <span className="font-medium text-foreground">
                          第 {row.row} 行 · 「{row.inputName ?? row.studentNo}」
                        </span>
                        {(row.teamName || row.awardText || Number(row.points) !== 0) && (
                          <span className="ml-2 text-muted-foreground">
                            {[
                              row.teamName ? `队名：${row.teamName}` : '',
                              row.awardText ?? '',
                              Number(row.points) !== 0 ? `${row.points} 分` : '',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        )}
                      </div>
                      <Select
                        value={selectedUsers[row.row] ?? ''}
                        onValueChange={(value) => handleChooseMember(row.row, value)}
                        disabled={previewMutation.isPending}
                      >
                        <SelectTrigger className="h-8 w-72 text-xs" aria-label={`第 ${row.row} 行手动选择成员`}>
                          <SelectValue placeholder="请选择具体成员账号" />
                        </SelectTrigger>
                        <SelectContent>
                          {row.candidates?.map((candidate) => (
                            <SelectItem key={candidate.userId} value={candidate.userId}>
                              {candidate.studentNo} · {candidate.name}
                              {candidate.grade != null ? ` · ${candidate.grade}级` : ''}
                              {candidate.displayName && candidate.displayName !== candidate.name
                                ? `（${candidate.displayName}）`
                                : ''}
                              {` · ${membershipLabel(candidate.membership)}`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* 4. 预览结果表格 */}
            {preview && (
              <section className="flex flex-col gap-2.5">
                {preview.existingMismatch && (
                  <Alert variant="destructive">
                    <AlertDescription>{preview.existingMismatch}</AlertDescription>
                  </Alert>
                )}
                {preview.existingEvent && !preview.existingMismatch && (
                  <Alert variant="info">
                    <AlertDescription>
                      将更新已有赛事「{preview.existingEvent.title}」的名单与成绩。成员本场已记积分低于应得总分时补足差额，已足额的跳过。
                    </AlertDescription>
                  </Alert>
                )}

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{fileName ?? '名单预览'}</span>
                  <span className="tabular-nums">共 {preview.summary.total} 行</span>
                  <span className="text-success tabular-nums">可导入 {preview.summary.ready} 人</span>
                  {preview.summary.teamCount > 0 && (
                    <span className="tabular-nums">共 {preview.summary.teamCount} 支队伍</span>
                  )}
                  <span className="tabular-nums">应得总分合计 {preview.summary.totalPoints} 分</span>
                  <span className="tabular-nums">计入月份 {preview.scoreMonth}</span>
                  {preview.summary.errorCount > 0 && (
                    <span className="text-destructive tabular-nums">{preview.summary.errorCount} 行有问题</span>
                  )}
                </div>

                <div className="max-h-80 overflow-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow className="h-8">
                        <TableHead className="pl-3 text-xs">行</TableHead>
                        <TableHead className="text-xs">联动账号</TableHead>
                        {(isTeam || preview.rows.some((r) => r.teamName)) && (
                          <TableHead className="text-xs">队名</TableHead>
                        )}
                        <TableHead className="text-xs">奖项 / 成绩</TableHead>
                        <TableHead className="text-xs">排名</TableHead>
                        <TableHead className="text-xs">本场应得总分</TableHead>
                        <TableHead className="pr-3 text-xs">备注 / 状态</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.rows.map((row) => (
                        <TableRow
                          key={row.row}
                          className={
                            row.needsSelection
                              ? 'bg-amber-500/10'
                              : row.error
                                ? 'bg-destructive-subtle/40'
                                : undefined
                          }
                        >
                          <TableCell className="py-1.5 pl-3 text-xs tabular-nums text-muted-foreground">
                            {row.row}
                          </TableCell>
                          <TableCell className="py-1.5 text-xs">
                            {row.needsSelection && row.candidates?.length ? (
                              <div className="flex min-w-44 flex-col gap-1">
                                <Select
                                  value={selectedUsers[row.row] ?? ''}
                                  onValueChange={(value) => handleChooseMember(row.row, value)}
                                  disabled={previewMutation.isPending}
                                >
                                  <SelectTrigger className="h-7 px-2 text-xs" aria-label={`第 ${row.row} 行选择成员`}>
                                    <SelectValue placeholder={`${row.inputName ?? '同名'} · 选择成员`} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {row.candidates.map((candidate) => (
                                      <SelectItem key={candidate.userId} value={candidate.userId}>
                                        {candidate.studentNo} · {candidate.name}
                                        {candidate.grade != null ? ` · ${candidate.grade}级` : ''}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <span className="text-amber-700 dark:text-amber-400">重名待选择</span>
                              </div>
                            ) : (
                              <>
                                <span className="block">
                                  {row.memberName ?? row.inputName ?? '—'}
                                  {row.matchSource === 'name' && <Tag>姓名匹配</Tag>}
                                  {row.matchSource === 'selected' && <Tag>已手动选择</Tag>}
                                </span>
                                <span className="block text-muted-foreground tabular-nums">
                                  {row.studentNo || '—'}
                                  {row.grade != null ? ` · ${row.grade}级` : ''}
                                </span>
                                {row.matchWarning && (
                                  <span className="block text-warning-foreground">{row.matchWarning}</span>
                                )}
                              </>
                            )}
                          </TableCell>
                          {(isTeam || preview.rows.some((r) => r.teamName)) && (
                            <TableCell className="py-1.5 text-xs">{row.teamName ?? '—'}</TableCell>
                          )}
                          <TableCell className="py-1.5 text-xs">{row.awardText ?? '—'}</TableCell>
                          <TableCell className="py-1.5 text-xs tabular-nums">{row.rankText ?? '—'}</TableCell>
                          <TableCell className="py-1.5 text-xs tabular-nums" title={row.pointsHint}>
                            {row.points}
                            {row.pointsSource === 'tier_rule' && <Tag>档位自动</Tag>}
                            {row.pointsSource === 'roster_only' && <Tag>仅记名单</Tag>}
                          </TableCell>
                          <TableCell className="py-1.5 pr-3 text-xs text-muted-foreground">
                            {row.error ? <span className="text-destructive">{row.error}</span> : row.note ?? '就绪'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            )}

            {commitMutation.error && (
              <Alert variant="destructive">
                <AlertDescription>{(commitMutation.error as ApiError).message}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
              <span className="text-xs text-muted-foreground">
                {preview && preview.summary.duplicateNameCount > 0
                  ? `还有 ${preview.summary.duplicateNameCount} 行重名未选择，选择完毕后即可提交导入。`
                  : '导入后将自动创建并归档该场正式赛，同步写入参赛名单、成绩与成员积分账本。'}
              </span>
              <Button disabled={!canCommit} onClick={() => commitMutation.mutate()}>
                {commitMutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
                {preview?.existingEvent
                  ? `归档至已有比赛（${preview.summary.ready} 人）`
                  : `创建比赛并归档积分（${preview?.summary.ready ?? 0} 人）`}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="ml-1 rounded bg-primary/10 px-1 text-[10px] text-primary">{children}</span>;
}

function CommitResultView({
  result,
  onViewContests,
  onAgain,
}: {
  result: CommitResponseDto;
  onViewContests: () => void;
  onAgain: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 text-sm">
      <Alert variant={result.failed > 0 ? 'destructive' : 'info'}>
        <CheckCircle2Icon aria-hidden="true" />
        <AlertTitle>正式赛导入与归档完成</AlertTitle>
        <AlertDescription className="flex flex-col gap-1">
          <span>
            赛事「{result.event.title}」
            <Badge variant="success" className="mx-1.5">
              {result.event.created ? '已自动创建并归档' : '已复用并更新归档'}
            </Badge>
            （计分月份 {result.event.scoreMonth}）
          </span>
          <span className="tabular-nums">
            登记名单 {result.registeredCount} 人
            {result.teamsCreated > 0 ? `（新建 ${result.teamsCreated} 支队伍）` : ''}；
            新增积分流水 {result.posted} 条
            {result.rosterOnly > 0 ? `，仅记名单（0 分）${result.rosterOnly} 人` : ''}
            {result.duplicate > 0 ? `，跳过入账 ${result.duplicate} 人` : ''}
            {result.failed > 0 ? `，失败 ${result.failed} 条` : ''}。
          </span>
        </AlertDescription>
      </Alert>

      {result.rows.length > 0 && (
        <div className="max-h-64 overflow-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>行</TableHead>
                <TableHead>成员</TableHead>
                <TableHead>本场应得总分</TableHead>
                <TableHead>本次入账</TableHead>
                <TableHead>结果</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.map((row) => (
                <TableRow key={row.row}>
                  <TableCell className="tabular-nums">{row.row}</TableCell>
                  <TableCell>{row.memberName ?? row.studentNo}</TableCell>
                  <TableCell className="tabular-nums">{row.points}</TableCell>
                  <TableCell className="tabular-nums">
                    {row.postedAmount ?? (row.status === 'duplicate' || row.status === 'roster_only' ? '0' : '—')}
                  </TableCell>
                  <TableCell className={row.status === 'failed' ? 'whitespace-normal text-destructive' : 'whitespace-normal'}>
                    {row.error ?? { archived: '已入账', duplicate: '已足额', roster_only: '仅记名单', failed: '失败' }[row.status]}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onAgain}>
          继续导入其他比赛
        </Button>
        <Button onClick={onViewContests}>
          <TrophyIcon aria-hidden="true" />
          前往正式赛事查看
        </Button>
      </div>
    </div>
  );
}
