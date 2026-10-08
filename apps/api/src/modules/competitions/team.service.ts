import { DomainError } from '../../common/domain-error.js'
import { Inject, Injectable } from '@nestjs/common'
import { matrixTeamAssignment } from '@acm/scoring-core'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { newId, memberName, visibleAvatar } from '../../common/utils.js'
import type { Prisma } from '@acm/db'
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
            members: { where: { status: 'active' }, include: { user: { select: { id: true, verifiedRealName: true, studentNo: true, profile: { select: { displayName: true, avatarAssetId: true, visibility: true } } } } } },
            entries: { include: { event: { select: { id: true, title: true, status: true } } } },
            recruitment: { include: { activity: { select: { id: true, title: true } } } },
            joinRequests: {
              where: { status: 'pending' },
              orderBy: { createdAt: 'asc' },
              include: { user: { select: { id: true, verifiedRealName: true, studentNo: true, profile: { select: { displayName: true, avatarAssetId: true, visibility: true } } } } },
            },
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
      select: { id: true, verifiedRealName: true, studentNo: true, profile: { select: { displayName: true, avatarAssetId: true, visibility: true } } },
      take: 20,
    })
    return users.map((u) => ({
      userId: u.id,
      displayName: memberName(u),
      avatarAssetId: visibleAvatar(u.profile),
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
      await tx.teamJoinRequest.updateMany({ where: { teamId: invite.teamId, userId, status: 'pending' }, data: { status: 'cancelled', decidedAt: new Date() } })
      await TeamService.closeRecruitmentIfFull(tx, invite.teamId)
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

  // ---------------- 广场招募：队长发帖 → 成员申请 → 队长审批 ----------------

  private static readonly MEMBER_USER_SELECT = {
    id: true, verifiedRealName: true, profile: { select: { displayName: true, avatarAssetId: true, visibility: true } },
  } as const

  /** 满员后自动关闭招募，并驳回剩余待处理申请 */
  private static async closeRecruitmentIfFull(tx: Prisma.TransactionClient, teamId: string) {
    const team = await tx.team.findUniqueOrThrow({ where: { id: teamId }, select: { teamSize: true } })
    const active = await tx.teamMember.count({ where: { teamId, status: 'active' } })
    if (active < team.teamSize) return
    await tx.teamRecruitment.updateMany({ where: { teamId, status: 'open' }, data: { status: 'closed' } })
    await tx.teamJoinRequest.updateMany({ where: { teamId, status: 'pending' }, data: { status: 'rejected', decidedAt: new Date() } })
  }

  private async assertCaptain(teamId: string, userId: string) {
    const team = await this.db.team.findUnique({ where: { id: teamId }, include: { members: { where: { status: 'active' } } } })
    if (!team) throw new TeamError('队伍不存在', 'NOT_FOUND')
    if (team.captainUserId !== userId) throw new TeamError('只有队长可以操作招募', 'NOT_CAPTAIN')
    return team
  }

  /** 招募广场：开放中的招募帖（不含已满员/已锁定队伍），附本人申请状态 */
  async listRecruitments(viewerUserId: string, q?: string) {
    const keyword = q?.trim()
    const rows = await this.db.teamRecruitment.findMany({
      where: {
        status: 'open',
        team: { status: 'forming', ...(keyword ? { name: { contains: keyword, mode: 'insensitive' as const } } : {}) },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      include: {
        activity: { select: { id: true, title: true, startAt: true, teamSize: true } },
        team: {
          include: {
            members: { where: { status: 'active' }, orderBy: { joinedAt: 'asc' }, include: { user: { select: TeamService.MEMBER_USER_SELECT } } },
            joinRequests: { where: { userId: viewerUserId }, orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
      },
    })
    return rows
      .filter((row) => row.team.members.length < row.team.teamSize)
      .map((row) => ({
        id: row.id,
        teamId: row.teamId,
        teamName: row.team.name,
        teamSize: row.team.teamSize,
        description: row.description,
        updatedAt: row.updatedAt.toISOString(),
        activity: row.activity ? { id: row.activity.id, title: row.activity.title, startAt: row.activity.startAt.toISOString() } : null,
        slotsLeft: row.team.teamSize - row.team.members.length,
        members: row.team.members.map((m) => ({
          userId: m.userId, role: m.role, name: memberName(m.user), avatarAssetId: visibleAvatar(m.user.profile),
        })),
        isMember: row.team.members.some((m) => m.userId === viewerUserId),
        myRequest: row.team.joinRequests[0] ? { id: row.team.joinRequests[0].id, status: row.team.joinRequests[0].status } : null,
      }))
  }

  /** 发布/更新招募帖（每队一条）；可选关联一个人数相同的团队活动 */
  async upsertRecruitment(userId: string, teamId: string, input: { description: string; activityId?: string | null }) {
    const team = await this.assertCaptain(teamId, userId)
    if (team.status !== 'forming') throw new TeamError('队伍已锁定或解散，不能招募', 'STATE_INVALID')
    if (team.members.length >= team.teamSize) throw new TeamError('队伍已满员，无需招募', 'TEAM_FULL')
    if (input.activityId) {
      const activity = await this.db.activity.findUnique({ where: { id: input.activityId }, select: { teamSize: true, status: true } })
      if (!activity || activity.status !== 'published') throw new TeamError('关联的活动不存在或未发布', 'NOT_FOUND')
      if (activity.teamSize !== team.teamSize) throw new TeamError('关联活动的组队人数与本队不一致', 'SIZE_MISMATCH')
    }
    const data = { description: input.description, activityId: input.activityId ?? null, status: 'open' }
    const row = await this.db.teamRecruitment.upsert({
      where: { teamId },
      create: { id: newId(), teamId, createdBy: userId, ...data },
      update: data,
    })
    return { recruitmentId: row.id }
  }

  async closeRecruitment(userId: string, teamId: string): Promise<void> {
    await this.assertCaptain(teamId, userId)
    await this.db.teamRecruitment.updateMany({ where: { teamId }, data: { status: 'closed' } })
  }

  /** 申请加入：招募开放 + 未满员 + 非本队成员；已有待处理申请时幂等返回 */
  async applyToTeam(userId: string, teamId: string, message?: string): Promise<{ requestId: string }> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM teams WHERE id = ${teamId}::uuid FOR UPDATE`
      const team = await tx.team.findUnique({ where: { id: teamId }, include: { members: { where: { status: 'active' } }, recruitment: true } })
      if (!team) throw new TeamError('队伍不存在', 'NOT_FOUND')
      if (!team.recruitment || team.recruitment.status !== 'open' || team.status !== 'forming') throw new TeamError('该队伍当前未开放招募', 'NOT_RECRUITING')
      if (team.members.some((m) => m.userId === userId)) throw new TeamError('你已经是该队成员', 'ALREADY_MEMBER')
      if (team.members.length >= team.teamSize) throw new TeamError('队伍人数已满', 'TEAM_FULL')
      const pending = await tx.teamJoinRequest.findFirst({ where: { teamId, userId, status: 'pending' } })
      if (pending) return { requestId: pending.id }
      const id = newId()
      await tx.teamJoinRequest.create({ data: { id, teamId, userId, message: message?.trim() || null } })
      return { requestId: id }
    })
  }

  async cancelJoinRequest(userId: string, requestId: string): Promise<void> {
    const request = await this.db.teamJoinRequest.findUnique({ where: { id: requestId } })
    if (!request || request.userId !== userId) throw new TeamError('申请不存在', 'NOT_FOUND')
    if (request.status !== 'pending') throw new TeamError('该申请已处理', 'STATE_INVALID')
    await this.db.teamJoinRequest.update({ where: { id: requestId }, data: { status: 'cancelled', decidedAt: new Date() } })
  }

  async myJoinRequests(userId: string) {
    const rows = await this.db.teamJoinRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: { team: { select: { id: true, name: true, teamSize: true } } },
    })
    return rows.map((row) => ({
      id: row.id, status: row.status, message: row.message,
      createdAt: row.createdAt.toISOString(), decidedAt: row.decidedAt?.toISOString() ?? null,
      team: row.team,
    }))
  }

  /** 队长审批入队申请：批准时队伍行锁下校验人数，满员后自动关闭招募 */
  async decideJoinRequest(captainUserId: string, requestId: string, decision: 'approve' | 'reject'): Promise<void> {
    const request = await this.db.teamJoinRequest.findUnique({ where: { id: requestId } })
    if (!request) throw new TeamError('申请不存在', 'NOT_FOUND')
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM teams WHERE id = ${request.teamId}::uuid FOR UPDATE`
      const team = await tx.team.findUniqueOrThrow({ where: { id: request.teamId }, include: { members: { where: { status: 'active' } } } })
      if (team.captainUserId !== captainUserId) throw new TeamError('只有队长可以审批入队申请', 'NOT_CAPTAIN')
      const current = await tx.teamJoinRequest.findUniqueOrThrow({ where: { id: requestId } })
      if (current.status !== 'pending') throw new TeamError('该申请已处理', 'STATE_INVALID')
      if (decision === 'reject') {
        await tx.teamJoinRequest.update({ where: { id: requestId }, data: { status: 'rejected', decidedBy: captainUserId, decidedAt: new Date() } })
        return
      }
      if (team.status !== 'forming') throw new TeamError('队伍已锁定或解散，不能再加人', 'STATE_INVALID')
      if (team.members.length >= team.teamSize) throw new TeamError('队伍人数已满', 'TEAM_FULL')
      await tx.teamJoinRequest.update({ where: { id: requestId }, data: { status: 'approved', decidedBy: captainUserId, decidedAt: new Date() } })
      await tx.teamMember.upsert({
        where: { teamId_userId: { teamId: request.teamId, userId: request.userId } },
        create: { id: newId(), teamId: request.teamId, userId: request.userId, role: 'member' },
        update: { status: 'active', leftAt: null, role: 'member' },
      })
      await TeamService.closeRecruitmentIfFull(tx, request.teamId)
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
