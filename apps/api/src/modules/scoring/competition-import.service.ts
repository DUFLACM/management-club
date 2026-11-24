import { Inject, Injectable, Optional } from '@nestjs/common'
import { z } from 'zod'
import {
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
  status: 'archived' | 'roster_only' | 'duplicate' | 'failed'
  error?: string
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

/** 根据赛事档位 + 奖项文本自动推算附录二标准分；无法识别时返回 null（不猜测） */
export function resolveOfficialAwardPoints(
  contestTier: CompetitionImportTier | null | undefined,
  awardText: string | null | undefined,
): { points: string; hint: string } | null {
  if (!contestTier) return null
  const text = (awardText ?? '').trim()
  if (!text) return null
  const lower = text.toLowerCase()

  if (/(打星|非正式|随队|不计分|unofficial|star)/i.test(text)) {
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
    const { startAt } = competitionSchedule(input.event.competitionDate)
    const [members, existingEvent] = await Promise.all([
      this.loadMembers(input.rows),
      this.db.competitionEvent.findFirst({
        where: { title: input.event.title, startAt, status: 'archived' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, title: true, status: true, teamSize: true },
      }),
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
   * 3. 对非零积分写入 PointsLedgerEntry（sourceKey 与正式赛审核同源，天然幂等）；
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

    const validRows = resolved.filter((r): r is CompetitionImportPreviewRow & { userId: string } => !r.error && r.userId != null)
    if (validRows.length === 0) {
      throw new ScoringError('没有可导入的有效名单记录，请检查错误提示', 'NO_VALID_ROWS')
    }

    // 1. 自动创建或复用同名同日已归档正式赛
    const existing = await this.db.competitionEvent.findFirst({
      where: { title: input.event.title, startAt: schedule.startAt, status: 'archived' },
      orderBy: { createdAt: 'asc' },
    })
    if (existing && (existing.teamSize ?? null) !== teamSize) {
      throw new ScoringError(
        `已存在同名同日的归档赛事「${existing.title}」，但其参赛形式与本次不一致，请修改比赛名称或保持一致`,
        'CONFLICT',
      )
    }

    const batchId = newId()
    const now = new Date()
    let eventId: string
    let eventCreated = false
    if (existing) {
      eventId = existing.id
    } else {
      eventId = newId()
      eventCreated = true
      await this.db.competitionEvent.create({
        data: {
          id: eventId,
          title: input.event.title,
          category: input.event.category,
          teamSize,
          scoringMode: 'manual_review',
          contestTier: input.event.contestTier ?? null,
          announcement: input.event.announcement?.trim() || DEFAULT_ARCHIVE_ANNOUNCEMENT,
          registerDeadline: schedule.registerDeadline,
          startAt: schedule.startAt,
          endAt: schedule.endAt,
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
      })
    }

    const outcomes: CompetitionImportRowOutcome[] = []
    for (const row of resolved) {
      if (row.error || !row.userId) {
        outcomes.push({
          row: row.row,
          studentNo: row.studentNo || row.inputName || `第 ${row.row} 行`,
          memberName: row.memberName,
          ...(row.teamName ? { teamName: row.teamName } : {}),
          points: row.points,
          status: 'failed',
          error: row.error ?? '成员无效',
        })
      }
    }

    let registeredCount = 0
    let teamsCreated = 0
    let posted = 0
    let duplicate = 0
    let rosterOnly = 0

    if (teamSize != null) {
      // 团队赛：按队名分组，自动建立常驻/归档小队、队员关联与队伍赛事记录
      const teamGroups = new Map<string, Array<CompetitionImportPreviewRow & { userId: string }>>()
      for (const row of validRows) {
        const key = row.teamName!.trim()
        teamGroups.set(key, [...(teamGroups.get(key) ?? []), row])
      }

      const existingEntries = await this.db.teamCompetitionEntry.findMany({
        where: { eventId },
        include: { team: true },
      })
      const existingByTeamName = new Map(existingEntries.map((entry) => [entry.team.name, entry]))

      for (const [teamName, groupRows] of teamGroups) {
        const existingEntry = existingByTeamName.get(teamName)
        let teamId: string
        if (existingEntry) {
          teamId = existingEntry.teamId
        } else {
          teamId = newId()
          await this.db.team.create({
            data: {
              id: teamId,
              name: teamName,
              teamSize: Math.max(teamSize, groupRows.length),
              captainUserId: groupRows[0]!.userId,
              status: 'locked',
              createdBy: actor.principalId,
            },
          })
          teamsCreated++
        }

        for (let i = 0; i < groupRows.length; i++) {
          const member = groupRows[i]!
          await this.db.teamMember.upsert({
            where: { teamId_userId: { teamId, userId: member.userId } },
            create: {
              id: newId(),
              teamId,
              userId: member.userId,
              role: i === 0 && !existingEntry ? 'captain' : 'member',
              status: 'active',
            },
            update: { status: 'active', leftAt: null },
          })
        }

        const maxPoints = groupRows.reduce((max, r) => Math.max(max, Number(r.points || 0)), 0)
        const hasAnyPoints = groupRows.some((r) => Number(r.points || 0) !== 0)
        const uniqueAwards = [...new Set(groupRows.map((r) => r.awardText).filter((v): v is string => Boolean(v)))]
        const uniqueRanks = [...new Set(groupRows.map((r) => r.rankText).filter((v): v is string => Boolean(v)))]
        const teamReviewNote = [
          uniqueAwards.join(' / '),
          uniqueRanks.length > 0 ? `排名 ${uniqueRanks.join(' / ')}` : '',
        ].filter(Boolean).join(' · ') || null

        const teamResultDetail = {
          source: 'competition_import',
          importBatchId: batchId,
          contestTier: input.event.contestTier ?? null,
          awardText: uniqueAwards[0] ?? null,
          rankText: uniqueRanks[0] ?? null,
          memberResults: groupRows.map((r) => ({
            userId: r.userId,
            studentNo: r.studentNo,
            awardText: r.awardText ?? null,
            rankText: r.rankText ?? null,
            points: r.points,
            note: r.note ?? null,
          })),
        }

        const entry = await this.db.teamCompetitionEntry.upsert({
          where: { teamId_eventId: { teamId, eventId } },
          create: {
            id: newId(),
            teamId,
            eventId,
            status: 'approved',
            resultScore: hasAnyPoints ? maxPoints.toFixed(2) : null,
            resultDetail: teamResultDetail as never,
            reviewNote: teamReviewNote,
            reviewedBy: actor.principalId,
            reviewedAt: now,
          },
          update: {
            status: 'approved',
            resultScore: hasAnyPoints ? maxPoints.toFixed(2) : null,
            resultDetail: teamResultDetail as never,
            reviewNote: teamReviewNote,
            reviewedBy: actor.principalId,
            reviewedAt: now,
          },
        })

        for (const member of groupRows) {
          registeredCount++
          const numPoints = Number(member.points || 0)
          if (numPoints === 0) {
            rosterOnly++
            outcomes.push({
              row: member.row,
              studentNo: member.studentNo,
              memberName: member.memberName,
              teamName,
              points: '0',
              status: 'roster_only',
            })
            if (!existingEntry) {
              await this.notifyMember(member.userId, input.event.title, scoreMonth, member.awardText, null, teamName)
            }
            continue
          }

          try {
            const amount = numPoints.toFixed(2)
            const res = await this.scoring.postLedgerEntry(actor, {
              userId: member.userId,
              sourceKey: `team-competition:${eventId}:${teamId}:${member.userId}`,
              category: input.event.ledgerCategory,
              amount,
              scoreMonth,
              detail: {
                eventId,
                eventTitle: input.event.title,
                competitionDate: input.event.competitionDate,
                contestTier: input.event.contestTier ?? null,
                teamId,
                teamName,
                awardText: member.awardText ?? null,
                rankText: member.rankText ?? null,
                note: member.note ?? null,
                source: 'competition_import',
                importBatchId: batchId,
              },
              evidenceRef: `team_competition_entry:${entry.id}`,
            })
            if (res.deduplicated) {
              duplicate++
              outcomes.push({
                row: member.row,
                studentNo: member.studentNo,
                memberName: member.memberName,
                teamName,
                points: amount,
                status: 'duplicate',
                error: '该成员本场正式赛积分已入账，名单已同步更新',
              })
            } else {
              posted++
              outcomes.push({
                row: member.row,
                studentNo: member.studentNo,
                memberName: member.memberName,
                teamName,
                points: amount,
                status: 'archived',
              })
              await this.notifyMember(member.userId, input.event.title, scoreMonth, member.awardText, amount, teamName)
            }
          } catch (error) {
            outcomes.push({
              row: member.row,
              studentNo: member.studentNo,
              memberName: member.memberName,
              teamName,
              points: member.points,
              status: 'failed',
              error: error instanceof Error ? error.message : '积分入账失败',
            })
          }
        }
      }
    } else {
      // 个人赛：逐人写入 CompetitionRegistration 并归档积分
      for (const row of validRows) {
        const numPoints = Number(row.points || 0)
        const existedReg = await this.db.competitionRegistration.findUnique({
          where: { eventId_userId: { eventId, userId: row.userId } },
          select: { id: true },
        })
        const reviewNote = summarizeResultNote(row, true)
        const resultDetail = {
          source: 'competition_import',
          importBatchId: batchId,
          contestTier: input.event.contestTier ?? null,
          awardText: row.awardText ?? null,
          rankText: row.rankText ?? null,
          teamName: row.teamName ?? null,
          pointsSource: row.pointsSource,
          note: row.note ?? null,
        }
        const reg = await this.db.competitionRegistration.upsert({
          where: { eventId_userId: { eventId, userId: row.userId } },
          create: {
            id: newId(),
            eventId,
            userId: row.userId,
            status: 'approved',
            resultScore: numPoints !== 0 ? numPoints.toFixed(2) : null,
            resultDetail: resultDetail as never,
            reviewNote,
            note: row.note ?? (row.teamName ? `队伍：${row.teamName}` : null),
            reviewedBy: actor.principalId,
            reviewedAt: now,
            confirmedAt: now,
          },
          update: {
            status: 'approved',
            resultScore: numPoints !== 0 ? numPoints.toFixed(2) : null,
            resultDetail: resultDetail as never,
            reviewNote,
            note: row.note ?? (row.teamName ? `队伍：${row.teamName}` : null),
            reviewedBy: actor.principalId,
            reviewedAt: now,
            confirmedAt: now,
          },
        })
        registeredCount++

        if (numPoints === 0) {
          rosterOnly++
          outcomes.push({
            row: row.row,
            studentNo: row.studentNo,
            memberName: row.memberName,
            ...(row.teamName ? { teamName: row.teamName } : {}),
            points: '0',
            status: 'roster_only',
          })
          if (!existedReg) {
            await this.notifyMember(row.userId, input.event.title, scoreMonth, row.awardText, null, row.teamName)
          }
          continue
        }

        try {
          const amount = numPoints.toFixed(2)
          const res = await this.scoring.postLedgerEntry(actor, {
            userId: row.userId,
            sourceKey: `competition:${eventId}:${row.userId}`,
            category: input.event.ledgerCategory,
            amount,
            scoreMonth,
            detail: {
              eventId,
              eventTitle: input.event.title,
              competitionDate: input.event.competitionDate,
              contestTier: input.event.contestTier ?? null,
              teamName: row.teamName ?? null,
              awardText: row.awardText ?? null,
              rankText: row.rankText ?? null,
              note: row.note ?? null,
              source: 'competition_import',
              importBatchId: batchId,
            },
            evidenceRef: `competition_registration:${reg.id}`,
          })
          if (res.deduplicated) {
            duplicate++
            outcomes.push({
              row: row.row,
              studentNo: row.studentNo,
              memberName: row.memberName,
              ...(row.teamName ? { teamName: row.teamName } : {}),
              points: amount,
              status: 'duplicate',
              error: '该成员本场正式赛积分已入账，名单已同步更新',
            })
          } else {
            posted++
            outcomes.push({
              row: row.row,
              studentNo: row.studentNo,
              memberName: row.memberName,
              ...(row.teamName ? { teamName: row.teamName } : {}),
              points: amount,
              status: 'archived',
            })
            await this.notifyMember(row.userId, input.event.title, scoreMonth, row.awardText, amount, row.teamName)
          }
        } catch (error) {
          outcomes.push({
            row: row.row,
            studentNo: row.studentNo,
            memberName: row.memberName,
            ...(row.teamName ? { teamName: row.teamName } : {}),
            points: row.points,
            status: 'failed',
            error: error instanceof Error ? error.message : '积分入账失败',
          })
        }
      }
    }

    outcomes.sort((a, b) => a.row - b.row)
    const failed = outcomes.filter((o) => o.status === 'failed').length

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
