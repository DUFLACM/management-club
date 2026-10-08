import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { fetchNowcoderContestMeta } from '@acm/integrations'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { ContestStandingsService, contestExternalUrl, type StandingsEntry } from '../activities/contest-standings.service.js'
import { ScoringService, ScoringError } from './scoring.service.js'
import { computeContestW, hasValidSubmission, type ContestFormulaResult, type LambdaKey } from './contest-formula.js'
import { newId } from '../../common/utils.js'
import type { SessionActor } from '../auth/session.service.js'

/**
 * 历史积分导入（系统上线前已有的积分），全部来自 Excel 模板：
 * - 普通行：学号 + 积分 + 活动名称 + 活动日期，按「活动名称 + 日期」归组建归档活动存档；
 * - 平台比赛行：填写 平台 + 比赛场次 + 平台账号，系统只抓表格里出现的比赛榜单、
 *   只按表格里填写的平台账号查成绩；积分列留空时按 W 公式自动计算（社内名次按同场表格内的成员排），
 *   比赛名称 / 日期留空时取平台元数据；同一场比赛的行挂到同一个活动（已有该比赛活动则复用，否则建归档存档）。
 * - 两步：preview 抓榜单并补全积分 / 名称 / 日期（不入账）→ importExcel 入账。
 * - 幂等：普通行 sourceKey = history:{活动}:{成员}:{类别}；比赛行与结算引擎共用 contest:{平台}:{比赛}:W:{成员}，
 *   整份文件重导、或该场已被结算引擎计过分，都不会重复入账。
 */

export const HISTORY_CATEGORIES = ['contest', 'remote_contest', 'activity', 'contribution', 'service', 'award', 'initial', 'penalty'] as const
export const HISTORY_ACTIVITY_TYPES = ['weekly_contest', 'monthly_contest', 'custom_contest', 'lecture', 'training', 'meeting', 'gathering', 'camp', 'service'] as const
export const CONTEST_PLATFORMS = ['nowcoder', 'codeforces', 'atcoder'] as const

const amountSchema = z.string().regex(/^-?\d+(\.\d+)?$/, '积分为十进制数字（可负）')
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '活动日期格式为 YYYY-MM-DD')

const baseRowSchema = z.object({
  row: z.number().int().min(1),
  studentNo: z.string().min(1).max(64),
  category: z.enum(HISTORY_CATEGORIES),
  activityType: z.enum(HISTORY_ACTIVITY_TYPES).optional(),
  scoreMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  note: z.string().max(300).optional(),
  platform: z.enum(CONTEST_PLATFORMS).optional(),
  contestId: z.string().trim().min(1).max(64).optional(),
  handle: z.string().trim().min(1).max(64).optional(),
})

const previewRowSchema = baseRowSchema.extend({
  amount: amountSchema.optional(),
  activityTitle: z.string().trim().max(120).optional(),
  activityDate: dateSchema.optional(),
})

export const historyPreviewSchema = z.object({
  rows: z.array(previewRowSchema).min(1).max(2000),
  lambdaKey: z.enum(['A', 'B', 'C', 'auto']).default('auto'),
  cap: z.number().min(1).max(25).default(20),
})
export type HistoryPreviewInput = z.infer<typeof historyPreviewSchema>

export const historyExcelSchema = z.object({
  rows: z.array(baseRowSchema.extend({
    amount: amountSchema,
    activityTitle: z.string().trim().min(2, '活动名称至少 2 个字').max(120),
    activityDate: dateSchema,
    /** 平台比赛行：预览阶段取到的比赛起止时间，用于新建存档 */
    contestStartAt: z.string().datetime().optional(),
    contestEndAt: z.string().datetime().optional(),
  }).refine((row) => !row.platform || row.contestId, { message: '填写了平台就必须填写比赛场次', path: ['contestId'] })).min(1).max(2000),
})
export type HistoryExcelInput = z.infer<typeof historyExcelSchema>

