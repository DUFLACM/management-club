import { Inject, Injectable } from '@nestjs/common'
import type { Prisma } from '@acm/db'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { newId, memberName, visibleAvatar } from '../../common/utils.js'
import { TeamError } from './team.service.js'
import type { SessionActor } from '../auth/session.service.js'

/**
 * 管理端 · 组队管理（competitions.manage）：查看全部队伍，代建队伍、增删队员、换队长、改名 / 人数、
 * 锁定 / 解锁、解散。管理员权限最大：已锁定（已报名）的队伍也可调整，界面上提示影响。
 * - 解散：队伍置 disbanded，撤销待处理邀请，进行中的报名（submitted / pending_review / confirmed）置 cancelled；
 *   已审核通过的报名与已入账积分不动。
 * - 所有变更写审计日志。
 */

const TEAM_STATUSES = ['forming', 'locked', 'disbanded'] as const
/** 解散时随队撤销的报名状态；approved / rejected / cancelled 保持原样 */
const CANCELLABLE_ENTRY_STATUSES = ['submitted', 'pending_review', 'confirmed']

const memberUserSelect = {
  id: true,
  studentNo: true,
  verifiedRealName: true,
  profile: { select: { displayName: true, avatarAssetId: true, visibility: true } },
} satisfies Prisma.UserSelect

type MemberUser = Prisma.UserGetPayload<{ select: typeof memberUserSelect }>

function memberView(user: MemberUser) {
  return { userId: user.id, studentNo: user.studentNo, name: memberName(user), avatarAssetId: visibleAvatar(user.profile) }
}

