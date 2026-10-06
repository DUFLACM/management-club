import { DomainError } from '../../common/domain-error.js'
import { Inject, Injectable } from '@nestjs/common'
import { matrixTeamAssignment } from '@acm/scoring-core'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { newId } from '../../common/utils.js'
import type { SessionActor } from '../auth/session.service.js'

/**
 * 组队广场（《竞赛报名、名额分配与组队管理办法》第十二~十七条）：
 * - 常驻小队：一人可属于多队，可持续邀请新成员，不与单场比赛强绑定。
 * - A 类团队赛：仅入围队员（CompetitionShortlistRow.shortlisted=true）可组队/报名；
 *   超过自主组队截止仍未成队的，由管理员按"均衡分组矩阵法"强制编组。
 * - B 类/开放团队赛：直接自由建队报名。
 */
export class TeamError extends DomainError {
  constructor(message: string, readonly code: string) {
    super(message, code)
  }
}

@Injectable()
export class TeamService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createTeam(userId: string, input: { name: string; teamSize: number }): Promise<{ teamId: string }> {
    const id = newId()
    await this.db.$transaction(async (tx) => {
      await tx.team.create({ data: { id, name: input.name, teamSize: input.teamSize, captainUserId: userId, createdBy: userId } })
      await tx.teamMember.create({ data: { id: newId(), teamId: id, userId, role: 'captain' } })
    })
    return { teamId: id }
  }

  async myTeams(userId: string) {
    const memberships = await this.db.teamMember.findMany({
      where: { userId, status: 'active' },
      include: {
        team: {
          include: {
            members: { where: { status: 'active' }, include: { user: { select: { id: true, verifiedRealName: true, studentNo: true, profile: { select: { displayName: true } } } } } },
            entries: { include: { event: { select: { id: true, title: true, status: true } } } },
          },
        },
      },
    })
    return memberships.map((m) => m.team)
  }

  /** 组队广场成员检索：按昵称/实名/学号前缀匹配，学号脱敏仅保留后四位用于同名消歧 */
  async searchInvitableMembers(selfUserId: string, keyword: string) {
    const q = keyword.trim()
    if (q.length < 2) return []
    const users = await this.db.user.findMany({
      where: {
        accountStatus: 'active',
        id: { not: selfUserId },
        membershipTerms: { some: { membershipStatus: { in: ['formal', 'provisional', 'observing'] } } },
        OR: [
          { verifiedRealName: { contains: q } },
          { studentNo: { contains: q } },
          { profile: { displayName: { contains: q } } },
        ],
      },
      select: { id: true, verifiedRealName: true, studentNo: true, profile: { select: { displayName: true } } },
      take: 20,
    })
    return users.map((u) => ({
      userId: u.id,
      displayName: u.profile?.displayName ?? u.verifiedRealName,
      studentNoMasked: u.studentNo.length > 4 ? `***${u.studentNo.slice(-4)}` : u.studentNo,
    }))
  }

  /** userId 为 null 时表示管理端下载（由 ActionGuard 校验权限），否则仅限在队成员 */
  async teamMaterialForDownload(entryId: string, materialId: string, userId: string | null) {
    const material = await this.db.teamCompetitionMaterial.findUnique({
      where: { id: materialId },
      include: { entry: { include: { team: { include: { members: true } } } } },
    })
    if (!material || material.entryId !== entryId) throw new TeamError('材料不存在', 'NOT_FOUND')
    if (userId !== null && !material.entry.team.members.some((m) => m.userId === userId && m.status === 'active')) {
      throw new TeamError('你不是该队伍成员', 'NOT_MEMBER')
    }
    const path = await import('node:path')
    return {
      material: { fileName: material.fileName, mimeType: material.mimeType },
      filePath: path.join(process.env.STORAGE_LOCAL_DIR ?? './storage', material.storageKey),
    }
  }

  private async assertActiveMember(teamId: string, userId: string) {
    const member = await this.db.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } } })
    if (!member || member.status !== 'active') throw new TeamError('你不是该队伍成员', 'NOT_MEMBER')
    return member
  }

  async inviteMember(teamId: string, inviterUserId: string, inviteeUserId: string): Promise<{ inviteId: string }> {
    const team = await this.db.team.findUnique({ where: { id: teamId }, include: { members: { where: { status: 'active' } } } })
    if (!team) throw new TeamError('队伍不存在', 'NOT_FOUND')
    if (team.status !== 'forming') throw new TeamError('队伍已锁定或解散，不能再邀请', 'STATE_INVALID')
    await this.assertActiveMember(teamId, inviterUserId)
    if (team.members.some((m) => m.userId === inviteeUserId)) throw new TeamError('该成员已在队伍中', 'ALREADY_MEMBER')
    if (team.members.length >= team.teamSize) throw new TeamError('队伍人数已满', 'TEAM_FULL')
    const id = newId()
    await this.db.teamInvite.upsert({
      where: { teamId_invitedUserId_status: { teamId, invitedUserId: inviteeUserId, status: 'pending' } },
      create: { id, teamId, invitedUserId: inviteeUserId, invitedBy: inviterUserId },
      update: {},
    })
    return { inviteId: id }
  }

  async myInvites(userId: string) {
    return this.db.teamInvite.findMany({
      where: { invitedUserId: userId, status: 'pending' },
      include: { team: { select: { id: true, name: true, teamSize: true } } },
      orderBy: { createdAt: 'desc' },
    })
  }

  async respondInvite(inviteId: string, userId: string, decision: 'accept' | 'decline'): Promise<void> {
    const invite = await this.db.teamInvite.findUnique({ where: { id: inviteId }, include: { team: { include: { members: { where: { status: 'active' } } } } } })
    if (!invite || invite.invitedUserId !== userId) throw new TeamError('邀请不存在', 'NOT_FOUND')
    if (invite.status !== 'pending') throw new TeamError('该邀请已处理', 'STATE_INVALID')
    if (decision === 'decline') {
      await this.db.teamInvite.update({ where: { id: inviteId }, data: { status: 'declined', respondedAt: new Date() } })
      return
    }
    if (invite.team.members.length >= invite.team.teamSize) throw new TeamError('队伍人数已满', 'TEAM_FULL')
    await this.db.$transaction(async (tx) => {
      await tx.teamInvite.update({ where: { id: inviteId }, data: { status: 'accepted', respondedAt: new Date() } })
      await tx.teamMember.upsert({
        where: { teamId_userId: { teamId: invite.teamId, userId } },
        create: { id: newId(), teamId: invite.teamId, userId, role: 'member' },
        update: { status: 'active', leftAt: null },
      })
    })
  }

  async leaveTeam(teamId: string, userId: string): Promise<void> {
    const member = await this.assertActiveMember(teamId, userId)
    const team = await this.db.team.findUniqueOrThrow({ where: { id: teamId }, include: { members: { where: { status: 'active' } } } })
    await this.db.$transaction(async (tx) => {
      await tx.teamMember.update({ where: { id: member.id }, data: { status: 'left', leftAt: new Date() } })
      if (team.captainUserId === userId) {
        const next = team.members.find((m) => m.userId !== userId)
        if (next) await tx.team.update({ where: { id: teamId }, data: { captainUserId: next.userId } })
      }
    })
  }

  /** 组队广场可选团队赛：人数匹配 + 报名期内；A 类限入围成员均在 shortlisted 名单内 */
  async eligibleEvents(teamId: string) {
    const team = await this.db.team.findUniqueOrThrow({ where: { id: teamId }, include: { members: { where: { status: 'active' } } } })
    const events = await this.db.competitionEvent.findMany({
      where: { teamSize: team.teamSize, status: { in: ['open', 'shortlisted', 'team_forming'] }, registerDeadline: { gt: new Date() } },
    })
    const results: Array<{ event: (typeof events)[number]; eligible: boolean; reason?: string }> = []
    for (const event of events) {
      if (event.category !== 'A') { results.push({ event, eligible: true }); continue }
      const rows = await this.db.competitionShortlistRow.findMany({ where: { eventId: event.id, userId: { in: team.members.map((m) => m.userId) } } })
      const allShortlisted = team.members.length === rows.length && rows.every((r) => r.shortlisted)
      results.push({ event, eligible: allShortlisted, reason: allShortlisted ? undefined : '并非全体队员都在该赛事入围名单内' })
    }
    return results
  }

  async registerTeamForEvent(teamId: string, eventId: string, actorUserId: string): Promise<{ entryId: string }> {
    const team = await this.db.team.findUniqueOrThrow({ where: { id: teamId }, include: { members: { where: { status: 'active' }, include: { user: { include: { platformAccounts: true } } } } } })
    await this.assertActiveMember(teamId, actorUserId)
    const event = await this.db.competitionEvent.findUnique({ where: { id: eventId } })
    if (!event) throw new TeamError('赛事不存在', 'NOT_FOUND')
    if (event.teamSize !== team.teamSize) throw new TeamError('队伍人数与该赛事要求不符', 'SIZE_MISMATCH')
    if (team.members.length !== team.teamSize) throw new TeamError('队伍尚未满员，不能报名', 'TEAM_NOT_FULL')
    if (event.registerDeadline.getTime() < Date.now()) throw new TeamError('报名已截止', 'DEADLINE_PASSED')
    if (event.category === 'A') {
      const rows = await this.db.competitionShortlistRow.findMany({ where: { eventId, userId: { in: team.members.map((m) => m.userId) } } })
      if (rows.length !== team.members.length || rows.some((r) => !r.shortlisted)) {
        throw new TeamError('并非全体队员都在该赛事入围名单内', 'NOT_SHORTLISTED')
      }
    }
    if (event.scoringMode === 'platform_auto') {
      const missing = team.members.filter((m) => !m.user.platformAccounts.some((a) => a.platform === event.platform && a.status === 'verified'))
      if (missing.length > 0) throw new TeamError('存在未绑定/未核验对应平台账号的队员', 'NEEDS_PLATFORM_BIND')
    }
    const id = newId()
    await this.db.teamCompetitionEntry.upsert({
      where: { teamId_eventId: { teamId, eventId } },
      create: { id, teamId, eventId, status: event.scoringMode === 'platform_auto' ? 'confirmed' : 'pending_review' },
      update: { status: event.scoringMode === 'platform_auto' ? 'confirmed' : 'pending_review', reviewNote: null },
    })
    await this.db.team.update({ where: { id: teamId }, data: { status: 'locked' } })
    const entry = await this.db.teamCompetitionEntry.findUniqueOrThrow({ where: { teamId_eventId: { teamId, eventId } } })
    return { entryId: entry.id }
  }

  private static readonly MATERIAL_MIME_WHITELIST = new Set([
    'application/pdf', 'application/zip', 'application/x-zip-compressed',
    'text/markdown', 'text/plain',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png', 'image/jpeg',
  ])

  async uploadTeamMaterial(
    userId: string,
    entryId: string,
    file: { buffer: Buffer; mimetype: string; size: number; originalname?: string },
    input: { title: string },
  ): Promise<{ materialId: string }> {
    const entry = await this.db.teamCompetitionEntry.findUnique({ where: { id: entryId }, include: { team: { include: { members: true } } } })
    if (!entry) throw new TeamError('队伍报名不存在', 'NOT_FOUND')
    if (!entry.team.members.some((m) => m.userId === userId && m.status === 'active')) throw new TeamError('你不是该队伍成员', 'NOT_MEMBER')
    if (file.size > 20 * 1024 * 1024) throw new TeamError('单个材料不超过 20 MiB', 'PAYLOAD_TOO_LARGE')
    if (!TeamService.MATERIAL_MIME_WHITELIST.has(file.mimetype)) throw new TeamError('仅支持 PDF / Markdown / 文本 / Office 文档 / 图片 / ZIP', 'UNSUPPORTED_MEDIA')
    const fileName = (file.originalname ?? 'material').replace(/[/\\?%*:|"<>]/g, '_').slice(0, 180)
    const id = newId()
    const storageKey = `materials/team-competitions/${entry.eventId}/${entryId}/${id}/source.bin`
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const target = path.join(process.env.STORAGE_LOCAL_DIR ?? './storage', storageKey)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, file.buffer)
    await this.db.teamCompetitionMaterial.create({
      data: { id, entryId, title: input.title, fileName, mimeType: file.mimetype, sizeBytes: file.size, storageKey },
    })
    return { materialId: id }
  }

  // ---------------- 管理端：强制编组（办法第十五条） ----------------

  /** 超过自主组队截止仍未成队的入围队员：按积分排名（高到低）填入三行矩阵，再按列成队 */
  async forceTeamAssignment(actor: SessionActor, eventId: string): Promise<{ teamsCreated: number; remainder: number }> {
    const event = await this.db.competitionEvent.findUnique({ where: { id: eventId } })
    if (!event) throw new TeamError('赛事不存在', 'NOT_FOUND')
    if (!event.teamSize) throw new TeamError('该赛事非团队赛', 'NOT_TEAM_EVENT')
    const shortlist = await this.db.competitionShortlistRow.findMany({
      where: { eventId, shortlisted: true },
      orderBy: { position: 'asc' },
    })
    const alreadyTeamed = new Set(
      (
        await this.db.teamMember.findMany({
          where: { status: 'active', team: { entries: { some: { eventId } } } },
          select: { userId: true },
        })
      ).map((m) => m.userId),
    )
    const leftover = shortlist.filter((r) => !alreadyTeamed.has(r.userId))
    if (leftover.length === 0) return { teamsCreated: 0, remainder: 0 }
    const { teams, remainder } = matrixTeamAssignment({ orderedMembers: leftover, teamSize: event.teamSize })
    if (event.teamSize !== 3 && teams.length === 0) {
      throw new TeamError('制度口径仅对三人队提供自动矩阵分组；其他人数队伍需人工编组', 'MATRIX_UNSUPPORTED')
    }
    let teamsCreated = 0
    await this.db.$transaction(async (tx) => {
      for (const group of teams) {
        const teamId = newId()
        const captain = group[0]
        await tx.team.create({
          data: { id: teamId, name: `${event.title} · 均衡编组 ${teamsCreated + 1}`, teamSize: event.teamSize!, captainUserId: captain.userId, createdBy: actor.principalId, status: 'locked' },
        })
        for (const [i, member] of group.entries()) {
          await tx.teamMember.create({ data: { id: newId(), teamId, userId: member.userId, role: i === 0 ? 'captain' : 'member' } })
        }
        await tx.teamCompetitionEntry.create({ data: { id: newId(), teamId, eventId, status: 'confirmed' } })
        teamsCreated++
      }
    })
    await this.audit.log({
      actorPrincipalId: actor.principalId, action: 'competition_event.force_team_assignment',
      resourceType: 'competition_event', resourceId: eventId,
      summary: `均衡分组矩阵法强制编组 ${teamsCreated} 队，余 ${remainder.length} 人待人工处理`,
    })
    return { teamsCreated, remainder: remainder.length }
  }
}