type RowOutcome = { row: number; studentNo: string; status: 'posted' | 'duplicate' | 'failed'; error?: string }

interface ContestSummary {
  platform: string
  contestId: string
  available: boolean
  reason: string | null
  name: string | null
  startAt: string | null
  endAt: string | null
  url: string | null
  totalEntries: number
  problemCount: number
  lambda: { key: LambdaKey; source: string } | null
  existingActivity: { id: string; title: string } | null
}

/** 活动日期按业务时区 Asia/Shanghai 解释 */
function shanghaiDay(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00+08:00`)
  if (Number.isNaN(start.getTime())) throw new ScoringError(`活动日期无效：${date}`, 'INVALID_INPUT')
  return { start, end: new Date(start.getTime() + 24 * 3600_000 - 60_000) }
}

/** ISO 时间 → 上海时区日期 YYYY-MM-DD */
function shanghaiDate(iso: string): string {
  return new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function defaultActivityType(category: string): string {
  if (category === 'contest' || category === 'remote_contest') return 'custom_contest'
  if (category === 'contribution') return 'lecture'
  if (category === 'service') return 'service'
  return 'training'
}

/** 牛客按数字 UID 精确匹配；CF / AtCoder 用户名大小写不敏感 */
function findEntry(platform: string, entries: StandingsEntry[], handle: string): StandingsEntry | undefined {
  const exact = entries.find((entry) => entry.handle === handle)
  if (exact || platform === 'nowcoder') return exact
  const lowered = handle.toLowerCase()
  return entries.find((entry) => entry.handle.toLowerCase() === lowered)
}

const ARCHIVE_NOTE = '历史积分导入存档：系统上线前的活动记录，仅用于展示积分来源，不开放报名与签到。'

@Injectable()
export class HistoryImportService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ScoringService) private readonly scoring: ScoringService,
    @Inject(ContestStandingsService) private readonly standings: ContestStandingsService,
  ) {}

  /**
   * 预览：核对学号；对平台比赛行抓取表格中出现的比赛榜单，按表格里的平台账号查成绩，
   * 积分留空的按 W 公式计算，比赛名称 / 日期留空的用平台元数据补全。不入账。
   */
  async preview(input: HistoryPreviewInput) {
    const studentNos = [...new Set(input.rows.map((row) => row.studentNo))]
    const users = await this.db.user.findMany({
      where: { studentNo: { in: studentNos } },
      select: { studentNo: true, verifiedRealName: true, profile: { select: { displayName: true } } },
    })
    const nameByNo = new Map(users.map((user) => [user.studentNo, user.profile?.displayName ?? user.verifiedRealName]))

    type Resolved = (typeof input.rows)[number] & {
      memberName: string | null
      contestStartAt?: string
      contestEndAt?: string
      computed?: { platformRank: number | null; solvedCount: number; score: number; formula: ContestFormulaResult | null }
      error?: string
    }
    const resolved: Resolved[] = input.rows.map((row) => ({
      ...row,
      memberName: nameByNo.get(row.studentNo) ?? null,
      ...(nameByNo.has(row.studentNo) ? {} : { error: '成员不存在（学号未注册，可先在成员管理导入）' }),
    }))

    const groups = new Map<string, Resolved[]>()
    for (const row of resolved) {
      if (!row.platform || !row.contestId) continue
      const key = `${row.platform}:${row.contestId}`
      groups.set(key, [...(groups.get(key) ?? []), row])
    }

    const contests: ContestSummary[] = []
    for (const rows of groups.values()) {
      const platform = rows[0].platform!
      const contestId = rows[0].contestId!
      const summary = await this.loadContest(platform, contestId, rows.find((row) => row.activityTitle)?.activityTitle ?? null, input.lambdaKey)
      contests.push(summary.info)

      // 按表格里的平台账号查榜单成绩
      const found = rows.map((row) => ({ row, entry: summary.entries && row.handle ? findEntry(platform, summary.entries, row.handle) : undefined }))
      const valid = found
        .filter((item): item is { row: Resolved; entry: StandingsEntry } => item.entry != null && hasValidSubmission({ ...item.entry, platformRank: item.entry.rank }))
        .sort((a, b) => b.entry.solvedCount - a.entry.solvedCount || b.entry.score - a.entry.score)
      // 同一成员同场多行时，只按第一次出现参与社内排名
      const rankOf = new Map<string, number>()
      for (const item of valid) if (!rankOf.has(item.row.studentNo)) rankOf.set(item.row.studentNo, rankOf.size + 1)

      for (const { row, entry } of found) {
        if (!row.activityTitle) row.activityTitle = summary.info.existingActivity?.title ?? summary.info.name ?? undefined
        const startIso = summary.startAt ?? null
        if (!row.activityDate && startIso) row.activityDate = shanghaiDate(startIso)
        if (startIso) row.contestStartAt = startIso
        if (summary.endAt) row.contestEndAt = summary.endAt
        if (row.error) continue

        if (entry) {
          const clubRank = rankOf.get(row.studentNo)
          const formula = clubRank == null || !summary.info.lambda ? null : computeContestW({
            solvedCount: entry.solvedCount,
            score: entry.score,
            platformRank: entry.rank,
            clubRank,
            validCount: rankOf.size,
            totalProblems: summary.info.problemCount,
            fullTotal: summary.fullTotal,
            totalEntries: summary.info.totalEntries,
            lambdaKey: summary.info.lambda.key,
            remote: false,
            cap: input.cap,
          })
          row.computed = { platformRank: entry.rank, solvedCount: entry.solvedCount, score: entry.score, formula }
          if (row.amount == null) {
            if (formula) row.amount = formula.W.toFixed(2)
            else row.error = '榜上无有效提交，不自动计分（如需计分请在积分列手填）'
          }
        } else if (row.amount == null) {
          row.error = !summary.info.available
            ? `榜单抓取失败：${summary.info.reason}；可在积分列手填`
            : !row.handle
              ? '缺少平台账号，无法从榜单查成绩（或在积分列手填）'
              : `榜单中未找到账号「${row.handle}」，请核对平台账号`
        }
      }
    }

    for (const row of resolved) {
      if (row.error) continue
      if (row.amount == null) row.error = '缺少积分'
      else if (!row.activityTitle || row.activityTitle.length < 2) row.error = row.platform ? '无法获取比赛名称，请在「活动名称」列填写' : '缺少活动名称'
      else if (!row.activityDate) row.error = row.platform ? '无法获取比赛日期，请在「活动日期」列填写' : '缺少活动日期'
    }

    return {
      rows: resolved,
      contests,
      validCount: resolved.filter((row) => !row.error).length,
    }
  }

  /** 抓取单场比赛：榜单 + 元数据（榜单附带 → 已缓存的平台比赛 → 牛客比赛页）+ 已有活动 + λ */
  private async loadContest(platform: string, contestId: string, titleHint: string | null, lambdaKey: HistoryPreviewInput['lambdaKey']) {
    const result = await this.standings.fetch(platform, contestId)
    const [existing, cached] = await Promise.all([
      this.db.activity.findFirst({
        where: { platform, platformContestId: contestId, status: { not: 'cancelled' } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, title: true, startAt: true, endAt: true },
      }),
      this.db.platformContest.findUnique({ where: { platform_externalContestId: { platform, externalContestId: contestId } } }),
    ])
    const snapshot = result.available ? result : null
    let name = snapshot?.contest?.name ?? cached?.name ?? null
    let startAt = existing?.startAt.toISOString() ?? snapshot?.contest?.startAt ?? cached?.startTime.toISOString() ?? null
    let endAt = existing?.endAt.toISOString() ?? snapshot?.contest?.endAt ?? cached?.endTime?.toISOString() ?? null
    if (platform === 'nowcoder' && (!name || !startAt)) {
      const meta = await fetchNowcoderContestMeta(this.db, contestId).catch(() => null)
      if (meta?.contest) {
        name = name ?? meta.contest.name
        startAt = startAt ?? meta.contest.startTime.toISOString()
        endAt = endAt ?? meta.contest.endTime?.toISOString() ?? null
      }
    }
    const lambda = lambdaKey === 'auto'
      ? await this.scoring.resolveLambda(platform, existing?.title ?? titleHint ?? name ?? '', null)
      : { lambdaKey: lambdaKey as LambdaKey, lambdaSource: '导入时手动指定' }
    const info: ContestSummary = {
      platform,
      contestId,
      available: result.available,
      reason: result.available ? null : result.reason,
      name,
      startAt,
      endAt,
      url: contestExternalUrl(platform, contestId),
      totalEntries: snapshot?.entries.length ?? 0,
      problemCount: snapshot?.problems.length ?? 0,
      lambda: { key: lambda.lambdaKey, source: lambda.lambdaSource },
      existingActivity: existing ? { id: existing.id, title: existing.title } : null,
    }
    return {
      info,
      entries: snapshot?.entries ?? null,
      fullTotal: snapshot?.problems.reduce((sum, problem) => sum + (problem.fullScore ?? 0), 0) ?? 0,
      startAt,
      endAt,
    }
  }

  async importExcel(actor: SessionActor, input: HistoryExcelInput): Promise<{
    batchId: string
    posted: number
    duplicate: number
    failed: number
    activities: Array<{ id: string; title: string; date: string; created: boolean }>
    rows: RowOutcome[]
  }> {
    const batchId = newId()
    const studentNos = [...new Set(input.rows.map((row) => row.studentNo))]
    const users = await this.db.user.findMany({ where: { studentNo: { in: studentNos } }, select: { id: true, studentNo: true } })
    const userByNo = new Map(users.map((user) => [user.studentNo, user.id]))

    type Row = HistoryExcelInput['rows'][number] & { userId: string }
    const outcomes: RowOutcome[] = []
    const groups = new Map<string, Row[]>()
    for (const row of input.rows) {
      const userId = userByNo.get(row.studentNo)
      if (!userId) {
        outcomes.push({ row: row.row, studentNo: row.studentNo, status: 'failed', error: '成员不存在（学号未注册，可先在成员管理导入）' })
        continue
      }
      shanghaiDay(row.activityDate)
      // 比赛行按平台 + 场次归组，普通行按活动名称 + 日期归组
      const key = row.platform && row.contestId
        ? `contest\u0000${row.platform}\u0000${row.contestId}`
        : `history\u0000${row.activityTitle}\u0000${row.activityDate}`
      groups.set(key, [...(groups.get(key) ?? []), { ...row, userId }])
    }

    const activities: Array<{ id: string; title: string; date: string; created: boolean }> = []
    for (const rows of groups.values()) {
      const first = rows[0]
      const isContest = Boolean(first.platform && first.contestId)
      const { activityId, title, created } = isContest
        ? await this.ensureContestActivity(actor, first)
        : await this.ensureHistoryActivity(actor, first.activityTitle, first.activityDate, first.activityType ?? defaultActivityType(first.category))
      activities.push({ id: activityId, title, date: first.activityDate, created })
      for (const row of rows) {
        try {
          const result = await this.scoring.postLedgerEntry(actor, {
            userId: row.userId,
            sourceKey: isContest
              ? `contest:${row.platform}:${row.contestId}:W:${row.userId}`
              : `history:${activityId}:${row.userId}:${row.category}`,
            category: row.category,
            amount: row.amount,
            scoreMonth: row.scoreMonth ?? row.activityDate.slice(0, 7),
            detail: {
              activityId,
              activityTitle: title,
              note: row.note ?? null,
              source: isContest ? 'history_excel_contest' : 'history_excel',
              importBatchId: batchId,
              sheetRow: row.row,
              ...(isContest ? { platform: row.platform, contestId: row.contestId, handle: row.handle ?? null } : {}),
            },
          })
          outcomes.push({
            row: row.row,
            studentNo: row.studentNo,
            status: result.deduplicated ? 'duplicate' : 'posted',
            ...(result.deduplicated ? { error: isContest ? '该成员本场比赛积分已入账，已跳过' : '该成员在此活动的同类积分已入账，已跳过' } : {}),
          })
        } catch (error) {
          outcomes.push({ row: row.row, studentNo: row.studentNo, status: 'failed', error: error instanceof Error ? error.message : '入账失败' })
        }
      }
    }
    outcomes.sort((a, b) => a.row - b.row)
    const posted = outcomes.filter((o) => o.status === 'posted').length
    const duplicate = outcomes.filter((o) => o.status === 'duplicate').length
    const failed = outcomes.filter((o) => o.status === 'failed').length
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'points.history_import',
      resourceType: 'points_ledger',
      resourceId: batchId,
      summary: `Excel 历史积分导入：${input.rows.length} 行，入账 ${posted}、重复 ${duplicate}、失败 ${failed}；涉及活动 ${activities.length} 个（新建存档 ${activities.filter((a) => a.created).length}）`,
    })
    return { batchId, posted, duplicate, failed, activities, rows: outcomes }
  }

  /** 同名同日的历史存档活动复用，保证整份文件重导时积分挂到同一活动上 */
  private async ensureHistoryActivity(actor: SessionActor, title: string, date: string, type: string): Promise<{ activityId: string; title: string; created: boolean }> {
    const { start, end } = shanghaiDay(date)
    const existing = await this.db.activity.findFirst({
      where: { sourceType: 'history', title, startAt: start },
      select: { id: true },
    })
    if (existing) return { activityId: existing.id, title, created: false }
    const activityId = await this.createArchive(actor, { type, sourceType: 'history', title, startAt: start, endAt: end })
    return { activityId, title, created: true }
  }

  /** 同一场平台比赛复用已有活动（含结算引擎用过的活动），没有则建归档存档 */
  private async ensureContestActivity(
    actor: SessionActor,
    row: HistoryExcelInput['rows'][number],
  ): Promise<{ activityId: string; title: string; created: boolean }> {
    const existing = await this.db.activity.findFirst({
      where: { platform: row.platform!, platformContestId: row.contestId!, status: { not: 'cancelled' } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, title: true },
    })
    if (existing) return { activityId: existing.id, title: existing.title, created: false }
    const day = shanghaiDay(row.activityDate)
    const startAt = row.contestStartAt ? new Date(row.contestStartAt) : day.start
    const endAt = row.contestEndAt && new Date(row.contestEndAt) > startAt ? new Date(row.contestEndAt) : day.end
    const activityId = await this.createArchive(actor, {
      type: row.activityType ?? 'custom_contest',
      sourceType: 'platform',
      platform: row.platform!,
      platformContestId: row.contestId!,
      title: row.activityTitle,
      startAt,
      endAt,
    })
    return { activityId, title: row.activityTitle, created: true }
  }

  private async createArchive(
    actor: SessionActor,
    data: { type: string; sourceType: string; title: string; startAt: Date; endAt: Date; platform?: string; platformContestId?: string },
  ): Promise<string> {
    const activityId = newId()
    await this.db.activity.create({
      data: {
        id: activityId,
        ...data,
        announcement: ARCHIVE_NOTE,
        requireValidSubmission: Boolean(data.platform),
        status: 'archived',
        createdBy: actor.principalId,
      },
    })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'activity.history_archive',
      resourceType: 'activity',
      resourceId: activityId,
      summary: `历史积分导入新建存档活动：${data.title}${data.platform ? `（${data.platform} ${data.platformContestId}）` : ''}`,
    })
    return activityId
  }
}
