import { Inject, Injectable, Optional } from '@nestjs/common'
import type { Prisma } from '@acm/db'
import { z } from 'zod'
import {
  Decimal,
  formalContestScore,
  networkQualifierScore,
  ladderScore,
  lanqiaoScore,
  baiduStarScore,
  type ContestTier,
  type MedalLevel,
  type LadderTeamAward,
  type LadderIndividualAward,
  type LanqiaoAward,
} from '@acm/scoring-core'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { ScoringService, ScoringError } from './scoring.service.js'
import { newId, memberName } from '../../common/utils.js'
import type { SessionActor } from '../auth/session.service.js'

/**
 * 竞赛正式赛报名名单与人员成绩导入（积分审核页面）：
 * - 支持学号或姓名导入（二选一，或同时填写互相核对）；
 * - 姓名重复（或仅匹配展示名）时在预览阶段列出全部候选成员，由管理员手动选择后提交；
 * - 提交后自动创建（或幂等复用）已归档正式赛事 CompetitionEvent、写入个人报名或团队报名名单与成绩，
 *   并按成员归档积分流水 PointsLedgerEntry，同时推送个人通知实现全站账号联动。
 */

export const COMPETITION_IMPORT_TIERS = [
  'school_select',
  'provincial',
  'icpc_invite',
  'icpc_regional',
  'top_final',
  'network_qualifier',
  'ladder',
  'lanqiao',
  'baidu_star',
] as const

export type CompetitionImportTier = (typeof COMPETITION_IMPORT_TIERS)[number]

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '比赛日期格式应为 YYYY-MM-DD')
const monthSchema = z.string().regex(/^\d{4}-\d{2}$/, '计分月份格式应为 YYYY-MM')
const pointsSchema = z.string().regex(/^-?\d+(\.\d+)?$/, '积分需为十进制数字')

const competitionMetaSchema = z.object({
  title: z.string().trim().min(2, '比赛名称至少 2 个字').max(160, '比赛名称不超过 160 字'),
  competitionDate: dateSchema,
  category: z.enum(['A', 'B']).default('B'),
  teamSize: z.number().int().min(2).max(10).nullable().optional(),
  contestTier: z.enum(COMPETITION_IMPORT_TIERS).nullable().optional(),
  scoreMonth: monthSchema.optional(),
  ledgerCategory: z.enum(['award', 'contest']).default('award'),
  announcement: z.string().trim().max(20000).optional(),
})

const importRowInputSchema = z.object({
  row: z.number().int().min(1),
  studentNo: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(64).optional(),
  selectedUserId: z.string().uuid().optional(),
  teamName: z.string().trim().min(1).max(80).optional(),
  awardText: z.string().trim().max(120).optional(),
  rankText: z.string().trim().max(64).optional(),
  points: pointsSchema.optional(),
  note: z.string().trim().max(300).optional(),
})

export const competitionImportPreviewSchema = z.object({
  event: competitionMetaSchema,
  rows: z.array(importRowInputSchema).min(1, '请至少提供 1 行名单数据').max(2000),
})
export type CompetitionImportPreviewInput = z.infer<typeof competitionImportPreviewSchema>

export const competitionImportCommitSchema = z.object({
  event: competitionMetaSchema,
  rows: z.array(importRowInputSchema).min(1, '请至少提供 1 行名单数据').max(2000),
})
export type CompetitionImportCommitInput = z.infer<typeof competitionImportCommitSchema>

export interface CompetitionMemberCandidate {
  userId: string
  studentNo: string
  name: string
  displayName: string | null
  grade: number | null
  membership: string
  matchKind: 'real_name' | 'display_name'
}

export interface CompetitionImportPreviewRow {
  row: number
  studentNo: string
  inputName: string | null
  userId: string | null
  memberName: string | null
  grade: number | null
  membership: string | null
  matchSource: 'selected' | 'studentNo' | 'name' | null
  matchWarning?: string
  needsSelection?: boolean
  candidates?: CompetitionMemberCandidate[]
  teamName?: string
  awardText?: string
  rankText?: string
  points: string
  pointsSource: 'sheet' | 'tier_rule' | 'roster_only'
  pointsHint?: string
  note?: string
  error?: string
}

export interface CompetitionImportRowOutcome {
  row: number
  studentNo: string
  memberName: string | null
  teamName?: string
  points: string
  postedAmount?: string
  status: 'archived' | 'roster_only' | 'duplicate' | 'failed'
  error?: string
}

type MatchedRow = CompetitionImportPreviewRow & { userId: string }

interface ImportContext {
  actor: SessionActor
  event: CompetitionImportCommitInput['event']
  eventId: string
  batchId: string
  scoreMonth: string
}