@Injectable()
export class TeamAdminService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** 队伍列表：按队名 / 队员实名 / 展示名 / 学号检索，按状态筛选（active = 未解散），游标分页（每页 20） */
  async list(filters: { q?: string; status?: string; cursor?: string }) {
    const q = filters.q?.trim()
    const where: Prisma.TeamWhereInput = {
      ...(filters.status === 'active'
        ? { status: { not: 'disbanded' } }
        : filters.status && (TEAM_STATUSES as readonly string[]).includes(filters.status)
          ? { status: filters.status }
          : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              {
                members: {
                  some: {
                    status: 'active',
                    user: {
                      OR: [
                        { studentNo: { contains: q } },
                        { verifiedRealName: { contains: q } },
                        { profile: { displayName: { contains: q, mode: 'insensitive' } } },
                      ],
                    },
                  },
                },
              },
            ],
          }
        : {}),
    }
    const rows = await this.db.team.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
      include: {
        members: { where: { status: 'active' }, orderBy: { joinedAt: 'asc' }, include: { user: { select: memberUserSelect } } },
        _count: { select: { entries: true } },
      },
    })
    const nextCursor = rows.length > 20 ? rows.pop()!.id : null
    return {
      items: rows.map((team) => ({
        id: team.id,
        name: team.name,
        teamSize: team.teamSize,
        status: team.status,
        captainUserId: team.captainUserId,
        createdAt: team.createdAt.toISOString(),
        entryCount: team._count.entries,
        members: team.members.map((m) => ({ ...memberView(m.user), role: m.role })),
      })),
      nextCursor,
    }
  }

  async detail(teamId: string) {
    const team = await this.db.team.findUnique({
      where: { id: teamId },
      include: {
        members: { where: { status: 'active' }, orderBy: { joinedAt: 'asc' }, include: { user: { select: memberUserSelect } } },
        invites: { where: { status: 'pending' }, orderBy: { createdAt: 'desc' }, include: { invitedUser: { select: memberUserSelect } } },
        entries: { orderBy: { registeredAt: 'desc' }, include: { event: { select: { id: true, title: true, status: true } } } },
      },
    })
    if (!team) throw new TeamError('队伍不存在', 'NOT_FOUND')
    return {
      id: team.id,
      name: team.name,
      teamSize: team.teamSize,
      status: team.status,
      captainUserId: team.captainUserId,
      createdAt: team.createdAt.toISOString(),
      members: team.members.map((m) => ({ ...memberView(m.user), role: m.role, joinedAt: m.joinedAt.toISOString() })),
      invites: team.invites.map((invite) => ({ id: invite.id, createdAt: invite.createdAt.toISOString(), ...memberView(invite.invitedUser) })),
      entries: team.entries.map((entry) => ({
        id: entry.id,
        status: entry.status,
        registeredAt: entry.registeredAt.toISOString(),
        event: entry.event,
      })),
    }
  }

  /** 代建队伍：指定队长（须为在册账号），可一并加入其他队员 */
  async create(actor: SessionActor, input: { name: string; teamSize: number; captainUserId: string; memberUserIds?: string[] }) {
    const memberIds = [...new Set([input.captainUserId, ...(input.memberUserIds ?? [])])]
    if (memberIds.length > input.teamSize) throw new TeamError(`人数超过队伍上限 ${input.teamSize}`, 'TEAM_FULL')
    await this.assertUsersExist(memberIds)
    const id = newId()
    await this.db.$transaction(async (tx) => {
      await tx.team.create({ data: { id, name: input.name, teamSize: input.teamSize, captainUserId: input.captainUserId, createdBy: input.captainUserId } })
      for (const userId of memberIds) {
        await tx.teamMember.create({ data: { id: newId(), teamId: id, userId, role: userId === input.captainUserId ? 'captain' : 'member' } })
      }
    })
    await this.log(actor, 'teams.admin_create', id, `管理员代建队伍「${input.name}」（${memberIds.length}/${input.teamSize} 人）`)
    return { teamId: id }
  }

  /** 改队名 / 人数上限 / 状态（forming ↔ locked；解散走 disband） */
  async update(actor: SessionActor, teamId: string, input: { name?: string; teamSize?: number; status?: 'forming' | 'locked' }) {
    const team = await this.loadTeam(teamId)
    if (team.status === 'disbanded') throw new TeamError('队伍已解散，不能再修改', 'STATE_INVALID')
    if (input.teamSize != null && input.teamSize < team.members.length) {
      throw new TeamError(`当前已有 ${team.members.length} 名队员，人数上限不能小于这个数`, 'TEAM_SIZE_TOO_SMALL')
    }
    await this.db.team.update({
      where: { id: teamId },
      data: {
        ...(input.name != null ? { name: input.name } : {}),
        ...(input.teamSize != null ? { teamSize: input.teamSize } : {}),
        ...(input.status != null ? { status: input.status } : {}),
      },
    })
    await this.log(actor, 'teams.admin_update', teamId, `修改队伍「${team.name}」`, { name: team.name, teamSize: team.teamSize, status: team.status }, input)
    return { updated: true }
  }

  async addMember(actor: SessionActor, teamId: string, userId: string) {
    const team = await this.loadTeam(teamId)
    if (team.status === 'disbanded') throw new TeamError('队伍已解散，不能加人', 'STATE_INVALID')
    if (team.members.some((m) => m.userId === userId)) throw new TeamError('该成员已在队伍中', 'ALREADY_MEMBER')
    if (team.members.length >= team.teamSize) throw new TeamError('队伍人数已满，请先调大人数上限', 'TEAM_FULL')
    await this.assertUsersExist([userId])
    await this.db.$transaction(async (tx) => {
      await tx.teamMember.upsert({
        where: { teamId_userId: { teamId, userId } },
        create: { id: newId(), teamId, userId, role: 'member' },
        update: { status: 'active', role: 'member', leftAt: null, joinedAt: new Date() },
      })
      // 已直接拉进队的，原有待处理邀请一并作废
      await tx.teamInvite.updateMany({ where: { teamId, invitedUserId: userId, status: 'pending' }, data: { status: 'cancelled', respondedAt: new Date() } })
    })
    await this.log(actor, 'teams.admin_add_member', teamId, `队伍「${team.name}」加入成员 ${userId}`)
    return { added: true }
  }

  /** 移出队员；移出的是队长时自动把队长交给最早入队的其他队员（与成员自行退队一致） */
  async removeMember(actor: SessionActor, teamId: string, userId: string) {
    const team = await this.loadTeam(teamId)
    const member = team.members.find((m) => m.userId === userId)
    if (!member) throw new TeamError('该成员不在队伍中', 'NOT_MEMBER')
    const nextCaptain = team.captainUserId === userId ? team.members.find((m) => m.userId !== userId) : undefined
    await this.db.$transaction(async (tx) => {
      await tx.teamMember.update({ where: { id: member.id }, data: { status: 'left', leftAt: new Date() } })
      if (nextCaptain) {
        await tx.team.update({ where: { id: teamId }, data: { captainUserId: nextCaptain.userId } })
        await tx.teamMember.update({ where: { id: nextCaptain.id }, data: { role: 'captain' } })
      }
    })
    await this.log(actor, 'teams.admin_remove_member', teamId, `队伍「${team.name}」移出成员 ${userId}${nextCaptain ? `，队长转给 ${nextCaptain.userId}` : ''}`)
    return { removed: true }
  }

  async setCaptain(actor: SessionActor, teamId: string, userId: string) {
    const team = await this.loadTeam(teamId)
    if (team.status === 'disbanded') throw new TeamError('队伍已解散', 'STATE_INVALID')
    const member = team.members.find((m) => m.userId === userId)
    if (!member) throw new TeamError('新队长必须是在队成员', 'NOT_MEMBER')
    if (team.captainUserId === userId) return { updated: false }
    await this.db.$transaction(async (tx) => {
      await tx.teamMember.updateMany({ where: { teamId, status: 'active', role: 'captain' }, data: { role: 'member' } })
      await tx.teamMember.update({ where: { id: member.id }, data: { role: 'captain' } })
      await tx.team.update({ where: { id: teamId }, data: { captainUserId: userId } })
    })
    await this.log(actor, 'teams.admin_set_captain', teamId, `队伍「${team.name}」队长改为 ${userId}`)
    return { updated: true }
  }

  async disband(actor: SessionActor, teamId: string, reason?: string) {
    const team = await this.loadTeam(teamId)
    if (team.status === 'disbanded') return { disbanded: false, cancelledEntries: 0 }
    const cancelled = await this.db.$transaction(async (tx) => {
      await tx.team.update({ where: { id: teamId }, data: { status: 'disbanded' } })
      await tx.teamInvite.updateMany({ where: { teamId, status: 'pending' }, data: { status: 'cancelled', respondedAt: new Date() } })
      const entries = await tx.teamCompetitionEntry.updateMany({
        where: { teamId, status: { in: CANCELLABLE_ENTRY_STATUSES } },
        data: { status: 'cancelled', reviewNote: reason ? `队伍被管理员解散：${reason}` : '队伍被管理员解散' },
      })
      return entries.count
    })
    await this.log(actor, 'teams.admin_disband', teamId, `解散队伍「${team.name}」，撤销进行中的报名 ${cancelled} 条`, undefined, undefined, reason)
    return { disbanded: true, cancelledEntries: cancelled }
  }

  async cancelInvite(actor: SessionActor, teamId: string, inviteId: string) {
    const invite = await this.db.teamInvite.findUnique({ where: { id: inviteId } })
    if (!invite || invite.teamId !== teamId) throw new TeamError('邀请不存在', 'NOT_FOUND')
    if (invite.status !== 'pending') return { cancelled: false }
    await this.db.teamInvite.update({ where: { id: inviteId }, data: { status: 'cancelled', respondedAt: new Date() } })
    await this.log(actor, 'teams.admin_cancel_invite', teamId, `撤销队伍邀请 ${inviteId}`)
    return { cancelled: true }
  }

  private async loadTeam(teamId: string) {
    const team = await this.db.team.findUnique({ where: { id: teamId }, include: { members: { where: { status: 'active' }, orderBy: { joinedAt: 'asc' } } } })
    if (!team) throw new TeamError('队伍不存在', 'NOT_FOUND')
    return team
  }

  private async assertUsersExist(userIds: string[]) {
    const found = await this.db.user.count({ where: { id: { in: userIds }, accountStatus: 'active' } })
    if (found !== userIds.length) throw new TeamError('有成员账号不存在或已停用', 'MEMBER_NOT_FOUND')
  }

  private async log(actor: SessionActor, action: string, teamId: string, summary: string, before?: unknown, after?: unknown, reason?: string) {
    await this.audit.log({ actorPrincipalId: actor.principalId, action, resourceType: 'team', resourceId: teamId, summary, before, after, reason })
  }
}
