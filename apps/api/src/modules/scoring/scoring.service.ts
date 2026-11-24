import { DomainError } from '../../common/domain-error.js'
import type { Prisma } from '@acm/db'
import { Inject, Injectable, Optional } from '@nestjs/common'
import {
  buildSourceKey,
  computeEffectiveScore,
  defaultRuleParams,
  rollupMonthly,
  ruleParamsSchema,
  RULE_GAPS,
  type RuleParams,
  type SourceKeyParts,
} from '@acm/scoring-core'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { ActivityService } from '../activities/activity.service.js'
import { ContestStandingsService } from '../activities/contest-standings.service.js'
import { initialSummary, rankEligibleMembers } from './effective-ranking.js'
import { mergeRuleParams } from './rule-params.js'
import { computeContestW, hasValidSubmission, type LambdaKey } from './contest-formula.js'
import { newId, monthKey, monthKeyPlus, memberName, visibleAvatar } from '../../common/utils.js'
import type { SessionActor } from '../auth/session.service.js'
import { z } from 'zod'

/**
 * 积分账本/月度/有效积分/公示/冻结（02 方案 5.4、6.3、6.4；04 方案）：
 * - source_key 稳定逻辑键（不含活动/地点/rule_version）；部分唯一索引保证同一来源只有一条 approved。
 * - 纠错：冲正 + 替代，不改总分、不删历史。
 * - 月度 rollup 使用 scoring-core；R01 未决时不发布正式 M。
 * - 公示 ≥48h；复核单人裁决即结案；冻结后回填不改变名单。
 */

export class ScoringError extends DomainError {
  constructor(message: string, readonly code: string) {
    super(message, code)
  }
}

export const ledgerEntrySchema = z.object({
  userId: z.string().uuid(),
  sourceKey: z.string().min(3).max(200),
  category: z.enum(['contest', 'remote_contest', 'activity', 'contribution', 'service', 'award', 'initial', 'penalty', 'reversal']),
  amount: z.string().regex(/^-?\d+(\.\d+)?$/, '金额为十进制字符串'),
  scoreMonth: z.string().regex(/^\d{4}-\d{2}$/),
  detail: z.record(z.string(), z.unknown()).optional(),
  evidenceRef: z.string().max(500).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
})

interface MemberOption {
  userId: string
  studentNo: string
  name: string
  displayName: string | null
  grade: number | null
}

export interface MemberQueryResult {
  query: string
  match: MemberOption | null
  candidates: MemberOption[]
  error?: string
}

function memberOption(user: {
  id: string
  studentNo: string
  verifiedRealName: string
  grade: number | null
  profile: { displayName: string | null } | null
}): MemberOption {
  return {
    userId: user.id,
    studentNo: user.studentNo,
    name: user.verifiedRealName,
    displayName: user.profile?.displayName ?? null,
    grade: user.grade,
  }
}