function outcomeFor(row: CompetitionImportPreviewRow, status: CompetitionImportRowOutcome['status']): CompetitionImportRowOutcome {
  return {
    row: row.row,
    studentNo: row.studentNo || row.inputName || `第 ${row.row} 行`,
    memberName: row.memberName,
    ...(row.teamName ? { teamName: row.teamName } : {}),
    points: row.points,
    status,
  }
}

/** 旧版可能已存获奖成绩，但只记了参赛分。重传旧参赛表或仅登记名单时保留该成绩。 */
function keepRecordedScore(outcome: CompetitionImportRowOutcome, previousPoints: number): boolean {
  return (outcome.status === 'roster_only' && previousPoints !== 0) ||
    (outcome.status === 'duplicate' && previousPoints > Number(outcome.points))
}

interface LoadedMember {
  id: string
  studentNo: string
  verifiedRealName: string
  grade: number | null
  accountStatus: string
  profile: { displayName: string | null } | null
  membershipTerms: Array<{ membershipStatus: string }>
}

export function isNonScoringCompetitor(awardText: string): boolean {
  return /(打星|非正式|随队|不计分|unofficial|star)/i.test(awardText)
}

/** 根据赛事档位 + 奖项文本自动推算附录二标准分；无法识别时返回 null（不猜测） */
export function resolveOfficialAwardPoints(
  contestTier: CompetitionImportTier | null | undefined,
  awardText: string | null | undefined,
): { points: string; hint: string } | null {
  if (!contestTier) return null
  const text = (awardText ?? '').trim()
  if (!text) return null
  const lower = text.toLowerCase()

  if (isNonScoringCompetitor(text)) {
    return { points: '0', hint: '打星/非正式队员不计分（仅记报名名单）' }
  }

  if (
    contestTier === 'school_select' ||
    contestTier === 'provincial' ||
    contestTier === 'icpc_invite' ||
    contestTier === 'icpc_regional' ||
    contestTier === 'top_final'
  ) {
    let medal: MedalLevel | 'none_matched' = 'none_matched'
    if (/(金奖|金牌|一等奖|特等奖|冠军|\bgold\b)/i.test(text)) medal = 'gold'
    else if (/(银奖|银牌|二等奖|亚军|\bsilver\b)/i.test(text)) medal = 'silver'
    else if (/(铜奖|铜牌|三等奖|季军|\bbronze\b)/i.test(text)) medal = 'bronze'
    else if (/(优胜|鼓励|优秀|铁牌|铁奖|\bhonorable\b)/i.test(text)) medal = 'honorable'
    else if (/(参赛|完赛|参与|正式|已参赛|participation)/i.test(text)) medal = null

    if (medal === 'none_matched') return null
    const outcome = formalContestScore({ tier: contestTier as ContestTier, medal, registeredOfficial: true })
    if (outcome.status !== 'ok' || outcome.value == null) return null
    const note = outcome.decisions.map((d) => d.note).join('；')
    return { points: outcome.value.toFixed(2).replace(/\.00$/, ''), hint: note }
  }

  if (contestTier === 'lanqiao') {
    const group: 'A' | 'B' = /(a\s*组|甲组|\bgroup\s*a\b)/i.test(lower) ? 'A' : 'B'
    const awards: LanqiaoAward[] = []
    if (/(国赛?一等|国家一等|全国一等|国一)/i.test(text)) awards.push('nat1')
    if (/(国赛?二等|国家二等|全国二等|国二)/i.test(text)) awards.push('nat2')
    if (/(国赛?三等|国家三等|全国三等|国三)/i.test(text)) awards.push('nat3')
    if (/(国赛?优秀|全国优秀|国优)/i.test(text)) awards.push('nat_excellent')
    if (/(省赛?一等|省级一等|省一)/i.test(text) || (awards.length === 0 && /一等/.test(text))) awards.push('prov1')
    if (/(省赛?二等|省级二等|省二)/i.test(text) || (awards.length === 0 && /二等/.test(text))) awards.push('prov2')
    if (/(省赛?三等|省级三等|省三)/i.test(text) || (awards.length === 0 && /三等/.test(text))) awards.push('prov3')
    if (awards.length === 0) return null
    const value = lanqiaoScore(group, awards)
    return { points: value.toFixed(2).replace(/\.00$/, ''), hint: `蓝桥杯 ${group} 组取最高奖项` }
  }

  if (contestTier === 'ladder') {
    const teamAwards: LadderTeamAward[] = []
    let individual: LadderIndividualAward | null = null
    if (/个人特等/.test(text)) individual = 'special'
    else if (/个人一等/.test(text)) individual = 'first'
    else if (/个人二等/.test(text)) individual = 'second'
    else if (/个人三等/.test(text)) individual = 'third'

    const stripped = text.replace(/个人[特一二三]等奖?/g, '')
    if (/(团体|团队|全国|国家)?特等/.test(stripped)) teamAwards.push('special')
    if (/(国赛?一等|国家一等|全国一等|国一)/.test(stripped)) teamAwards.push('nat1')
    if (/(国赛?二等|国家二等|全国二等|国二)/.test(stripped)) teamAwards.push('nat2')
    if (/(国赛?三等|国家三等|全国三等|国三)/.test(stripped)) teamAwards.push('nat3')
    if (/(省赛?一等|省级一等|省一)/.test(stripped)) teamAwards.push('prov1')
    if (/(省赛?二等|省级二等|省二)/.test(stripped)) teamAwards.push('prov2')
    if (/(省赛?三等|省级三等|省三)/.test(stripped)) teamAwards.push('prov3')

    if (teamAwards.length === 0 && individual == null) return null
    const value = ladderScore(teamAwards, individual)
    return { points: value.toFixed(2).replace(/\.00$/, ''), hint: '天梯赛团体取最高 + 个人国家奖叠加' }
  }

  if (contestTier === 'baidu_star') {
    let preliminary: MedalLevel = null
    let finalMedal: MedalLevel = null
    const preMatch = text.match(/初赛[^\s,，;；/]*?(金|银|铜)/)
    const finMatch = text.match(/决赛[^\s,，;；/]*?(金|银|铜)/)
    const mapMedal = (c?: string): MedalLevel => (c === '金' ? 'gold' : c === '银' ? 'silver' : c === '铜' ? 'bronze' : null)
    preliminary = mapMedal(preMatch?.[1])
    finalMedal = mapMedal(finMatch?.[1])
    if (!preliminary && !finalMedal) return null
    const value = baiduStarScore(preliminary, finalMedal)
    return { points: value.toFixed(2).replace(/\.00$/, ''), hint: '百度之星按初赛/决赛奖项计分' }
  }

  if (contestTier === 'network_qualifier') {
    const advanced = /(出线|晋级|通过预选)/i.test(text)
    const participated = advanced || /(参赛|完赛|参与|有效提交)/i.test(text)
    if (!participated) return null
    const rankAmongAdvanced = /前\s*10%/.test(text)
      ? { rank: 1, total: 10 }
      : /前\s*30%/.test(text)
        ? { rank: 3, total: 10 }
        : null
    const outcome = networkQualifierScore({ participatedWithSubmission: true, advanced, rankAmongAdvanced })
    if (outcome.status !== 'ok' || outcome.value == null) return null
    return {
      points: outcome.value.toFixed(2).replace(/\.00$/, ''),
      hint: outcome.decisions.map((d) => d.note).join('；'),
    }
  }

  return null
}

