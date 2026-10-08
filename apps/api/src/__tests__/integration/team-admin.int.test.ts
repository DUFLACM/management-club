import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { TeamAdminService } from '../../modules/competitions/team-admin.service.js'
import { ensureTestDatabase, TEST_URL } from './setup.js'
import { createTestUser, makeActor } from './helpers.js'

/**
 * 管理端组队管理（真实 PostgreSQL）：代建、增删队员、换队长、改人数、解散（撤销进行中的报名、保留已通过的），
 * 以及列表检索。
 */

process.env.DATABASE_URL = TEST_URL

let db: PrismaService
let teams: TeamAdminService

beforeAll(async () => {
  const url = ensureTestDatabase()
  db = new PrismaService(url)
  teams = new TeamAdminService(db, new AuditService(db))
})

afterAll(async () => {
  await db.$disconnect()
})

describe('管理端组队管理', () => {
  it('代建队伍、加人、换队长、移出队长自动交接、人数上限校验', async () => {
    const actor = makeActor()
    const a = await createTestUser(db, { studentNo: '202607001', name: '甲' })
    const b = await createTestUser(db, { studentNo: '202607002', name: '乙' })
    const c = await createTestUser(db, { studentNo: '202607003', name: '丙' })
    const d = await createTestUser(db, { studentNo: '202607004', name: '丁' })

    await expect(teams.create(actor, { name: '超员队', teamSize: 1, captainUserId: a.userId, memberUserIds: [b.userId] })).rejects.toMatchObject({ code: 'TEAM_FULL' })
    const { teamId } = await teams.create(actor, { name: '算法一队', teamSize: 3, captainUserId: a.userId, memberUserIds: [b.userId] })

    await teams.addMember(actor, teamId, c.userId)
    await expect(teams.addMember(actor, teamId, d.userId)).rejects.toMatchObject({ code: 'TEAM_FULL' })
    await expect(teams.addMember(actor, teamId, c.userId)).rejects.toMatchObject({ code: 'ALREADY_MEMBER' })
    await expect(teams.update(actor, teamId, { teamSize: 2 })).rejects.toMatchObject({ code: 'TEAM_SIZE_TOO_SMALL' })

    await teams.setCaptain(actor, teamId, c.userId)
    let detail = await teams.detail(teamId)
    expect(detail.captainUserId).toBe(c.userId)
    expect(detail.members.filter((m) => m.role === 'captain').map((m) => m.userId)).toEqual([c.userId])

    // 移出队长 → 队长交给最早入队的其他队员（甲）
    await teams.removeMember(actor, teamId, c.userId)
    detail = await teams.detail(teamId)
    expect(detail.captainUserId).toBe(a.userId)
    expect(detail.members.map((m) => [m.name, m.role])).toEqual([['甲', 'captain'], ['乙', 'member']])

    // 被移出的人可以重新拉回来
    await teams.addMember(actor, teamId, c.userId)
    expect((await teams.detail(teamId)).members).toHaveLength(3)

    const audits = await db.auditLog.count({ where: { resourceType: 'team', resourceId: teamId } })
    expect(audits).toBeGreaterThanOrEqual(5)
  })

  it('解散：撤销待处理邀请与进行中的报名，已通过的报名保持不变；列表可按队员检索与状态筛选', async () => {
    const actor = makeActor()
    const a = await createTestUser(db, { studentNo: '202607011', name: '队长同学' })
    const b = await createTestUser(db, { studentNo: '202607012', name: '被邀请同学' })
    const { teamId } = await teams.create(actor, { name: '解散测试队', teamSize: 3, captainUserId: a.userId })
    await db.teamInvite.create({ data: { id: randomUUID(), teamId, invitedUserId: b.userId, invitedBy: a.userId } })

    const event = (title: string) => db.competitionEvent.create({
      data: {
        id: randomUUID(), title, announcement: '测试', category: 'B', scoringMode: 'manual_review', createdBy: randomUUID(),
        registerDeadline: new Date(Date.now() + 86400_000), startAt: new Date(Date.now() + 2 * 86400_000), endAt: new Date(Date.now() + 3 * 86400_000),
      },
    })
    const pending = await event('进行中的赛事')
    const done = await event('已通过的赛事')
    await db.teamCompetitionEntry.create({ data: { id: randomUUID(), teamId, eventId: pending.id, status: 'pending_review' } })
    await db.teamCompetitionEntry.create({ data: { id: randomUUID(), teamId, eventId: done.id, status: 'approved' } })

    const byMember = await teams.list({ q: '队长同学' })
    expect(byMember.items.map((t) => t.id)).toContain(teamId)
    expect(byMember.items.find((t) => t.id === teamId)?.entryCount).toBe(2)

    const result = await teams.disband(actor, teamId, '队员毕业')
    expect(result).toEqual({ disbanded: true, cancelledEntries: 1 })
    const entries = await db.teamCompetitionEntry.findMany({ where: { teamId }, orderBy: { status: 'asc' } })
    expect(entries.map((e) => e.status)).toEqual(['approved', 'cancelled'])
    expect(await db.teamInvite.count({ where: { teamId, status: 'pending' } })).toBe(0)
    await expect(teams.addMember(actor, teamId, b.userId)).rejects.toMatchObject({ code: 'STATE_INVALID' })

    expect((await teams.list({ status: 'disbanded' })).items.map((t) => t.id)).toContain(teamId)
    expect((await teams.list({ status: 'forming' })).items.map((t) => t.id)).not.toContain(teamId)
    expect((await teams.list({ status: 'active' })).items.map((t) => t.id)).not.toContain(teamId)
  })
})