@Injectable()
export class ScoringService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ActivityService) private readonly activityService: ActivityService,
    @Inject(ContestStandingsService) private readonly standingsService: ContestStandingsService,
    @Optional() @Inject(NotificationsService) private readonly notifications?: NotificationsService,
  ) {}

  private async currentRuleVersion(): Promise<{ id: string; params: RuleParams }> {
    const rv = await this.db.ruleVersion.findFirst({ where: { status: 'published' }, orderBy: { version: 'desc' } })
    // 旧版本参数经默认值合并补齐（R01–R13 拍板后的新字段对历史版本同样生效）
    if (rv) return { id: rv.id, params: mergeRuleParams(rv.params) }
    const fallback = await this.db.ruleVersion.findFirst({ orderBy: { version: 'desc' } })
    if (fallback) return { id: fallback.id, params: mergeRuleParams(fallback.params) }
    return { id: 'default', params: defaultRuleParams() }
  }

  /** λ 档来源：公告指定 → 指定比赛目录按标题匹配 → 默认乙类 */
  async resolveLambda(platform: string, title: string, announced?: string | null): Promise<{ lambdaKey: LambdaKey; lambdaSource: string }> {
    if (announced === 'A' || announced === 'B' || announced === 'C') return { lambdaKey: announced, lambdaSource: '活动公告' }
    const catalog = await this.db.designatedContest.findMany({
      where: { status: 'active', platform, lambdaKey: { not: null } },
    })
    const lowered = title.toLowerCase()
    const matched = catalog.find((entry) =>
      entry.name
        .split(/[/（）()、,，]+/)
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token.length >= 3)
        .some((token) => lowered.includes(token)),
    )
    if (matched?.lambdaKey === 'A' || matched?.lambdaKey === 'B' || matched?.lambdaKey === 'C') {
      return { lambdaKey: matched.lambdaKey, lambdaSource: `指定目录（${matched.name}）` }
    }
    return { lambdaKey: 'B', lambdaSource: '默认乙类（未匹配公告与目录，可复核后重跑）' }
  }

  /**
   * 平台赛积分结算引擎：活动结束 5 分钟后触发（管理端按钮或调度器）。
   * - λ 来源：活动公告 scoringConfig.lambdaKey → 指定目录匹配（附录一系数）→ 默认乙类；
   * - 有效提交（R04）由引擎从平台榜单自动判定：有通过/得分/失败提交痕迹即有效；
   * - W = B + λ(4S + 6R) + X；远程 0.5×[...]，上限常规 20 / specialCap，远程减半；
   * - 到场 = IN 检查点（含人工复核补签）；缺到场/无提交 → skipped 转人工窗口；
   * - 入账幂等（sourceKey 含 userId），成员端活动详情与积分同步展示。
   */
  async settleContestScores(actor: SessionActor | null, activityId: string): Promise<{
    posted: number
    deduplicated: number
    skipped: Array<{ name: string; reason: string }>
    lambda: { key: string; source: string }
    cap: number
    validCount: number
  }> {
    const activity = await this.db.activity.findUnique({
      where: { id: activityId },
      select: { id: true, title: true, platform: true, platformContestId: true, startAt: true, endAt: true, scoringConfig: true },
    })
    if (!activity) throw new ScoringError('活动不存在', 'NOT_FOUND')
    if (!activity.platform || !activity.platformContestId) throw new ScoringError('本活动未关联平台赛事', 'NOT_CONTEST')
    if (activity.endAt.getTime() + 5 * 60_000 > Date.now()) {
      throw new ScoringError('比赛结束后有 5 分钟数据同步处理窗口，请稍后再试', 'PROCESSING_WINDOW')
    }
    const { activity: _a, contestUrl, result, isTeam, clubRows, teamRows, unmatchedTeams, problems, totalEntries } =
      await this.activityService.platformClubRows(activityId, this.standingsService)
    void _a
    if (!result.available) {
      throw new ScoringError(`平台榜单暂不可用：${result.reason}${contestUrl ? `（可稍后重试或前往 ${contestUrl} 核对）` : ''}`, 'STANDINGS_UNAVAILABLE')
    }

    // λ：公告 → 指定目录 → 默认乙类（周赛档 λ=1.0）
    const config = (activity.scoringConfig ?? {}) as { lambdaKey?: string; specialCap?: number }
    const { lambdaKey, lambdaSource } = await this.resolveLambda(activity.platform, activity.title, config.lambdaKey)
    const cap = Math.min(config.specialCap ?? 20, 25)
    const totalProblems = problems.length
    const fullTotal = problems.reduce((sum, problem) => sum + (problem.fullScore ?? 0), 0)

    // 到场 / 远程事实
    const [checkpoints, remotes, presence] = await Promise.all([
      this.db.attendanceCheckpoint.findMany({ where: { activityId, checkpoint: 'IN' }, select: { userId: true } }),
      this.db.remotePermission.findMany({ where: { activityId, status: 'approved' }, select: { userId: true } }),
      this.db.attendanceAttendanceResult.findMany({
        where: { activityId, status: { in: ['ontime', 'late', 'early_leave', 'late_and_early'] } },
        select: { userId: true },
      }),
    ])
    const onsiteSet = new Set([...checkpoints, ...presence].map((row) => row.userId))
    const remoteSet = new Set(remotes.map((row) => row.userId))

    const skipped: Array<{ name: string; reason: string }> = []
    let posted = 0
    let deduplicated = 0

    if (isTeam) {
      // 组队赛：按队伍计算有效提交与社内队伍名次 R，再为队内每位到场/获批远程的成员按同一队成绩入账
      const validTeams = teamRows.filter(hasValidSubmission)
      const rankOfTeam = new Map(validTeams.map((row, index) => [row.teamId, index + 1]))
      for (const teamRow of validTeams) {
        for (const member of teamRow.members) {
          const isRemote = remoteSet.has(member.userId) && !onsiteSet.has(member.userId)
          if (!onsiteSet.has(member.userId) && !isRemote) {
            skipped.push({ name: member.name, reason: `所在小队「${teamRow.teamName}」榜上有提交，但本人无到场记录（未扫码且未人工复核），转人工窗口` })
            continue
          }
          const formula = computeContestW({
            solvedCount: teamRow.solvedCount,
            score: teamRow.score,
            platformRank: teamRow.platformRank,
            clubRank: rankOfTeam.get(teamRow.teamId)!,
            validCount: validTeams.length,
            totalProblems,
            fullTotal,
            totalEntries,
            lambdaKey,
            remote: isRemote,
            cap,
          })
          const outcome = await this.postLedgerEntry(actor, {
            userId: member.userId,
            sourceKey: `contest:${activity.platform}:${activity.platformContestId}:W:${member.userId}`,
            category: isRemote ? 'remote_contest' : 'contest',
            amount: formula.W.toFixed(2),
            scoreMonth: monthKey(activity.endAt),
            detail: {
              activityId,
              activityTitle: activity.title,
              teamId: teamRow.teamId,
              teamName: teamRow.teamName,
              teamHandle: teamRow.handle,
              formula: { B: formula.B, lambda: formula.lambda, lambdaKey, S: formula.S, R: formula.R, X: formula.X, W: formula.W },
              lambdaSource,
              note: `平台组队赛结算引擎自动入账（小队「${teamRow.teamName}」，有效提交由榜单自动核验）`,
            },
          })
          if (outcome.deduplicated) deduplicated++
          else posted++
        }
      }
      for (const teamRow of teamRows) {
        if (!validTeams.includes(teamRow)) {
          skipped.push({ name: `${teamRow.teamName}（${teamRow.members.map((m) => m.name).join('、')}）`, reason: '榜上无有效提交（仅记出勤，不发竞赛分）' })
        }
      }
      for (const team of unmatchedTeams) {
        skipped.push({ name: `${team.teamName}（${team.members.map((m) => m.name).join('、')}）`, reason: '队员绑定的平台账号均未出现在榜单上' })
      }
      await this.persistPlatformResultsForActivity(activity, {
        totalProblems,
        totalEntries,
        participationType: 'TEAM',
        rows: validTeams.flatMap((teamRow) =>
          teamRow.members.map((member) => ({
            userId: member.userId,
            solvedCount: teamRow.solvedCount,
            score: teamRow.score,
            platformRank: teamRow.platformRank,
          })),
        ),
      })
      return { posted, deduplicated, skipped, lambda: { key: lambdaKey, source: lambdaSource }, cap, validCount: validTeams.length }
    }

    // 个人赛：有效提交（R04 引擎自动判定）与社团内排名
    const valid = clubRows.filter(hasValidSubmission)
    const rankOf = new Map(valid.map((row, index) => [row.userId, index + 1]))

    for (const row of valid) {
      const isRemote = remoteSet.has(row.userId) && !onsiteSet.has(row.userId)
      if (!onsiteSet.has(row.userId) && !isRemote) {
        skipped.push({ name: row.name, reason: '榜上有提交但无到场记录（未扫码且未人工复核），转人工窗口' })
        continue
      }
      const formula = computeContestW({
        solvedCount: row.solvedCount,
        score: row.score,
        platformRank: row.platformRank,
        clubRank: rankOf.get(row.userId)!,
        validCount: valid.length,
        totalProblems,
        fullTotal,
        totalEntries,
        lambdaKey,
        remote: isRemote,
        cap,
      })
      const outcome = await this.postLedgerEntry(actor, {
        userId: row.userId,
        sourceKey: `contest:${activity.platform}:${activity.platformContestId}:W:${row.userId}`,
        category: isRemote ? 'remote_contest' : 'contest',
        amount: formula.W.toFixed(2),
        scoreMonth: monthKey(activity.endAt),
        detail: {
          activityId,
          activityTitle: activity.title,
          formula: { B: formula.B, lambda: formula.lambda, lambdaKey, S: formula.S, R: formula.R, X: formula.X, W: formula.W },
          lambdaSource,
          note: '平台赛结算引擎自动入账（有效提交由榜单自动核验）',
        },
      })
      if (outcome.deduplicated) deduplicated++
      else posted++
    }
    // 榜上无提交的绑定成员：仅出勤，不发竞赛分（不报错，列入说明）
    for (const row of clubRows) {
      if (!valid.includes(row)) skipped.push({ name: row.name, reason: '榜上无有效提交（仅记出勤，不发竞赛分）' })
    }
    await this.persistPlatformResultsForActivity(activity, {
      totalProblems,
      totalEntries,
      participationType: 'OFFICIAL',
      rows: valid.map((row) => ({
        userId: row.userId,
        solvedCount: row.solvedCount,
        score: row.score,
        platformRank: row.platformRank,
      })),
    })
    return { posted, deduplicated, skipped, lambda: { key: lambdaKey, source: lambdaSource }, cap, validCount: valid.length }
  }

  /**
   * 结算平台赛时同步落库 platform_contests + platform_results（尤其补齐 VJudge 个人/组队成绩，
   * 使其在「我的资料 → 比赛成绩」「竞赛 → 平台记录」与自动徽标统计中完整可见）。
   */
  private async persistPlatformResultsForActivity(
    activity: { title: string; platform: string | null; platformContestId: string | null; startAt?: Date | null; endAt: Date },
    input: {
      totalProblems: number
      totalEntries: number
      participationType: 'OFFICIAL' | 'TEAM'
      rows: Array<{ userId: string; solvedCount: number; score: number; platformRank: number | null }>
    },
  ): Promise<void> {
    if (!activity.platform || !activity.platformContestId || input.rows.length === 0) return
    if (!this.db.platformContest?.upsert || !this.db.platformResult?.upsert || !this.db.platformAccount?.findMany) return
    try {
      const userIds = [...new Set(input.rows.map((r) => r.userId))]
      const accounts = await this.db.platformAccount.findMany({
        where: { platform: activity.platform, userId: { in: userIds }, status: { in: ['verified', 'pending_review', 'unverified'] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, userId: true, status: true },
      })
      const accountByUser = new Map<string, string>()
      for (const acc of accounts) {
        if (!accountByUser.has(acc.userId) || acc.status === 'verified') {
          accountByUser.set(acc.userId, acc.id)
        }
      }
      if (accountByUser.size === 0) return

      const contest = await this.db.platformContest.upsert({
        where: { platform_externalContestId: { platform: activity.platform, externalContestId: activity.platformContestId } },
        create: {
          id: newId(),
          platform: activity.platform,
          externalContestId: activity.platformContestId,
          name: activity.title,
          startTime: activity.startAt ?? activity.endAt,
          endTime: activity.endAt,
          problemCount: input.totalProblems > 0 ? input.totalProblems : null,
          syncStatus: 'ok',
          lastSyncedAt: new Date(),
        },
        update: {
          name: activity.title,
          ...(input.totalProblems > 0 ? { problemCount: input.totalProblems } : {}),
          syncStatus: 'ok',
          lastSyncedAt: new Date(),
        },
      })

      for (const row of input.rows) {
        const accountId = accountByUser.get(row.userId)
        if (!accountId) continue
        await this.db.platformResult.upsert({
          where: {
            platformContestId_platformAccountId_participationType: {
              platformContestId: contest.id,
              platformAccountId: accountId,
              participationType: input.participationType,
            },
          },
          create: {
            id: newId(),
            platformContestId: contest.id,
            platformAccountId: accountId,
            participationType: input.participationType,
            score: row.score,
            acceptedCount: row.solvedCount,
            problemCount: input.totalProblems > 0 ? input.totalProblems : null,
            rank: row.platformRank,
            rankTotal: input.totalEntries > 0 ? input.totalEntries : null,
            status: 'complete',
            syncedAt: new Date(),
          },
          update: {
            score: row.score,
            acceptedCount: row.solvedCount,
            problemCount: input.totalProblems > 0 ? input.totalProblems : null,
            rank: row.platformRank,
            rankTotal: input.totalEntries > 0 ? input.totalEntries : null,
            status: 'complete',
            syncedAt: new Date(),
            factsVersion: { increment: 1 },
          },
        })
      }
    } catch {
      // 平台结果镜像写失败不回滚已完成的积分结算
    }
  }

  /**
   * 积分入账（审核通过后调用）：幂等（source_key 唯一 approved + idempotencyKey）；
   * 同来源重复入账直接返回原记录；不可静默覆盖。
   */
  /**
   * 批量手动入账：粘贴/导入行（学号或姓名 + 分数 + 备注），逐行解析成员并按批次幂等入账。
   * 同名多人时不会猜测，返回失败并提示改用学号；前端核对接口会先让管理员选择。
   */
  async batchPostEntries(
    actor: SessionActor,
    input: {
      rows: Array<{ studentNo?: string; name?: string; amount: string; note?: string }>;
      category: string;
      activityId?: string;
      scoreMonth?: string;
    },
  ): Promise<{
    batchId: string;
    scoreMonth: string;
    posted: number;
    deduplicated: number;
    failed: Array<{ studentNo: string; error: string }>;
  }> {
    const scoreMonth = input.scoreMonth ?? monthKey(new Date())
    let activityTitle: string | null = null
    if (input.activityId) {
      const activity = await this.db.activity.findUnique({ where: { id: input.activityId }, select: { title: true } })
      if (!activity) throw new ScoringError('关联活动不存在', 'NOT_FOUND')
      activityTitle = activity.title
    }
    const identifiers = [...new Set(input.rows.flatMap((row) => [row.studentNo, row.name]).filter((value): value is string => Boolean(value)))]
    const { byStudentNo, byName } = await this.loadMembersByIdentifiers(identifiers)
    const batchId = newId()
    const failed: Array<{ studentNo: string; error: string }> = []
    let posted = 0
    let deduplicated = 0
    for (const row of input.rows) {
      const label = row.studentNo ?? row.name ?? ''
      let user = row.studentNo ? byStudentNo.get(row.studentNo) : undefined
      if (!user && row.name) {
        const matches = byName.get(row.name) ?? []
        if (matches.length === 1) user = matches[0]
        else if (matches.length > 1) {
          failed.push({ studentNo: label, error: `姓名「${row.name}」对应 ${matches.length} 位成员，请改用学号或在核对表中先选择` })
          continue
        }
      }
      if (!user) {
        failed.push({ studentNo: label, error: '成员不存在（学号 / 姓名未匹配）' })
        continue
      }
      try {
        const result = await this.postLedgerEntry(actor, {
          userId: user.id,
          sourceKey: `manual:${batchId}:${user.id}`,
          category: input.category as never,
          amount: row.amount,
          scoreMonth,
          detail: { note: row.note ?? null, activityId: input.activityId ?? null, activityTitle, batchId },
        })
        if (result.deduplicated) deduplicated++
        else posted++
      } catch (error) {
        failed.push({ studentNo: label, error: error instanceof Error ? error.message : '入账失败' })
      }
    }
    return { batchId, scoreMonth, posted, deduplicated, failed }
  }

  /** 批量核对成员：输入学号或姓名，返回唯一匹配 / 同名候选 / 未找到 */
  async resolveMemberQueries(queries: string[]): Promise<MemberQueryResult[]> {
    const unique = [...new Set(queries.map((query) => query.trim()).filter(Boolean))]
    const { byStudentNo, byName } = await this.loadMembersByIdentifiers(unique)
    return unique.map((query) => {
      const byNo = byStudentNo.get(query)
      if (byNo) return { query, match: memberOption(byNo), candidates: [] }
      const matches = byName.get(query) ?? []
      if (matches.length === 1) return { query, match: memberOption(matches[0]!), candidates: [] }
      if (matches.length > 1) {
        return {
          query,
          match: null,
          candidates: matches.map(memberOption),
          error: `姓名「${query}」对应 ${matches.length} 位成员，请选择具体成员`,
        }
      }
      return { query, match: null, candidates: [], error: '未找到学号或姓名匹配的成员' }
    })
  }

  private async loadMembersByIdentifiers(identifiers: string[]) {
    const users = identifiers.length === 0 ? [] : await this.db.user.findMany({
      where: { OR: [{ studentNo: { in: identifiers } }, { verifiedRealName: { in: identifiers } }] },
      select: {
        id: true,
        studentNo: true,
        verifiedRealName: true,
        grade: true,
        profile: { select: { displayName: true } },
      },
    })
    const byStudentNo = new Map(users.map((user) => [user.studentNo, user]))
    const byName = new Map<string, typeof users>()
    for (const user of users) {
      const list = byName.get(user.verifiedRealName) ?? []
      list.push(user)
      byName.set(user.verifiedRealName, list)
    }
    return { byStudentNo, byName }
  }

  async postLedgerEntry(actor: SessionActor | null, input: z.infer<typeof ledgerEntrySchema>): Promise<{ entryId: string; deduplicated: boolean }> {
    const rule = await this.currentRuleVersion()
    const existing = await this.db.pointsLedgerEntry.findFirst({ where: { sourceKey: input.sourceKey, status: 'approved' } })
    if (existing) {
      return { entryId: existing.id, deduplicated: true }
    }
    const id = newId()
    await this.db.pointsLedgerEntry.create({
      data: {
        id,
        userId: input.userId,
        sourceKey: input.sourceKey,
        category: input.category,
        amount: input.amount,
        scoreMonth: input.scoreMonth,
        recordedAt: new Date(),
        status: 'approved',
        ruleVersionId: rule.id === 'default' ? undefined : rule.id,
        detail: (input.detail ?? undefined) as never,
        evidenceRef: input.evidenceRef,
        approvedBy: actor?.principalId ?? null,
        idempotencyKey: input.idempotencyKey ?? `src:${input.sourceKey}`,
      },
    })
    await this.audit.log({
      actorPrincipalId: actor?.principalId,
      action: 'points.post',
      resourceType: 'points_ledger',
      resourceId: id,
      summary: `${input.category} ${input.amount}（${input.scoreMonth}，来源 ${input.sourceKey}）`,
    })
    const numericAmount = Number(input.amount)
    if (Number.isFinite(numericAmount) && numericAmount !== 0) {
      const sign = numericAmount > 0 ? `+${numericAmount}` : `${numericAmount}`
      const detailObj = input.detail && typeof input.detail === 'object' && !Array.isArray(input.detail)
        ? (input.detail as Record<string, unknown>)
        : null
      const label =
        (typeof detailObj?.activityTitle === 'string' && detailObj.activityTitle) ||
        (typeof detailObj?.eventTitle === 'string' && detailObj.eventTitle) ||
        (typeof detailObj?.title === 'string' && detailObj.title) ||
        (typeof detailObj?.reason === 'string' && detailObj.reason) ||
        input.category
      await this.notifications?.notify({
        userId: input.userId,
        kind: 'points_change',
        title: `积分变动：${sign} 分`,
        body: `归属月份 ${input.scoreMonth}，项目「${label}」已入账 ${sign} 分。`,
        link: '/app?section=points',
      })
    }
    return { entryId: id, deduplicated: false }
  }

  /** 冲正 + 替代（一个事务；保留原记录与依据） */
  async reverseEntry(
    actor: SessionActor,
    entryId: string,
    reason: string,
    replacementAmount: string | null,
  ): Promise<{ reversalId: string; replacementId: string | null }> {
    const result = await this.db.$transaction(async (tx) => {
      const original = await tx.pointsLedgerEntry.findUnique({
        where: { id: entryId },
        select: { userId: true, amount: true, scoreMonth: true },
      })
      const ids = await this.reverseEntryTx(tx, actor, entryId, reason, replacementAmount)
      return { ...ids, original }
    })
    if (result.original) {
      const origNum = Number(result.original.amount)
      const replacementText = replacementAmount != null ? `，并按 ${Number(replacementAmount)} 分重新入账` : ''
      await this.notifications?.notify({
        userId: result.original.userId,
        kind: 'points_change',
        title: '积分流水已更正（冲正）',
        body: `归属月份 ${result.original.scoreMonth} 原 ${origNum} 分记录已冲正${replacementText}。原因：${reason}`,
        link: '/app?section=points',
      })
    }
    return { reversalId: result.reversalId, replacementId: result.replacementId }
  }

  /** 事务内的冲正，供撤回审核与独立冲正共用 */
  private async reverseEntryTx(
    tx: Prisma.TransactionClient,
    actor: SessionActor,
    entryId: string,
    reason: string,
    replacementAmount: string | null,
  ): Promise<{ reversalId: string; replacementId: string | null }> {
    await tx.$executeRaw`SELECT id FROM points_ledger WHERE id = ${entryId}::uuid FOR UPDATE`
    const original = await tx.pointsLedgerEntry.findUnique({ where: { id: entryId } })
    if (!original) throw new ScoringError('原始记录不存在', 'NOT_FOUND')
    if (original.status !== 'approved') throw new ScoringError('仅生效记录可冲正', 'STATE_INVALID')
    const reversalId = newId()
    await tx.pointsLedgerEntry.create({
      data: {
        id: reversalId,
        userId: original.userId,
        sourceKey: `${original.sourceKey}:reversal:${Date.now()}`,
        category: 'reversal',
        amount: original.amount.neg().toFixed(10),
        scoreMonth: original.scoreMonth,
        recordedAt: new Date(),
        status: 'approved',
        ruleVersionId: original.ruleVersionId,
        detail: { reason, originalEntryId: entryId } as never,
        reversesEntryId: entryId,
        reversalReason: reason,
        approvedBy: actor.principalId,
        idempotencyKey: `reversal:${entryId}`,
      },
    })
    await tx.pointsLedgerEntry.update({
      where: { id: entryId },
      data: { status: 'reversed', reversalReason: reason },
    })
    let replacementId: string | null = null
    if (replacementAmount != null) {
      replacementId = newId()
      let replacementDetail: Record<string, unknown> = { reason, replacesEntryId: entryId }
      if (original.detail && typeof original.detail === 'object' && !Array.isArray(original.detail)) {
        const origDetail = original.detail as Record<string, unknown>
        for (const key of ['activityId', 'activityTitle', 'eventId', 'eventTitle', 'claimId', 'title', 'bonusLabel', 'teamId', 'teamName']) {
          if (origDetail[key] != null) replacementDetail[key] = origDetail[key]
        }
      }
      await tx.pointsLedgerEntry.create({
        data: {
          id: replacementId,
          userId: original.userId,
          sourceKey: `${original.sourceKey}:replacement:${Date.now()}`,
          category: original.category,
          amount: replacementAmount,
          scoreMonth: original.scoreMonth,
          recordedAt: new Date(),
          status: 'approved',
          ruleVersionId: original.ruleVersionId,
          detail: replacementDetail as never,
          approvedBy: actor.principalId,
          idempotencyKey: `replacement:${entryId}:${replacementAmount}`,
        },
      })
      await tx.pointsLedgerEntry.update({
        where: { id: entryId },
        data: { replacedByEntryId: replacementId },
      })
    }
    await tx.auditLog.create({
      data: {
        id: newId(),
        actorPrincipalId: actor.principalId,
        action: 'points.reverse',
        resourceType: 'points_ledger',
        resourceId: entryId,
        summary: `冲正 ${original.amount}（${reason}）${replacementAmount != null ? `，替代 ${replacementAmount}` : ''}`,
      },
    })
    return { reversalId, replacementId }
  }

  /** 本人流水（含冲正历史；自动解析关联的活动/赛事/贡献事件名称与跳转链接） */
  async myLedger(userId: string, filters: { month?: string; cursor?: string }) {
    const rows = await this.db.pointsLedgerEntry.findMany({
      where: {
        userId,
        ...(filters.month ? { scoreMonth: filters.month } : {}),
      },
      orderBy: { recordedAt: 'desc' },
      take: 26,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    })
    const nextCursor = rows.length > 25 ? rows.pop()!.id : undefined
    const enriched = await this.enrichLedgerEntries(rows)
    return { items: enriched, nextCursor }
  }

  /** 将账本原记录批量解析为可读事件名称、发生时间与关联内容摘要（避免直接向成员暴露内部 sourceKey） */
  private async enrichLedgerEntries<
    T extends {
      id: string
      sourceKey: string
      category: string
      scoreMonth: string
      recordedAt: Date
      detail: unknown
      reversesEntryId: string | null
      reversalReason: string | null
    },
  >(rows: T[]) {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const asObj = (v: unknown): Record<string, unknown> =>
      v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
    const asStr = (v: unknown): string | null =>
      typeof v === 'string' && v.trim().length > 0 ? v.trim() : null

    const activityIds = new Set<string>()
    const contestKeys = new Map<string, { platform: string; platformContestId: string }>()
    const eventIds = new Set<string>()
    const claimIds = new Set<string>()
    const reversedIds = new Set<string>()

    const extractRefs = (row: { sourceKey: string; detail: unknown; reversesEntryId: string | null }) => {
      const d = asObj(row.detail)
      let actId = asStr(d.activityId)
      let evtId = asStr(d.eventId)
      let clmId = asStr(d.claimId)
      let contestRef: { platform: string; platformContestId: string } | null = null

      const parts = row.sourceKey.split(':')
      if (!actId && (parts[0] === 'history' || parts[0] === 'activity') && parts[1] && UUID_RE.test(parts[1])) {
        actId = parts[1]
      }
      if (!evtId && (parts[0] === 'competition' || parts[0] === 'team-competition') && parts[1] && UUID_RE.test(parts[1])) {
        evtId = parts[1]
      }
      if (!clmId && parts[0] === 'contribution' && parts[2] && UUID_RE.test(parts[2])) {
        clmId = parts[2]
      }
      if (parts[0] === 'contest' && parts[1] && parts[2] && !actId) {
        contestRef = { platform: parts[1], platformContestId: parts[2] }
      }
      const origId = row.reversesEntryId ?? asStr(d.originalEntryId)
      return {
        activityId: actId && UUID_RE.test(actId) ? actId : null,
        eventId: evtId && UUID_RE.test(evtId) ? evtId : null,
        claimId: clmId && UUID_RE.test(clmId) ? clmId : null,
        contestRef,
        originalEntryId: origId && UUID_RE.test(origId) ? origId : null,
      }
    }

    const rowRefs = rows.map((row) => {
      const refs = extractRefs(row)
      if (refs.activityId) activityIds.add(refs.activityId)
      if (refs.eventId) eventIds.add(refs.eventId)
      if (refs.claimId) claimIds.add(refs.claimId)
      if (refs.contestRef) contestKeys.set(`${refs.contestRef.platform}:${refs.contestRef.platformContestId}`, refs.contestRef)
      if (refs.originalEntryId) reversedIds.add(refs.originalEntryId)
      return refs
    })

    const [activitiesById, activitiesByContest, events, claims, originals] = await Promise.all([
      activityIds.size > 0
        ? this.db.activity.findMany({
            where: { id: { in: [...activityIds] } },
            select: { id: true, title: true, type: true, startAt: true, endAt: true, platform: true, platformContestId: true, venueVersion: { select: { name: true, building: true, room: true } } },
          })
        : Promise.resolve([]),
      contestKeys.size > 0
        ? this.db.activity.findMany({
            where: { OR: [...contestKeys.values()].map((c) => ({ platform: c.platform, platformContestId: c.platformContestId })) },
            select: { id: true, title: true, type: true, startAt: true, endAt: true, platform: true, platformContestId: true, venueVersion: { select: { name: true, building: true, room: true } } },
          })
        : Promise.resolve([]),
      eventIds.size > 0
        ? this.db.competitionEvent.findMany({
            where: { id: { in: [...eventIds] } },
            select: { id: true, title: true, category: true, startAt: true, endAt: true, platform: true },
          })
        : Promise.resolve([]),
      claimIds.size > 0
        ? this.db.pointsClaim.findMany({
            where: { id: { in: [...claimIds] } },
            select: { id: true, title: true, category: true, description: true, reviewNote: true, createdAt: true },
          })
        : Promise.resolve([]),
      reversedIds.size > 0
        ? this.db.pointsLedgerEntry.findMany({
            where: { id: { in: [...reversedIds] } },
            select: { id: true, sourceKey: true, category: true, scoreMonth: true, amount: true, detail: true },
          })
        : Promise.resolve([]),
    ])

    const actByIdMap = new Map(activitiesById.map((a) => [a.id, a]))
    const actByContestMap = new Map<string, (typeof activitiesByContest)[number]>()
    for (const a of [...activitiesById, ...activitiesByContest]) {
      if (a.platform && a.platformContestId) {
        actByContestMap.set(`${a.platform}:${a.platformContestId}`, a)
      }
    }
    const eventByIdMap = new Map(events.map((e) => [e.id, e]))
    const claimByIdMap = new Map(claims.map((c) => [c.id, c]))
    const origByIdMap = new Map(originals.map((o) => [o.id, o]))

    const CATEGORY_NAMES: Record<string, string> = {
      contest: '比赛积分',
      remote_contest: '远程比赛积分',
      activity: '活动参与积分',
      contribution: '贡献积分',
      service: '服务积分',
      award: '赛事获奖积分',
      initial: '入社基础分',
      penalty: '纪律扣分',
      reversal: '积分冲正',
    }

    const resolveFallbackTitle = (category: string, scoreMonth: string, detail: Record<string, unknown>): string => {
      const explicit =
        asStr(detail.activityTitle) ??
        asStr(detail.eventTitle) ??
        asStr(detail.title) ??
        asStr(detail.note) ??
        asStr(detail.reason)
      if (explicit) return explicit
      if (category === 'initial') return `入社基础分（${scoreMonth}）`
      return `${CATEGORY_NAMES[category] ?? '积分记录'}（${scoreMonth}）`
    }

    return rows.map((row, idx) => {
      const refs = rowRefs[idx]!
      const d = asObj(row.detail)
      const bonusLabel = asStr(d.bonusLabel)
      const activity =
        (refs.activityId ? actByIdMap.get(refs.activityId) : undefined) ??
        (refs.contestRef ? actByContestMap.get(`${refs.contestRef.platform}:${refs.contestRef.platformContestId}`) : undefined)
      const compEvent = refs.eventId ? eventByIdMap.get(refs.eventId) : undefined
      const claim = refs.claimId ? claimByIdMap.get(refs.claimId) : undefined
      const orig = refs.originalEntryId ? origByIdMap.get(refs.originalEntryId) : undefined

      let eventName: string
      let eventTime: string | null = null
      let eventKind: 'activity' | 'competition' | 'claim' | 'reversal' | 'initial' | 'manual' = 'manual'
      let eventLink: string | null = null
      let eventMeta: Record<string, unknown> | null = null

      if (row.category === 'reversal') {
        eventKind = 'reversal'
        const origDetail = orig ? asObj(orig.detail) : {}
        const origTitle = orig ? resolveFallbackTitle(orig.category, orig.scoreMonth, origDetail) : null
        eventName = origTitle ? `冲正：${origTitle}` : `积分冲正（${row.scoreMonth}）`
        eventTime = row.recordedAt.toISOString()
        eventMeta = {
          reversalReason: row.reversalReason ?? asStr(d.reason),
          originalAmount: orig ? orig.amount.toString() : null,
          originalTitle: origTitle,
        }
      } else if (activity) {
        eventKind = 'activity'
        eventName = bonusLabel ? `${activity.title} · ${bonusLabel}` : activity.title
        eventTime = activity.startAt.toISOString()
        eventLink = `/app?section=activities&activity=${activity.id}`
        const venueParts = activity.venueVersion
          ? [activity.venueVersion.name, activity.venueVersion.building, activity.venueVersion.room].filter(Boolean)
          : []
        eventMeta = {
          activityId: activity.id,
          activityType: activity.type,
          startAt: activity.startAt.toISOString(),
          endAt: activity.endAt.toISOString(),
          venue: venueParts.length > 0 ? venueParts.join(' ') : null,
          platform: activity.platform,
        }
      } else if (compEvent) {
        eventKind = 'competition'
        eventName = compEvent.title
        eventTime = compEvent.startAt.toISOString()
        eventLink = '/app?section=contests&tab=entry'
        eventMeta = {
          eventId: compEvent.id,
          category: compEvent.category,
          startAt: compEvent.startAt.toISOString(),
          endAt: compEvent.endAt.toISOString(),
          teamName: asStr(d.teamName),
          awardText: asStr(d.awardText),
          rankText: asStr(d.rankText),
        }
      } else if (claim) {
        eventKind = 'claim'
        eventName = claim.title
        eventTime = claim.createdAt.toISOString()
        eventLink = '/app?section=contributions'
        eventMeta = {
          claimId: claim.id,
          claimCategory: claim.category,
          description: claim.description,
          reviewNote: claim.reviewNote,
        }
      } else if (row.category === 'initial') {
        eventKind = 'initial'
        eventName = `入社基础分（${row.scoreMonth}）`
        eventTime = row.recordedAt.toISOString()
      } else {
        const baseName = resolveFallbackTitle(row.category, row.scoreMonth, d)
        eventName = bonusLabel && !baseName.includes(bonusLabel) ? `${baseName} · ${bonusLabel}` : baseName
        const actDate = asStr(d.activityDate)
        eventTime = actDate && !Number.isNaN(Date.parse(actDate)) ? new Date(actDate).toISOString() : row.recordedAt.toISOString()
        if (asStr(d.eventTitle)) {
          eventKind = 'competition'
          eventLink = '/app?section=contests&tab=entry'
        } else if (asStr(d.title) && row.category === 'contribution') {
          eventKind = 'claim'
          eventLink = '/app?section=contributions'
        }
      }

      return {
        ...row,
        eventName,
        eventTime,
        eventKind,
        eventLink,
        eventMeta,
      }
    })
  }

  /** 月度汇总 + E（预览；按当前规则版本） */
  async myScoreOverview(userId: string, currentMonth: string) {
    const entries = await this.db.pointsLedgerEntry.findMany({
      where: { userId, status: 'approved' },
      select: { amount: true, scoreMonth: true, category: true },
    })
    const monthlyRaw = new Map<string, number>()
    // 入社基础分（initial）按第八条计入入社当月并参与 E 衰减，但展示上从「当月积分」里拆出来单独显示
    const initialByMonth = new Map<string, number>()
    for (const e of entries) {
      monthlyRaw.set(e.scoreMonth, (monthlyRaw.get(e.scoreMonth) ?? 0) + Number(e.amount))
      if (e.category === 'initial') initialByMonth.set(e.scoreMonth, (initialByMonth.get(e.scoreMonth) ?? 0) + Number(e.amount))
    }
    const round6 = (v: number) => Math.round(v * 1e6) / 1e6
    const monthlyScores: Record<string, number> = {}
    for (const [k, v] of monthlyRaw) monthlyScores[k] = Math.round(v * 1e6) / 1e6
    const rule = await this.currentRuleVersion()
    const effective = computeEffectiveScore({ monthlyScores, currentMonth }, { effectiveWeights: rule.params.effectiveWeights ?? [1, 0.85, 0.7, 0.55, 0.4, 0.25] })
    // raw = 当月积分（不含入社基础分），initial = 该月计入的入社基础分；两者相加才是该月计入 E 的原始分
    const sixMonths: Array<{ month: string; raw: number; initial: number; m: number | null }> = effective.windowMonths.map((month) => ({
      month,
      raw: round6((monthlyScores[month] ?? 0) - (initialByMonth.get(month) ?? 0)),
      initial: initialByMonth.get(month) ?? 0,
      m: null, // 正式 M 依 R01 取整策略确认
    }))
    const eComponents = effective.components.map((c) => ({ month: c.month, m: Number(c.m), weight: Number(c.weight), contribution: Number(c.contribution) }))
    return {
      e: effective.eDisplay,
      eComponents,
      months: sixMonths,
      initial: initialSummary(initialByMonth, eComponents),
      roundingPending: rule.params.monthlyRounding === 'pending',
      roundingNote: rule.params.monthlyRounding === 'pending' ? RULE_GAPS.R01 : null,
    }
  }

  /**
   * 生成月度结算批次（预览）：分类上限→负分→rawTotal；R01 未决不发布正式 M。
   * 按成员+月锁结算范围（02 方案 6.3：防两个审核同时绕过月上限）。
   */
  async buildMonthlyBatch(actor: SessionActor, month: string): Promise<{ batchId: string; blocked: boolean; blockedReason?: string; users: number }> {
    const rule = await this.currentRuleVersion()
    const batchId = newId()
    const entries = await this.db.pointsLedgerEntry.findMany({
      where: { scoreMonth: month, status: 'approved' },
      select: { userId: true, category: true, amount: true },
    })
    const byUser = new Map<string, Array<{ category: string; amount: number }>>()
    for (const e of entries) {
      if (!byUser.has(e.userId)) byUser.set(e.userId, [])
      byUser.get(e.userId)!.push({ category: e.category, amount: Number(e.amount) })
    }
    const capMap: Record<string, 'participation_service' | 'teaching_contribution' | 'contest'> = {
      activity: 'participation_service', service: 'participation_service', contribution: 'teaching_contribution',
      contest: 'contest', remote_contest: 'contest', award: 'contest', initial: 'contest', penalty: 'participation_service', reversal: 'participation_service',
    }
    let blocked = false
    let blockedReason: string | undefined
    await this.db.$transaction(async (tx) => {
      await tx.calculationBatch.create({
        data: { id: batchId, monthKey: month, ruleVersionId: rule.id === 'default' ? undefined : rule.id, status: 'preview', createdBy: actor.principalId },
      })
      for (const [userId, userEntries] of byUser) {
        const positive = userEntries.filter((e) => e.amount > 0).map((e) => ({ category: capMap[e.category] ?? 'contest', amount: e.amount }))
        const negative = userEntries.filter((e) => e.amount < 0).map((e) => ({ category: e.category, amount: e.amount }))
        const result = rollupMonthly({ positiveEntries: positive, negativeEntries: negative, params: rule.params }, rule.params)
        if (result.blockedReason) {
          blocked = true
          blockedReason = result.blockedReason
        }
        await tx.monthlyScore.upsert({
          where: { userId_scoreMonth_revision: { userId, scoreMonth: month, revision: 1 } },
          create: {
            id: newId(), userId, scoreMonth: month, rawTotal: result.rawTotal.toFixed(10),
            m: result.m, roundingPolicy: result.roundingPolicy,
            categoryCaps: { adjusted: result.adjusted.map((a) => ({ category: a.category, original: Number(a.original), allowed: Number(a.allowed), capped: a.capped })) } as never,
            batchId, status: 'draft',
          },
          update: {},
        })
      }
    })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'scoring.batch_preview',
      resourceType: 'calculation_batch',
      resourceId: batchId,
      summary: `月度结算预览 ${month}（${byUser.size} 人）${blocked ? '；正式发布被 R01 阻塞' : ''}`,
    })
    return { batchId, blocked, blockedReason, users: byUser.size }
  }

  /** 发布月度公示（≥48h；发布后写 disclosure_rows 快照；冻结当前 revision） */
  /** 公示批次管理：提前结束 / 删除（删除连同快照行，保留审计） */
  async closeDisclosure(actor: SessionActor, disclosureId: string): Promise<void> {
    const disclosure = await this.db.disclosure.findUnique({ where: { id: disclosureId } })
    if (!disclosure) throw new ScoringError('公示批次不存在', 'NOT_FOUND')
    if (disclosure.status !== 'published') throw new ScoringError('该批次不在公示中', 'STATE_INVALID')
    await this.db.disclosure.update({ where: { id: disclosureId }, data: { status: 'closed', endsAt: new Date() } })
    await this.audit.log({ actorPrincipalId: actor.principalId, action: 'disclosure.close', resourceType: 'disclosure', resourceId: disclosureId, summary: `提前结束 ${disclosure.monthKey} 月度公示` })
  }

  async deleteDisclosure(actor: SessionActor, disclosureId: string): Promise<void> {
    const disclosure = await this.db.disclosure.findUnique({ where: { id: disclosureId } })
    if (!disclosure) throw new ScoringError('公示批次不存在', 'NOT_FOUND')
    await this.db.$transaction(async (tx) => {
      await tx.disclosureRow.deleteMany({ where: { disclosureId } })
      await tx.disclosure.delete({ where: { id: disclosureId } })
    })
    await this.audit.log({ actorPrincipalId: actor.principalId, action: 'disclosure.delete', resourceType: 'disclosure', resourceId: disclosureId, summary: `删除 ${disclosure.monthKey} 月度公示批次（含快照行）` })
  }

  async publishMonthlyDisclosure(actor: SessionActor, month: string, startsAt: Date, endsAt: Date): Promise<{ disclosureId: string }> {
    if (endsAt.getTime() - startsAt.getTime() < 48 * 3600_000) {
      throw new ScoringError('公示期原则上至少 48 小时', 'DISCLOSURE_TOO_SHORT')
    }
    const rule = await this.currentRuleVersion()
    const rows = await this.db.pointsLedgerEntry.findMany({
      where: { scoreMonth: month, status: 'approved' },
      select: { userId: true, amount: true },
    })
    const byUser = new Map<string, number>()
    for (const r of rows) byUser.set(r.userId, (byUser.get(r.userId) ?? 0) + Number(r.amount))
    const users = await this.db.user.findMany({
      where: { id: { in: [...byUser.keys()] } },
      include: { profile: { select: { displayName: true } }, membershipTerms: { orderBy: { createdAt: 'desc' }, take: 1 }, principal: true },
    })
    const currentMonth = monthKey(new Date())
    const sorted = users
      .map((u) => {
        const effective = computeEffectiveScore({ monthlyScores: Object.fromEntries([...byUser].map(([k, v]) => [k, v])), currentMonth }, { effectiveWeights: rule.params.effectiveWeights ?? [1, 0.85, 0.7, 0.55, 0.4, 0.25] })
        return { user: u, monthAdded: byUser.get(u.id) ?? 0, e: Number(effective.e) }
      })
      .sort((a, b) => b.e - a.e)
    const disclosureId = newId()
    await this.db.$transaction(async (tx) => {
      await tx.disclosure.create({
        data: {
          id: disclosureId, type: 'monthly', monthKey: month, scope: 'all_members',
          status: 'published', startsAt, endsAt,
          ruleVersionId: rule.id === 'default' ? undefined : rule.id,
          publishedBy: actor.principalId, publishedAt: new Date(),
        },
      })
      let rank = 0
      for (const row of sorted) {
        rank++
        await tx.disclosureRow.create({
          data: {
            id: newId(), disclosureId, userId: row.user.id, rank,
            displayName: memberName(row.user),
            studentNo: row.user.studentNo, grade: row.user.grade,
            membership: row.user.membershipTerms[0]?.membershipStatus ?? 'unknown',
            lastMonthE: (row.e - row.monthAdded).toFixed(4),
            monthAdded: row.monthAdded.toFixed(4),
            deductions: Math.min(0, 0).toFixed(4),
            currentE: row.e.toFixed(4),
          },
        })
      }
      await tx.auditLog.create({
        data: {
          id: newId(), actorPrincipalId: actor.principalId,
          action: 'disclosure.publish', resourceType: 'disclosure', resourceId: disclosureId,
          summary: `发布月度公示 ${month}（${sorted.length} 行，${startsAt.toISOString()} ~ ${endsAt.toISOString()}）`,
        },
      })
    })
    return { disclosureId }
  }

  /** 榜单：当前有效榜 / 公示快照 */
  async leaderboard(kind: 'current' | 'disclosure', refId: string | undefined, viewerUserId: string | null) {
    if (kind === 'current') {
      // 口径与首页「当前有效榜排名」同源：全集是在册正式/预备/考察成员，E=0 的成员同样在榜
      const rule = await this.currentRuleVersion()
      const ranked = await rankEligibleMembers(this.db, monthKey(new Date()), rule.params.effectiveWeights)
      return {
        kind,
        revision: null,
        frozenAt: null,
        ruleVersion: null,
        rows: ranked.map((r, i) => ({
          rank: i + 1,
          userId: r.userId,
          displayName: r.displayName,
          avatarAssetId: r.avatarAssetId,
          membership: r.membership,
          e: r.eDisplay,
          isMe: r.userId === viewerUserId,
        })),
      }
    }
    if (kind === 'disclosure' && refId) {
      const d = await this.db.disclosure.findUnique({ where: { id: refId }, include: { rows: { orderBy: { rank: 'asc' } } } })
      if (!d) throw new ScoringError('公示不存在', 'NOT_FOUND')
      // 公示行是发布时快照，头像按成员当前资料补上
      const profiles = await this.db.userProfile.findMany({
        where: { userId: { in: d.rows.map((r) => r.userId) } },
        select: { userId: true, avatarAssetId: true, visibility: true },
      })
      const avatarOf = new Map(profiles.map((p) => [p.userId, visibleAvatar(p)]))
      return {
        kind,
        monthKey: d.monthKey,
        startsAt: d.startsAt?.toISOString() ?? null,
        endsAt: d.endsAt?.toISOString() ?? null,
        ruleVersionId: d.ruleVersionId,
        rows: d.rows.map((r) => ({ rank: r.rank, userId: r.userId, displayName: r.displayName, avatarAssetId: avatarOf.get(r.userId) ?? null, studentNo: r.studentNo, membership: r.membership, currentE: Number(r.currentE).toFixed(1), monthAdded: Number(r.monthAdded).toFixed(1), isMe: r.userId === viewerUserId })),
      }
    }
    throw new ScoringError('缺少榜单引用', 'REF_MISSING')
  }

  /** 管理端积分流水查询（支持筛选批量手动加分 / 全部手动入账 / 全部流水） */
  async listAdminLedgerEntries(filters: {
    scope?: 'manual_batch' | 'manual' | 'all'
    month?: string
    status?: string
    q?: string
    cursor?: string
  }) {
    const scope = filters.scope ?? 'manual_batch'
    const andClauses: Prisma.PointsLedgerEntryWhereInput[] = []
    if (scope === 'manual_batch') {
      andClauses.push({ sourceKey: { startsWith: 'manual:' } })
    } else if (scope === 'manual') {
      andClauses.push({
        NOT: {
          OR: [
            { sourceKey: { startsWith: 'contest:' } },
            { sourceKey: { startsWith: 'competition:' } },
            { sourceKey: { startsWith: 'team-competition:' } },
            { sourceKey: { startsWith: 'contribution:' } },
            { sourceKey: { startsWith: 'initial:' } },
            { sourceKey: { startsWith: 'history:' } },
          ],
        },
      })
    }
    if (filters.month && /^\d{4}-\d{2}$/.test(filters.month)) {
      andClauses.push({ scoreMonth: filters.month })
    }
    if (filters.status && ['approved', 'reversed', 'superseded'].includes(filters.status)) {
      andClauses.push({ status: filters.status })
    }
    const q = filters.q?.trim()
    if (q) {
      andClauses.push({
        OR: [
          { user: { studentNo: { contains: q, mode: 'insensitive' } } },
          { user: { verifiedRealName: { contains: q, mode: 'insensitive' } } },
          { sourceKey: { contains: q, mode: 'insensitive' } },
          { reversalReason: { contains: q, mode: 'insensitive' } },
        ],
      })
    }

    const rows = await this.db.pointsLedgerEntry.findMany({
      where: andClauses.length > 0 ? { AND: andClauses } : undefined,
      orderBy: { recordedAt: 'desc' },
      take: 51,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
      include: {
        user: { select: { id: true, verifiedRealName: true, studentNo: true } },
      },
    })
    const nextCursor = rows.length > 50 ? rows.pop()!.id : undefined
    const enriched = await this.enrichLedgerEntries(rows)
    return {
      items: enriched.map((row) => {
        const d = row.detail && typeof row.detail === 'object' && !Array.isArray(row.detail)
          ? (row.detail as Record<string, unknown>)
          : {}
        const batchId =
          (typeof d.batchId === 'string' && d.batchId) ||
          (row.sourceKey.startsWith('manual:') ? row.sourceKey.split(':')[1] ?? null : null)
        const note =
          (typeof d.note === 'string' && d.note.trim()) ||
          (typeof d.reason === 'string' && d.reason.trim()) ||
          null
        return {
          id: row.id,
          userId: row.userId,
          user: row.user,
          sourceKey: row.sourceKey,
          category: row.category,
          amount: row.amount.toString(),
          scoreMonth: row.scoreMonth,
          recordedAt: row.recordedAt.toISOString(),
          status: row.status,
          reversesEntryId: row.reversesEntryId,
          replacedByEntryId: row.replacedByEntryId,
          reversalReason: row.reversalReason,
          batchId,
          note,
          eventName: row.eventName,
          eventKind: row.eventKind,
          eventMeta: row.eventMeta,
        }
      }),
      nextCursor,
    }
  }

  /** 为申诉列表批量补全关联的积分流水摘要（成员端与管理端共用） */
  async attachLedgerToAppeals<T extends { ledgerEntryId: string | null }>(appeals: T[]) {
    const entryIds = [...new Set(appeals.map((a) => a.ledgerEntryId).filter((id): id is string => Boolean(id)))]
    if (entryIds.length === 0) {
      return appeals.map((appeal) => ({ ...appeal, ledgerEntry: null }))
    }
    const rawEntries = await this.db.pointsLedgerEntry.findMany({
      where: { id: { in: entryIds } },
      select: {
        id: true,
        sourceKey: true,
        category: true,
        amount: true,
        scoreMonth: true,
        recordedAt: true,
        status: true,
        detail: true,
        reversesEntryId: true,
        replacedByEntryId: true,
        reversalReason: true,
      },
    })
    const enriched = await this.enrichLedgerEntries(rawEntries)
    const replacementIds = [...new Set(enriched.map((e) => e.replacedByEntryId).filter((id): id is string => Boolean(id)))]
    const replacements = replacementIds.length > 0
      ? await this.db.pointsLedgerEntry.findMany({
          where: { id: { in: replacementIds } },
          select: { id: true, amount: true, scoreMonth: true, recordedAt: true },
        })
      : []
    const replacementMap = new Map(replacements.map((r) => [r.id, r]))
    const byId = new Map(
      enriched.map((entry) => {
        const rep = entry.replacedByEntryId ? replacementMap.get(entry.replacedByEntryId) : undefined
        return [
          entry.id,
          {
            id: entry.id,
            sourceKey: entry.sourceKey,
            category: entry.category,
            amount: entry.amount.toString(),
            scoreMonth: entry.scoreMonth,
            recordedAt: entry.recordedAt.toISOString(),
            status: entry.status,
            reversesEntryId: entry.reversesEntryId,
            replacedByEntryId: entry.replacedByEntryId,
            replacementAmount: rep ? rep.amount.toString() : null,
            reversalReason: entry.reversalReason,
            eventName: entry.eventName,
            eventTime: entry.eventTime,
            eventKind: entry.eventKind,
          },
        ]
      }),
    )
    return appeals.map((appeal) => ({
      ...appeal,
      ledgerEntry: appeal.ledgerEntryId ? byId.get(appeal.ledgerEntryId) ?? null : null,
    }))
  }

  /** 申诉（必须关联本人对应的积分流水记录） */
  async submitAppeal(
    userId: string,
    input: { disclosureId?: string; ledgerEntryId: string; subject: string; materials?: string },
  ): Promise<{ appealId: string }> {
    const entry = await this.db.pointsLedgerEntry.findFirst({
      where: { id: input.ledgerEntryId, userId },
      select: { id: true },
    })
    if (!entry) {
      throw new ScoringError('所选积分流水不存在或不属于当前账号', 'NOT_FOUND')
    }
    const existingOpen = await this.db.appeal.findFirst({
      where: {
        userId,
        ledgerEntryId: input.ledgerEntryId,
        status: { in: ['submitted', 'in_review'] },
      },
      select: { id: true },
    })
    if (existingOpen) {
      throw new ScoringError('该笔积分流水已有进行中的申诉，请等待负责人处理后再操作', 'CONFLICT')
    }
    const id = newId()
    await this.db.appeal.create({
      data: {
        id,
        userId,
        disclosureId: input.disclosureId,
        ledgerEntryId: input.ledgerEntryId,
        subject: input.subject,
        materials: input.materials,
      },
    })
    return { appealId: id }
  }

  /** 本人提交的申诉列表（含关联积分流水摘要与受理/结案回复） */
  async myAppeals(userId: string) {
    const rows = await this.db.appeal.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true,
        ledgerEntryId: true,
        subject: true,
        materials: true,
        status: true,
        resolutionNote: true,
        createdAt: true,
        closedAt: true,
      },
    })
    const enriched = await this.attachLedgerToAppeals(rows)
    return enriched.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
    }))
  }

  /** 管理端处理申诉：受理中 / 采纳结案（可选同步冲正/替换/补录积分）/ 驳回结案（保留审计与通知） */
  async decideAppeal(
    actor: SessionActor,
    appealId: string,
    decision: 'in_review' | 'resolved' | 'rejected',
    resolutionNote: string,
    adjustment?: {
      ledgerAction?: 'none' | 'reverse' | 'replace' | 'supplement'
      replacementAmount?: string
      adjustmentAmount?: string
      scoreMonth?: string
    },
  ): Promise<{
    appealId: string
    status: string
    ledgerAction?: string
    reversalId?: string
    replacementId?: string | null
    supplementEntryId?: string
  }> {
    const appeal = await this.db.appeal.findUnique({
      where: { id: appealId },
      include: { user: { select: { verifiedRealName: true, studentNo: true } } },
    })
    if (!appeal) throw new ScoringError('申诉不存在', 'NOT_FOUND')
    if (appeal.status === 'resolved' || appeal.status === 'rejected') {
      throw new ScoringError('该申诉已结案，请勿重复处理', 'STATE_INVALID')
    }

    const ledgerAction = adjustment?.ledgerAction ?? 'none'
    if (ledgerAction !== 'none' && decision !== 'resolved') {
      throw new ScoringError('仅「采纳并结案」时可执行积分账本调整', 'INVALID_INPUT')
    }

    const closing = decision === 'resolved' || decision === 'rejected'
    const trimmedNote = resolutionNote.trim()
    let reversalId: string | undefined
    let replacementId: string | null | undefined
    let supplementEntryId: string | undefined
    let ledgerSummary = ''

    if (ledgerAction === 'reverse' || ledgerAction === 'replace') {
      if (!appeal.ledgerEntryId) {
        throw new ScoringError('该申诉未关联积分流水，无法直接冲正或替换', 'INVALID_INPUT')
      }
      const replacementAmount = ledgerAction === 'replace' ? adjustment?.replacementAmount?.trim() ?? null : null
      if (ledgerAction === 'replace' && (!replacementAmount || !/^-?\d+(\.\d+)?$/.test(replacementAmount))) {
        throw new ScoringError('请填写合法的替换分值（十进制数字）', 'INVALID_INPUT')
      }
      const reverseReason = `申诉采纳处理：${trimmedNote}`.slice(0, 500)
      const outcome = await this.db.$transaction(async (tx) => {
        const rev = await this.reverseEntryTx(tx, actor, appeal.ledgerEntryId!, reverseReason, replacementAmount)
        await tx.appeal.update({
          where: { id: appealId },
          data: {
            status: decision,
            resolutionNote: trimmedNote || null,
            closedAt: new Date(),
          },
        })
        return rev
      })
      reversalId = outcome.reversalId
      replacementId = outcome.replacementId
      ledgerSummary =
        ledgerAction === 'replace'
          ? `（已冲正原流水并替换为 ${Number(replacementAmount) > 0 ? `+${replacementAmount}` : replacementAmount} 分）`
          : '（已冲正撤销原流水）'
    } else if (ledgerAction === 'supplement') {
      const adjAmount = adjustment?.adjustmentAmount?.trim() ?? ''
      if (!/^-?\d+(\.\d+)?$/.test(adjAmount) || Number(adjAmount) === 0) {
        throw new ScoringError('请填写非零的补录/扣减分值', 'INVALID_INPUT')
      }
      const rule = await this.currentRuleVersion()
      supplementEntryId = newId()
      const created = await this.db.$transaction(async (tx) => {
        const original = appeal.ledgerEntryId
          ? await tx.pointsLedgerEntry.findUnique({ where: { id: appeal.ledgerEntryId } })
          : null
        const targetMonth = adjustment?.scoreMonth && /^\d{4}-\d{2}$/.test(adjustment.scoreMonth)
          ? adjustment.scoreMonth
          : original?.scoreMonth ?? monthKey(new Date())
        const category = original && original.category !== 'reversal' ? original.category : 'activity'
        const inheritedDetail: Record<string, unknown> = {
          appealId,
          relatedEntryId: appeal.ledgerEntryId ?? null,
          note: `申诉补录调账：${trimmedNote}`,
        }
        if (original?.detail && typeof original.detail === 'object' && !Array.isArray(original.detail)) {
          const origDetail = original.detail as Record<string, unknown>
          for (const key of ['activityId', 'activityTitle', 'eventId', 'eventTitle', 'claimId', 'title']) {
            if (origDetail[key] != null) inheritedDetail[key] = origDetail[key]
          }
        }
        await tx.pointsLedgerEntry.create({
          data: {
            id: supplementEntryId!,
            userId: appeal.userId,
            sourceKey: `appeal:${appealId}`,
            category,
            amount: adjAmount,
            scoreMonth: targetMonth,
            recordedAt: new Date(),
            status: 'approved',
            ruleVersionId: rule.id === 'default' ? undefined : rule.id,
            detail: inheritedDetail as never,
            evidenceRef: `appeal:${appealId}`,
            approvedBy: actor.principalId,
            idempotencyKey: `appeal:${appealId}`,
          },
        })
        await tx.appeal.update({
          where: { id: appealId },
          data: {
            status: decision,
            resolutionNote: trimmedNote || null,
            closedAt: new Date(),
          },
        })
        return { targetMonth }
      })
      const signed = Number(adjAmount) > 0 ? `+${adjAmount}` : adjAmount
      ledgerSummary = `（已另行记入 ${signed} 分至 ${created.targetMonth}）`
    } else {
      await this.db.appeal.update({
        where: { id: appealId },
        data: {
          status: decision,
          resolutionNote: trimmedNote || null,
          closedAt: closing ? new Date() : null,
        },
      })
    }

    const label = decision === 'in_review' ? '标记受理中' : decision === 'resolved' ? '采纳并结案' : '驳回申诉'
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: `appeal.${decision}`,
      resourceType: 'appeal',
      resourceId: appealId,
      summary: `${label}：${appeal.user.verifiedRealName}（${appeal.subject.slice(0, 80)}）${ledgerSummary}${trimmedNote ? `；回复：${trimmedNote.slice(0, 200)}` : ''}`,
    })
    await this.notifications?.notify({
      userId: appeal.userId,
      kind: 'appeal_decision',
      title: `积分申诉${label}`,
      body: trimmedNote
        ? `事项「${appeal.subject.slice(0, 60)}」处理回复：${trimmedNote}${ledgerSummary}`
        : `事项「${appeal.subject.slice(0, 60)}」已更新状态为：${label}。`,
      link: '/app?section=points',
    })
    if (ledgerAction === 'none') {
      return { appealId, status: decision }
    }
    return {
      appealId,
      status: decision,
      ledgerAction,
      ...(reversalId ? { reversalId } : {}),
      ...(replacementId !== undefined ? { replacementId } : {}),
      ...(supplementEntryId ? { supplementEntryId } : {}),
    }
  }

  /** 贡献/成果申报 */
  async submitClaim(userId: string, input: { category: string; title: string; description: string; activityId?: string; contestKey?: string; evidenceNote?: string; evidenceAssetIds?: string[] }): Promise<{ claimId: string }> {
    const assetIds = input.evidenceAssetIds ?? []
    if (new Set(assetIds).size !== assetIds.length) {
      throw new ScoringError('佐证图重复', 'INVALID_INPUT')
    }
    if (assetIds.length > 0) {
      // 仅接受本人上传、处理完成且尚未被其它申报占用的佐证图
      const usable = await this.db.mediaAsset.count({
        where: {
          id: { in: assetIds },
          ownerUserId: userId,
          purpose: 'evidence',
          status: 'ready',
          claimLink: { is: null },
        },
      })
      if (usable !== assetIds.length) {
        throw new ScoringError('佐证图无效或已被其它申报引用，请重新上传', 'INVALID_INPUT')
      }
    }
    const id = newId()
    await this.db.pointsClaim.create({
      data: {
        id, userId,
        category: input.category,
        title: input.title,
        description: input.description,
        activityId: input.activityId,
        contestKey: input.contestKey,
        evidenceNote: input.evidenceNote,
        scoreMonth: monthKey(new Date()),
        assets: {
          create: assetIds.map((assetId, index) => ({ id: newId(), assetId, sortOrder: index })),
        },
      },
    })
    return { claimId: id }
  }

  /**
   * 贡献申报审核：只允许从待审核 / 待补充 / 被驳回进入新状态。
   * 通过并填分值时入账；重复点击或已被他人处理会返回 decided=false，不重复入账。
   */
  async decideClaim(
    actor: SessionActor,
    claimId: string,
    decision: 'approve' | 'reject' | 'more_info',
    note: string | undefined,
    amount: string | undefined,
  ): Promise<{ decided: boolean; reason?: string }> {
    const claim = await this.db.pointsClaim.findUnique({ where: { id: claimId } })
    if (!claim) return { decided: false, reason: '申报不存在' }
    if (claim.status === 'approved') {
      return { decided: false, reason: '该申报已通过；如需修改请先在「已处理」里撤回审核' }
    }
    const reviewedAt = new Date()
    const updated = await this.db.pointsClaim.updateMany({
      where: { id: claimId, status: { in: ['pending', 'more_info', 'rejected'] } },
      data: {
        status: decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'more_info',
        reviewNote: note ?? null,
        reviewedBy: actor.principalId,
        reviewedAt,
      },
    })
    if (updated.count !== 1) {
      return { decided: false, reason: '申报已被其他管理员处理，请刷新后再试' }
    }
    if (decision === 'approve' && amount) {
      try {
        await this.postLedgerEntry(actor, {
          userId: claim.userId,
          sourceKey: `contribution:${claim.userId}:${claim.id}`,
          category: claim.category === 'award' ? 'award' : 'contribution',
          amount,
          scoreMonth: claim.scoreMonth,
          detail: { claimId: claim.id, title: claim.title },
          evidenceRef: `claim:${claim.id}`,
          // 撤回后再次通过要生成新的幂等键；旧流水已被冲正
          idempotencyKey: `claim:${claim.id}:${newId()}`,
        })
      } catch (error) {
        await this.db.pointsClaim.updateMany({
          where: { id: claimId, status: 'approved', reviewedAt },
          data: { status: 'pending', reviewedBy: null, reviewedAt: null },
        })
        throw error
      }
    }
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'points.claim_decision',
      resourceType: 'points_claim',
      resourceId: claimId,
      summary: `贡献申报「${claim.title}」${decision === 'approve' ? '通过' : decision === 'reject' ? '驳回' : '要求补充材料'}${amount ? `，入账 ${amount}` : ''}`,
    })
    await this.notifications?.notify({
      userId: claim.userId,
      kind: 'claim_decision',
      title: decision === 'approve' ? '贡献申报已通过' : decision === 'reject' ? '贡献申报未通过' : '贡献申报需补充材料',
      body: `「${claim.title}」${decision === 'approve' ? (amount ? `已入账 +${amount} 分` : '已审核通过') : decision === 'reject' ? '已被驳回' : '请补充佐证材料'}${note ? `（意见：${note}）` : ''}。`,
      link: '/app?section=contributions',
    })
    return { decided: true }
  }

  /**
   * 撤回审核：已通过的申报先把对应流水冲正，再把申报退回待审核。
   * 冲正与状态回退在同一事务内；退回后可重新审核，重新通过会生成新的入账记录。
   */
  async withdrawClaimDecision(
    actor: SessionActor,
    claimId: string,
    reason: string,
  ): Promise<{ withdrawn: boolean; reversedEntryId: string | null }> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM points_claims WHERE id = ${claimId}::uuid FOR UPDATE`
      const claim = await tx.pointsClaim.findUnique({ where: { id: claimId } })
      if (!claim) throw new ScoringError('申报不存在', 'NOT_FOUND')
      if (claim.status === 'pending') throw new ScoringError('该申报尚未审核，无需撤回', 'STATE_INVALID')
      let reversedEntryId: string | null = null
      if (claim.status === 'approved') {
        const entry = await tx.pointsLedgerEntry.findFirst({
          where: { sourceKey: `contribution:${claim.userId}:${claim.id}`, status: 'approved' },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        })
        if (entry) {
          await this.reverseEntryTx(tx, actor, entry.id, `撤回审核：${reason}`, null)
          reversedEntryId = entry.id
        }
      }
      await tx.pointsClaim.update({
        where: { id: claimId },
        data: { status: 'pending', reviewedBy: null, reviewedAt: null, reviewNote: null },
      })
      await tx.auditLog.create({
        data: {
          id: newId(),
          actorPrincipalId: actor.principalId,
          action: 'points.claim_withdraw',
          resourceType: 'points_claim',
          resourceId: claimId,
          summary: `撤回贡献申报「${claim.title}」的审核结果${reversedEntryId ? '，并冲正已入账流水' : ''}（${reason}）`,
          reason,
        },
      })
      return { withdrawn: true, reversedEntryId }
    })
  }

  /** 审核复核案件：单人裁决即结案（通过 / 驳回），more_info 只记录意见不结案 */
  async voteOnCase(actor: SessionActor, caseId: string, verdict: 'approve' | 'reject' | 'more_info', reason: string): Promise<{ resolved: boolean; approvals: number }> {
    const reviewCase = await this.db.reviewCase.findUnique({ where: { id: caseId } })
    if (!reviewCase) throw new ScoringError('案件不存在', 'NOT_FOUND')
    await this.db.reviewVote.create({
      data: { id: newId(), caseId, reviewerId: actor.principalId, verdict, reason },
    })
    if (verdict === 'more_info') return { resolved: false, approvals: 0 }
    await this.db.reviewCase.update({
      where: { id: caseId },
      data: { status: verdict === 'approve' ? 'resolved' : 'rejected', closedAt: new Date() },
    })
    return { resolved: true, approvals: verdict === 'approve' ? 1 : 0 }
  }

  /** sourceKey 组装便捷方法（供 worker/审核使用） */
  sourceKey(parts: SourceKeyParts): string {
    return buildSourceKey(parts)
  }

  monthNow(): string {
    return monthKey(new Date())
  }

  monthPlus(delta: number): string {
    return monthKeyPlus(monthKey(new Date()), delta)
  }
}

/** 存库规则参数与当前默认值浅合并后经 zod 校验（补齐 R01–R13 拍板新增字段） */