/** 比赛日期（Asia/Shanghai）→ 报名截止 00:00、开赛 09:00、结束 14:00 */
function competitionSchedule(date: string): { registerDeadline: Date; startAt: Date; endAt: Date } {
  const registerDeadline = new Date(`${date}T00:00:00+08:00`)
  const startAt = new Date(`${date}T09:00:00+08:00`)
  const endAt = new Date(`${date}T14:00:00+08:00`)
  if (Number.isNaN(startAt.getTime())) {
    throw new ScoringError(`比赛日期无效：${date}`, 'INVALID_INPUT')
  }
  return { registerDeadline, startAt, endAt }
}

function toCandidate(user: LoadedMember, matchKind: 'real_name' | 'display_name'): CompetitionMemberCandidate {
  return {
    userId: user.id,
    studentNo: user.studentNo,
    name: user.verifiedRealName,
    displayName: user.profile?.displayName ?? null,
    grade: user.grade,
    membership: user.membershipTerms[0]?.membershipStatus ?? 'applicant',
    matchKind,
  }
}

function summarizeResultNote(row: { teamName?: string; awardText?: string; rankText?: string; note?: string }, includeTeam: boolean): string | null {
  const parts: string[] = []
  if (includeTeam && row.teamName) parts.push(`队伍：${row.teamName}`)
  if (row.awardText) parts.push(row.awardText)
  if (row.rankText) parts.push(`排名 ${row.rankText}`)
  if (row.note) parts.push(row.note)
  return parts.length > 0 ? parts.join(' · ').slice(0, 500) : null
}

const DEFAULT_ARCHIVE_ANNOUNCEMENT = '由积分审核页面「正式赛名单与成绩导入」自动创建并归档，用于记录正式参赛名单、成绩与归档积分。'

@Injectable()
export class CompetitionImportService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ScoringService) private readonly scoring: ScoringService,
    @Optional() @Inject(NotificationsService) private readonly notifications?: NotificationsService,
  ) {}

  private async loadMembers(rows: Array<{ studentNo?: string; name?: string; selectedUserId?: string }>) {
    const ids = [...new Set(rows.map((r) => r.selectedUserId).filter((v): v is string => Boolean(v)))]
    const studentNos = [...new Set(rows.map((r) => r.studentNo?.trim()).filter((v): v is string => Boolean(v)))]
    const names = [...new Set(rows.map((r) => r.name?.trim()).filter((v): v is string => Boolean(v)))]

    const orClauses = [
      ...(ids.length > 0 ? [{ id: { in: ids } }] : []),
      ...(studentNos.length > 0 ? [{ studentNo: { in: studentNos } }] : []),
      ...(names.length > 0 ? [{ verifiedRealName: { in: names } }] : []),
      ...(names.length > 0 ? [{ profile: { displayName: { in: names } } }] : []),
    ]

    const users: LoadedMember[] = orClauses.length === 0
      ? []
      : await this.db.user.findMany({
          where: { OR: orClauses },
          select: {
            id: true,
            studentNo: true,
            verifiedRealName: true,
            grade: true,
            accountStatus: true,
            profile: { select: { displayName: true } },
            membershipTerms: { orderBy: { createdAt: 'desc' }, take: 1, select: { membershipStatus: true } },
          },
        })

    const byId = new Map(users.map((u) => [u.id, u]))
    const byStudentNo = new Map(users.map((u) => [u.studentNo, u]))
    const byRealName = new Map<string, LoadedMember[]>()
    const byDisplayName = new Map<string, LoadedMember[]>()
    for (const u of users) {
      const list = byRealName.get(u.verifiedRealName) ?? []
      list.push(u)
      byRealName.set(u.verifiedRealName, list)
      const disp = u.profile?.displayName?.trim()
      if (disp) {
        const key = disp.toLowerCase()
        const dList = byDisplayName.get(key) ?? []
        dList.push(u)
        byDisplayName.set(key, dList)
      }
    }
    return { byId, byStudentNo, byRealName, byDisplayName }
  }

  private resolveRow(
    row: CompetitionImportPreviewInput['rows'][number],
    event: CompetitionImportPreviewInput['event'],
    members: Awaited<ReturnType<CompetitionImportService['loadMembers']>>,
  ): CompetitionImportPreviewRow {
    const studentNo = row.studentNo?.trim()
    const name = row.name?.trim()

    let matched: LoadedMember | null = null
    let matchSource: CompetitionImportPreviewRow['matchSource'] = null
    let matchWarning: string | undefined
    let needsSelection = false
    let candidates: CompetitionMemberCandidate[] | undefined
    let memberError: string | undefined

    if (row.selectedUserId) {
      const user = members.byId.get(row.selectedUserId)
      if (user) {
        matched = user
        matchSource = 'selected'
      } else {
        memberError = '所选成员账号不存在，请重新选择'
      }
    } else if (studentNo) {
      const user = members.byStudentNo.get(studentNo)
      if (user) {
        if (name && user.verifiedRealName !== name) {
          memberError = `学号 ${studentNo} 与姓名「${name}」不一致（该学号实名为「${user.verifiedRealName}」）`
        } else {
          matched = user
          matchSource = 'studentNo'
        }
      } else if (!name) {
        memberError = `学号 ${studentNo} 未注册，请核对学号或先在成员管理导入`
      }
    }

    if (!matched && !memberError && name) {
      const realMatches = members.byRealName.get(name) ?? []
      if (realMatches.length === 1) {
        matched = realMatches[0]!
        matchSource = 'name'
        if (studentNo) {
          matchWarning = `学号 ${studentNo} 未注册，已按姓名匹配到 ${matched.studentNo}`
        }
      } else if (realMatches.length > 1) {
        needsSelection = true
        candidates = realMatches.map((u) => toCandidate(u, 'real_name'))
        memberError = `姓名「${name}」对应 ${realMatches.length} 位成员，请手动选择具体账号`
      } else {
        const dispMatches = members.byDisplayName.get(name.toLowerCase()) ?? []
        if (dispMatches.length > 0) {
          needsSelection = true
          candidates = dispMatches.map((u) => toCandidate(u, 'display_name'))
          memberError = `未找到实名为「${name}」的成员，匹配到 ${dispMatches.length} 位同展示名账号，请手动确认`
        } else {
          memberError = studentNo
            ? `学号 ${studentNo} 未注册，且未找到姓名「${name}」的成员`
            : `未找到姓名「${name}」的成员（可核对姓名或改填学号）`
        }
      }
    }

    if (!matched && !memberError && !studentNo && !name) {
      memberError = '学号与姓名至少填写一项'
    }

    // 积分判定：表格手填优先 → 按赛事档位 + 奖项自动推算 → 仅登记名单（0 分）
    let points = '0'
    let pointsSource: CompetitionImportPreviewRow['pointsSource'] = 'roster_only'
    let pointsHint: string | undefined
    if (row.points != null && row.points.trim() !== '') {
      points = row.points.trim().replace(/^\+/, '')
      pointsSource = 'sheet'
    } else {
      const auto = resolveOfficialAwardPoints(event.contestTier, row.awardText)
      if (auto) {
        points = auto.points
        pointsSource = 'tier_rule'
        pointsHint = auto.hint
      } else {
        points = '0'
        pointsSource = 'roster_only'
        pointsHint = '未填积分，仅登记报名名单与成绩'
      }
    }

    let error = memberError
    if (!error && event.teamSize != null && !row.teamName?.trim()) {
      error = '团队赛每行必须填写「队名」'
    }

    return {
      row: row.row,
      studentNo: matched?.studentNo ?? studentNo ?? '',
      inputName: name ?? null,
      userId: matched?.id ?? null,
      memberName: matched ? memberName(matched) : null,
      grade: matched?.grade ?? null,
      membership: matched?.membershipTerms[0]?.membershipStatus ?? null,
      matchSource,
      ...(matchWarning ? { matchWarning } : {}),
      ...(needsSelection ? { needsSelection, candidates } : {}),
      ...(row.teamName ? { teamName: row.teamName.trim() } : {}),
      ...(row.awardText ? { awardText: row.awardText.trim() } : {}),
      ...(row.rankText ? { rankText: row.rankText.trim() } : {}),
      points,
      pointsSource,
      ...(pointsHint ? { pointsHint } : {}),
      ...(row.note ? { note: row.note.trim() } : {}),
      ...(error ? { error } : {}),
    }
  }

  /** 预览：解析学号/姓名、识别同名候选、自动推算档位分值、校验重复成员 */
  async preview(input: CompetitionImportPreviewInput) {
    const schedule = competitionSchedule(input.event.competitionDate)
    const [members, existingEvent] = await Promise.all([
      this.loadMembers(input.rows),
      this.findArchivedEvent(this.db, input.event.title, schedule.registerDeadline),
    ])

    const resolved = input.rows.map((row) => this.resolveRow(row, input.event, members))

    // 检查同一场次内成员重复
    const seenUsers = new Map<string, number>()
    for (const row of resolved) {
      if (!row.userId || row.error) continue
      const firstRow = seenUsers.get(row.userId)
      if (firstRow != null) {
        row.error = `成员「${row.memberName ?? row.studentNo}」在第 ${firstRow} 行已出现，同一比赛内不能重复导入`
      } else {
        seenUsers.set(row.userId, row.row)
      }
    }

    const expectedTeamSize = input.event.teamSize ?? null
    const existingMismatch =
      existingEvent && (existingEvent.teamSize ?? null) !== expectedTeamSize
        ? `已存在同名同日归档比赛「${existingEvent.title}」，但其参赛形式（${existingEvent.teamSize ? `${existingEvent.teamSize} 人团队赛` : '个人赛'}）与当前设置不一致`
        : null

    const readyRows = resolved.filter((r) => !r.error && r.userId != null)
    const duplicateNameCount = resolved.filter((r) => r.needsSelection).length
    const errorCount = resolved.filter((r) => Boolean(r.error)).length
    const totalPoints = Math.round(readyRows.reduce((sum, r) => sum + Number(r.points || 0), 0) * 100) / 100
    const teamCount = expectedTeamSize != null
      ? new Set(readyRows.map((r) => r.teamName).filter((v): v is string => Boolean(v))).size
      : 0

    return {
      existingEvent: existingEvent ? { id: existingEvent.id, title: existingEvent.title, status: existingEvent.status } : null,
      existingMismatch,
      scoreMonth: input.event.scoreMonth ?? input.event.competitionDate.slice(0, 7),
      rows: resolved,
      summary: {
        total: resolved.length,
        ready: readyRows.length,
        duplicateNameCount,
        errorCount,
        totalPoints,
        teamCount,
      },
    }
  }

  /**
   * 正式导入提交：
   * 1. 自动创建（或复用同名同日）已归档正式赛事 CompetitionEvent；
   * 2. 写入报名名单与成绩（个人赛 CompetitionRegistration / 团队赛 Team + TeamCompetitionEntry）；
   * 3. 在同一事务中按该成员本场已入账的分数补差；
   * 4. 向关联成员发送站内通知并写审计日志。
   */
  async commit(actor: SessionActor, input: CompetitionImportCommitInput): Promise<{
    batchId: string
    event: { id: string; title: string; created: boolean; status: string; teamSize: number | null; scoreMonth: string }
    registeredCount: number
    teamsCreated: number
    posted: number
    duplicate: number
    rosterOnly: number
    failed: number
    rows: CompetitionImportRowOutcome[]
  }> {
    const schedule = competitionSchedule(input.event.competitionDate)
    const scoreMonth = input.event.scoreMonth ?? input.event.competitionDate.slice(0, 7)
    const teamSize = input.event.teamSize ?? null
    const members = await this.loadMembers(input.rows)
    const resolved = input.rows.map((row) => this.resolveRow(row, input.event, members))

    // 同一比赛内成员去重校验
    const seenUsers = new Map<string, number>()
    for (const row of resolved) {
      if (!row.userId || row.error) continue
      const firstRow = seenUsers.get(row.userId)
      if (firstRow != null) {
        row.error = `成员「${row.memberName ?? row.studentNo}」在第 ${firstRow} 行已出现，同一比赛内不能重复导入`
      } else {
        seenUsers.set(row.userId, row.row)
      }
    }

    const unresolvedDuplicates = resolved.filter((r) => r.needsSelection)
    if (unresolvedDuplicates.length > 0) {
      throw new ScoringError(`还有 ${unresolvedDuplicates.length} 行姓名重复未手动选择对应成员，请先选择后再导入`, 'AMBIGUOUS_MEMBERS')
    }

    const validRows = resolved.filter((r): r is MatchedRow => !r.error && r.userId != null)
    if (validRows.length === 0) {
      throw new ScoringError('没有可导入的有效名单记录，请检查错误提示', 'NO_VALID_ROWS')
    }

    const batchId = newId()
    const { eventId, eventCreated } = await this.db.$transaction(async (tx) => {
      // 尚未建档时没有可锁的赛事行，按导入匹配键串行化查询与创建。
      const eventKey = `competition-import:event:${input.event.competitionDate}:${input.event.title}`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${eventKey}, 0))`
      const existing = await this.findArchivedEvent(tx, input.event.title, schedule.registerDeadline)
      if (existing) {
        if ((existing.teamSize ?? null) !== teamSize) {
          throw new ScoringError(
            `已存在同名同日的归档赛事「${existing.title}」，但其参赛形式与本次不一致，请修改比赛名称或保持一致`,
            'CONFLICT',
          )
        }
        return { eventId: existing.id, eventCreated: false }
      }
      const eventId = newId()
      await tx.competitionEvent.create({
        data: {
          id: eventId,
          title: input.event.title,
          category: input.event.category,
          teamSize,
          scoringMode: 'manual_review',
          contestTier: input.event.contestTier ?? null,
          announcement: input.event.announcement?.trim() || DEFAULT_ARCHIVE_ANNOUNCEMENT,
          ...schedule,
          status: 'archived',
          createdBy: actor.principalId,
        },
      })
      await this.audit.log({
        actorPrincipalId: actor.principalId,
        action: 'competition_event.import_archive',
        resourceType: 'competition_event',
        resourceId: eventId,
        summary: `正式赛名单成绩导入自动创建并归档赛事：${input.event.title}（${input.event.category} 类${teamSize ? `，${teamSize} 人团队赛` : '，个人赛'}）`,
      }, tx)
      return { eventId, eventCreated: true }
    })

    const ctx = { actor, event: input.event, eventId, batchId, scoreMonth }
    const outcomes: CompetitionImportRowOutcome[] = resolved
      .filter((row) => row.error || !row.userId)
      .map((row) => ({ ...outcomeFor(row, 'failed'), error: row.error ?? '成员无效' }))
    const groups = new Map<string, MatchedRow[]>()
    for (const row of validRows) {
      const key = teamSize == null ? row.userId : row.teamName!
      const group = groups.get(key) ?? []
      group.push(row)
      groups.set(key, group)
    }

    let teamsCreated = 0
    for (const [key, rows] of groups) {
      let group: { created: boolean; outcomes: CompetitionImportRowOutcome[] }
      try {
        group = await this.db.$transaction(async (tx) => {
          // 成绩与差额流水一起提交。同场并发导入在锁内读取最新成绩和账本。
          await tx.$executeRaw`SELECT id FROM competition_events WHERE id = ${eventId}::uuid FOR UPDATE`
          return teamSize == null
            ? this.importIndividual(tx, ctx, rows[0]!)
            : this.importTeam(tx, ctx, key, teamSize, rows)
        }, { timeout: 30_000 })
      } catch (error) {
        const message = error instanceof Error ? error.message : '成绩与积分入账失败'
        outcomes.push(...rows.map((row) => ({ ...outcomeFor(row, 'failed'), error: message })))
        continue
      }

      if (teamSize != null && group.created) teamsCreated++
      outcomes.push(...group.outcomes)
      for (const [index, result] of group.outcomes.entries()) {
        const row = rows[index]!
        if (result.postedAmount != null) {
          await this.scoring.notifyPostedPoints({
            userId: row.userId,
            amount: result.postedAmount,
            scoreMonth,
            detail: { eventTitle: input.event.title },
          })
        }
        if (result.status === 'archived' || (result.status === 'roster_only' && group.created)) {
          await this.notifyMember(row.userId, input.event.title, scoreMonth, row.awardText, result.postedAmount ?? null, row.teamName)
        }
      }
    }

    outcomes.sort((a, b) => a.row - b.row)
    const posted = outcomes.filter((o) => o.status === 'archived').length
    const rosterOnly = outcomes.filter((o) => o.status === 'roster_only').length
    const duplicate = outcomes.filter((o) => o.status === 'duplicate').length
    const failed = outcomes.filter((o) => o.status === 'failed').length
    const registeredCount = posted + rosterOnly + duplicate
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'points.competition_import',
      resourceType: 'competition_event',
      resourceId: eventId,
      summary: `正式赛「${input.event.title}」名单成绩导入：登记 ${registeredCount} 人${teamsCreated > 0 ? `（新建 ${teamsCreated} 队）` : ''}，归档积分 ${posted} 条、仅登记名单 ${rosterOnly} 条、重复跳过 ${duplicate} 条、失败 ${failed} 条`,
    })

    return {
      batchId,
      event: {
        id: eventId,
        title: input.event.title,
        created: eventCreated,
        status: 'archived',
        teamSize,
        scoreMonth,
      },
      registeredCount,
      teamsCreated,
      posted,
      duplicate,
      rosterOnly,
      failed,
      rows: outcomes,
    }
  }

  // 导入表只提供比赛日期。手工创建的赛事可能在当天任意时刻开赛。
  private async findArchivedEvent(db: Prisma.TransactionClient, title: string, dayStart: Date) {
    const nextDay = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)
    const events = await db.competitionEvent.findMany({
      where: { title, status: 'archived', startAt: { gte: dayStart, lt: nextDay } },
      select: { id: true, title: true, status: true, teamSize: true },
      take: 2,
    })
    if (events.length > 1) throw new ScoringError(`同一天有多场名为「${title}」的归档赛事，无法确定积分归属`, 'CONFLICT')
    return events[0] ?? null
  }

  private async postRow(
    tx: Prisma.TransactionClient, ctx: ImportContext, row: MatchedRow, entryId: string, teamId?: string,
  ): Promise<CompetitionImportRowOutcome> {
    const amount = new Decimal(row.points).toFixed(2)
    if (Number(amount) === 0) return { ...outcomeFor(row, 'roster_only'), points: '0' }
    const { postedAmount, error } = await this.scoring.postCompetitionResultPoints(tx, ctx.actor, {
      userId: row.userId,
      sourceKey: teamId
        ? `team-competition:${ctx.eventId}:${teamId}:${row.userId}`
        : `competition:${ctx.eventId}:${row.userId}`,
      category: ctx.event.ledgerCategory,
      scoreMonth: ctx.scoreMonth,
      amount,
      detail: {
        eventId: ctx.eventId,
        eventTitle: ctx.event.title,
        competitionDate: ctx.event.competitionDate,
        contestTier: ctx.event.contestTier ?? null,
        teamName: row.teamName ?? null,
        ...(teamId ? { teamId } : {}),
        awardText: row.awardText ?? null,
        rankText: row.rankText ?? null,
        note: row.note ?? null,
        source: 'competition_import',
        importBatchId: ctx.batchId,
      },
      evidenceRef: teamId ? `team_competition_entry:${entryId}` : `competition_registration:${entryId}`,
    })
    if (error) return { ...outcomeFor(row, 'failed'), error }
    if (postedAmount == null) return { ...outcomeFor(row, 'duplicate'), points: amount, error: '本场积分已足额入账' }
    return { ...outcomeFor(row, 'archived'), points: amount, postedAmount }
  }

  private async importIndividual(tx: Prisma.TransactionClient, ctx: ImportContext, row: MatchedRow) {
    const where = { eventId_userId: { eventId: ctx.eventId, userId: row.userId } }
    const existing = await tx.competitionRegistration.findUnique({ where, select: { id: true, resultScore: true } })
    const id = existing?.id ?? newId()
    const outcome = await this.postRow(tx, ctx, row, id)
    const rosterOnly = outcome.status === 'roster_only'
    if (outcome.status !== 'failed' && !keepRecordedScore(outcome, Number(existing?.resultScore ?? 0))) {
      const now = new Date()
      const result = {
        status: 'approved',
        resultScore: rosterOnly ? null : outcome.points,
        resultDetail: {
          source: 'competition_import',
          importBatchId: ctx.batchId,
          contestTier: ctx.event.contestTier ?? null,
          awardText: row.awardText ?? null,
          rankText: row.rankText ?? null,
          teamName: row.teamName ?? null,
          pointsSource: row.pointsSource,
          note: row.note ?? null,
        },
        reviewNote: summarizeResultNote(row, true),
        note: row.note ?? (row.teamName ? `队伍：${row.teamName}` : null),
        reviewedBy: ctx.actor.principalId,
        reviewedAt: now,
        confirmedAt: now,
      }
      await tx.competitionRegistration.upsert({
        where,
        create: { id, ...where.eventId_userId, ...result },
        update: result,
      })
    }
    return { created: !existing && outcome.status !== 'failed', outcomes: [outcome] }
  }

  private async importTeam(tx: Prisma.TransactionClient, ctx: ImportContext, teamName: string, teamSize: number, rows: MatchedRow[]) {
    const existing = await tx.teamCompetitionEntry.findFirst({
      where: { eventId: ctx.eventId, team: { name: teamName } },
      orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }],
      select: { id: true, teamId: true, resultDetail: true },
    })
    const teamId = existing?.teamId ?? newId()
    const entryId = existing?.id ?? newId()
    const resultsByUser = new Map<string, Prisma.JsonObject>()
    const previous = existing?.resultDetail
    if (previous && typeof previous === 'object' && !Array.isArray(previous) && Array.isArray(previous.memberResults)) {
      for (const member of previous.memberResults) {
        if (member && typeof member === 'object' && !Array.isArray(member) && typeof member.userId === 'string') {
          resultsByUser.set(member.userId, member)
        }
      }
    }
    const outcomes: CompetitionImportRowOutcome[] = []
    const accepted: MatchedRow[] = []
    for (const row of rows) {
      const outcome = await this.postRow(tx, ctx, row, entryId, teamId)
      outcomes.push(outcome)
      if (outcome.status === 'failed') continue
      accepted.push(row)
      if (keepRecordedScore(outcome, Number(resultsByUser.get(row.userId)?.points ?? 0))) continue
      resultsByUser.set(row.userId, {
        userId: row.userId,
        studentNo: row.studentNo,
        points: new Decimal(outcome.points).toFixed(),
        awardText: row.awardText ?? null,
        rankText: row.rankText ?? null,
        note: row.note ?? null,
      })
    }
    if (accepted.length === 0) return { created: false, outcomes }
    if (!existing) {
      await tx.team.create({
        data: {
          id: teamId,
          name: teamName,
          teamSize: Math.max(teamSize, accepted.length),
          captainUserId: accepted[0]!.userId,
          status: 'locked',
          createdBy: ctx.actor.principalId,
        },
      })
    }
    await tx.teamMember.createMany({
      data: accepted.map((row, index) => ({
        id: newId(),
        teamId,
        userId: row.userId,
        role: index === 0 && !existing ? 'captain' : 'member',
        status: 'active',
      })),
      skipDuplicates: true,
    })
    if (existing) {
      await tx.teamMember.updateMany({
        where: { teamId, userId: { in: accepted.map((row) => row.userId) } },
        data: { status: 'active', leftAt: null },
      })
    }

    const memberResults = [...resultsByUser.values()]
    const points = memberResults.map((r) => Number(r.points || 0))
    const uniqueAwards = [...new Set(memberResults.map((r) => r.awardText).filter((v): v is string => typeof v === 'string' && v.length > 0))]
    const uniqueRanks = [...new Set(memberResults.map((r) => r.rankText).filter((v): v is string => typeof v === 'string' && v.length > 0))]
    const result = {
      status: 'approved',
      resultScore: points.some((v) => v !== 0) ? Math.max(0, ...points).toFixed(2) : null,
      resultDetail: {
        source: 'competition_import',
        importBatchId: ctx.batchId,
        contestTier: ctx.event.contestTier ?? null,
        awardText: uniqueAwards[0] ?? null,
        rankText: uniqueRanks[0] ?? null,
        memberResults,
      } as Prisma.InputJsonObject,
      reviewNote: [uniqueAwards.join(' / '), uniqueRanks.length ? `排名 ${uniqueRanks.join(' / ')}` : ''].filter(Boolean).join(' · ') || null,
      reviewedBy: ctx.actor.principalId, reviewedAt: new Date(),
    }
    await tx.teamCompetitionEntry.upsert({
      where: { teamId_eventId: { teamId, eventId: ctx.eventId } },
      create: { id: entryId, teamId, eventId: ctx.eventId, ...result }, update: result,
    })
    return { created: !existing, outcomes }
  }

  private async notifyMember(
    userId: string,
    eventTitle: string,
    scoreMonth: string,
    awardText: string | undefined,
    amount: string | null,
    teamName: string | undefined,
  ) {
    if (!this.notifications) return
    const parts: string[] = []
    if (teamName) parts.push(`队伍「${teamName}」`)
    if (awardText) parts.push(`成绩/奖项：${awardText}`)
    if (amount) {
      const signed = Number(amount) > 0 ? `+${amount}` : amount
      parts.push(`归档积分 ${signed} 分（计入 ${scoreMonth}）`)
    }
    try {
      await this.notifications.notify({
        userId,
        kind: 'general',
        title: `正式赛记录已归档：${eventTitle}`,
        body: parts.length > 0 ? `您已关联至正式赛「${eventTitle}」，${parts.join('，')}。` : `您已登记于正式赛「${eventTitle}」参赛名单。`,
        link: '/app?section=contests&tab=entry',
      })
    } catch {
      // 通知写失败不影响主导入流程
    }
  }
}
