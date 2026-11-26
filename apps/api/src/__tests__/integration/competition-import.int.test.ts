import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { CompetitionImportService } from '../../modules/scoring/competition-import.service.js'
import { ScoringService } from '../../modules/scoring/scoring.service.js'
import { createTestUser, makeActor } from './helpers.js'
import { ensureTestDatabase, TEST_URL } from './setup.js'

process.env.DATABASE_URL = TEST_URL

let db: PrismaService
let scoring: ScoringService
let imports: CompetitionImportService
const importer = makeActor()
const scoreMonth = '2026-05'
const provincialEvent = {
  category: 'A', contestTier: 'provincial', competitionDate: '2026-05-16', ledgerCategory: 'award',
} as const

beforeAll(() => {
  db = new PrismaService(ensureTestDatabase())
  const audit = new AuditService(db)
  scoring = new ScoringService(db, audit, {} as never, {} as never)
  imports = new CompetitionImportService(db, audit, scoring)
})

afterAll(async () => {
  await db?.$disconnect()
})

async function memberMonthPoints(userId: string, month = scoreMonth) {
  const overview = await scoring.myScoreOverview(userId, month)
  return overview.months.find((entry) => entry.month === month)?.raw
}

function runAwardBackfill() {
  const psql = path.join(process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@18/bin', 'psql')
  const migration = path.resolve('../../prisma/migrations/20261126100000_backfill_competition_awards/migration.sql')
  execFileSync(psql, ['-X', '-v', 'ON_ERROR_STOP=1', '-d', TEST_URL, '-f', migration], { stdio: 'pipe' })
}

describe('正式赛名单补录获奖分', () => {
  it('按实际流水补足旧名单的获奖分，重复导入或重传低分旧表均不会多发或回扣', async () => {
    const studentNo = '202608001'
    const { userId } = await createTestUser(db, { studentNo, membership: 'provisional' })
    const event = { ...provincialEvent, title: '省赛个人补录测试' }
    const row = { studentNo, row: 2 }
    const initial = await imports.commit(importer, { event, rows: [{ ...row, awardText: '参赛' }] })
    expect(initial).toMatchObject({ posted: 1, failed: 0 })
    expect(await memberMonthPoints(userId)).toBe(20)

    // 同名同日复用已归档赛事，包括按实际开赛时间建档的比赛。
    await db.competitionEvent.update({
      where: { id: initial.event.id }, data: { startAt: new Date('2026-05-16T10:15:00+08:00') },
    })
    // 模拟旧版导入已更新报名成绩，积分流水仍只有参赛分。
    const where = { eventId_userId: { eventId: initial.event.id, userId } }
    await db.competitionRegistration.update({
      where,
      data: { resultScore: '55.00', resultDetail: { source: 'competition_import', awardText: '铜奖' } },
    })
    await imports.commit(importer, { event, rows: [{ ...row, awardText: '参赛' }] })
    expect(Number((await db.competitionRegistration.findUniqueOrThrow({ where })).resultScore)).toBe(55)
    expect(await memberMonthPoints(userId)).toBe(20)
    const results = { event, rows: [{ ...row, awardText: '铜奖' }] }
    const corrected = await imports.commit(importer, results)
    expect(corrected).toMatchObject({
      event: { id: initial.event.id }, posted: 1, duplicate: 0, failed: 0, rows: [{ postedAmount: '35.00' }],
    })
    const registration = await db.competitionRegistration.findUniqueOrThrow({ where })
    expect(Number(registration.resultScore)).toBe(55)
    expect(await memberMonthPoints(userId)).toBe(55)

    const postedRows = await db.pointsLedgerEntry.count({ where: { userId } })
    const repeated = await imports.commit(importer, results)
    expect(repeated).toMatchObject({ posted: 0, duplicate: 1, failed: 0 })
    expect(await db.pointsLedgerEntry.count({ where: { userId } })).toBe(postedRows)
    expect(await memberMonthPoints(userId)).toBe(55)

    const upgraded = await imports.commit(importer, { event, rows: [{ ...row, awardText: '银奖' }] })
    expect(upgraded).toMatchObject({ posted: 1, failed: 0, rows: [{ postedAmount: '15.00' }] })
    expect(await memberMonthPoints(userId)).toBe(70)
    const stale = await imports.commit(importer, results)
    expect(stale.posted).toBe(0)
    expect(await memberMonthPoints(userId)).toBe(70)
    const retained = await db.competitionRegistration.findUniqueOrThrow({ where })
    expect(Number(retained.resultScore)).toBe(70)
    expect(retained.resultDetail).toMatchObject({ awardText: '银奖' })
  })

  it('并发首次导入只建一场赛事和一支队伍，补录按各自成绩更新每位队员的积分', async () => {
    const first = await createTestUser(db, { studentNo: '202608002' })
    const second = await createTestUser(db, { studentNo: '202608003' })
    const event = { ...provincialEvent, title: '省赛队伍补录测试', teamSize: 2 }
    const rows = [
      { row: 2, studentNo: '202608002', teamName: '测试队', awardText: '参赛' },
      { row: 3, studentNo: '202608003', teamName: '测试队', awardText: '参赛' },
    ]
    const [initial, concurrent] = await Promise.all([
      imports.commit(importer, { event, rows }), imports.commit(importer, { event, rows }),
    ])
    expect(initial.event.id).toBe(concurrent.event.id)
    expect(initial.teamsCreated + concurrent.teamsCreated).toBe(1)
    expect(initial.posted + concurrent.posted).toBe(2)
    expect(initial.duplicate + concurrent.duplicate).toBe(2)
    expect(initial.failed + concurrent.failed).toBe(0)
    expect(await db.teamCompetitionEntry.count({ where: { eventId: initial.event.id } })).toBe(1)
    expect(await memberMonthPoints(first.userId)).toBe(20)
    expect(await memberMonthPoints(second.userId)).toBe(20)

    const results = { event, rows: [{ ...rows[0], awardText: '银奖' }, { ...rows[1], awardText: '铜奖' }] }
    const corrected = await imports.commit(importer, results)
    expect(corrected).toMatchObject({ teamsCreated: 0, duplicate: 0, failed: 0 })
    const entry = await db.teamCompetitionEntry.findFirstOrThrow({ where: { eventId: initial.event.id } })
    expect(entry.resultDetail).toMatchObject({
      memberResults: [
        { userId: first.userId, awardText: '银奖' },
        { userId: second.userId, awardText: '铜奖' },
      ],
    })
    expect(await memberMonthPoints(first.userId)).toBe(70)
    expect(await memberMonthPoints(second.userId)).toBe(55)
    const repeated = await imports.commit(importer, results)
    expect(repeated).toMatchObject({ posted: 0, duplicate: 2, failed: 0 })
    expect(await memberMonthPoints(first.userId)).toBe(70)
    expect(await memberMonthPoints(second.userId)).toBe(55)
  })

  it('并发提交同一份获奖名单只补发一次', async () => {
    const studentNo = '202608004'
    const { userId } = await createTestUser(db, { studentNo })
    const event = { ...provincialEvent, title: '省赛并发补录测试' }
    const row = { row: 2, studentNo }
    await imports.commit(importer, { event, rows: [{ ...row, awardText: '参赛' }] })
    const results = { event, rows: [{ ...row, awardText: '金奖' }] }
    const [first, second] = await Promise.all([imports.commit(importer, results), imports.commit(importer, results)])
    expect(first.failed + second.failed).toBe(0)
    expect(first.duplicate + second.duplicate).toBe(1)
    expect(await memberMonthPoints(userId)).toBe(95)
  })

  it('成绩保存失败时同步回滚差额流水，修正后可重试', async () => {
    const studentNo = '202608005'
    const { userId } = await createTestUser(db, { studentNo })
    const event = { ...provincialEvent, title: '省赛补录回滚测试' }
    const row = { row: 2, studentNo }
    await imports.commit(importer, { event, rows: [{ ...row, awardText: '参赛' }] })
    // 该值可存入流水，但超过报名成绩 decimal(12,4) 的上限。
    const invalid = await imports.commit(importer, { event, rows: [{ ...row, points: '100000000' }] })
    expect(invalid).toMatchObject({ posted: 0, failed: 1 })
    expect(await memberMonthPoints(userId)).toBe(20)
    const retry = await imports.commit(importer, { event, rows: [{ ...row, awardText: '银奖' }] })
    expect(retry).toMatchObject({ posted: 1, failed: 0, rows: [{ postedAmount: '50.00' }] })
    expect(await memberMonthPoints(userId)).toBe(70)
  })
})

describe('历史正式赛获奖分迁移', () => {
  it('同名同日的两份档案都给同一人记过分时，保留原账待核对', async () => {
    const studentNo = '202608100'
    const { userId } = await createTestUser(db, { studentNo })
    const event = { ...provincialEvent, title: '疑似重复建档的省赛' }
    const row = { row: 2, studentNo }
    const first = await imports.commit(importer, { event, rows: [{ ...row, awardText: '参赛' }] })
    const second = await imports.commit(importer, {
      event: { ...event, title: '另一份档案' }, rows: [{ ...row, awardText: '铜奖' }],
    })
    await db.competitionEvent.update({ where: { id: second.event.id }, data: { title: event.title } })
    await db.competitionRegistration.update({
      where: { eventId_userId: { eventId: first.event.id, userId } }, data: { resultScore: '55' },
    })
    runAwardBackfill()
    expect(await db.pointsLedgerEntry.count({ where: { userId } })).toBe(2)
    expect(await memberMonthPoints(userId)).toBe(75)
  })

  it('只给已确认且仍有差额的个人补分，保留表内指定分值和人工冲正', async () => {
    const event = { ...provincialEvent, title: '历史个人省赛', scoreMonth: '2026-04', ledgerCategory: 'contest' as const }
    const members = []
    for (const studentNo of ['202608101', '202608102', '202608103', '202608104']) {
      members.push({ studentNo, ...(await createTestUser(db, { studentNo })) })
    }
    const rows = members.map(({ studentNo }, i) => ({ row: i + 2, studentNo, awardText: '参赛' }))
    const { event: { id: eventId } } = await imports.commit(importer, { event, rows })
    for (const [index, member] of members.entries()) {
      await db.competitionRegistration.update({
        where: { eventId_userId: { eventId, userId: member.userId } },
        data: {
          status: index === 2 ? 'pending_review' : 'approved',
          resultScore: index === 1 ? '20' : '55',
          resultDetail: { source: 'competition_import', awardText: '铜奖', pointsSource: index === 1 ? 'sheet' : 'tier_rule' },
        },
      })
    }
    const reversed = await db.pointsLedgerEntry.findFirstOrThrow({ where: { userId: members[3].userId } })
    await scoring.reverseEntry(importer, reversed.id, '人工核实，撤销错误积分', null)
    const reversedCount = await db.pointsLedgerEntry.count({ where: { userId: members[3].userId } })

    runAwardBackfill()
    expect(await memberMonthPoints(members[0].userId, event.scoreMonth)).toBe(55)
    expect(await memberMonthPoints(members[1].userId, event.scoreMonth)).toBe(20)
    expect(await memberMonthPoints(members[2].userId, event.scoreMonth)).toBe(20)
    expect(await db.pointsLedgerEntry.count({ where: { userId: members[3].userId } })).toBe(reversedCount)
    const memberIds = members.map((member) => member.userId)
    const count = await db.pointsLedgerEntry.count({ where: { userId: { in: memberIds } } })
    const supplement = await db.pointsLedgerEntry.findFirstOrThrow({
      where: { sourceKey: `competition:${eventId}:${members[0].userId}:topup:55` },
    })
    expect(supplement).toMatchObject({ category: 'contest', scoreMonth: '2026-04' })
    const notice = { userId: members[0].userId, kind: 'points_change' }
    runAwardBackfill()
    expect(await db.auditLog.count({ where: { action: 'points.post', resourceId: supplement.id } })).toBe(1)
    expect(await db.userNotification.count({ where: notice })).toBe(1)
    const replay = await imports.commit(importer, { event, rows: [{ ...rows[0], awardText: '铜奖' }] })
    expect(replay).toMatchObject({ posted: 0, duplicate: 1, failed: 0 })
    expect(await db.pointsLedgerEntry.count({ where: { userId: { in: memberIds } } })).toBe(count)
  })

  it('导入团队按逐人结果扣除已有部分补差，人工审核团队只给原来已入账的队员补分', async () => {
    const event = { ...provincialEvent, title: '历史团队省赛', teamSize: 2 }
    const first = await createTestUser(db, { studentNo: '202608201' })
    const second = await createTestUser(db, { studentNo: '202608202' })
    const former = await createTestUser(db, { studentNo: '202608203' })
    const newcomer = await createTestUser(db, { studentNo: '202608204' })
    const withdrawn = await createTestUser(db, { studentNo: '202608205' })
    const rows = [
      { row: 2, studentNo: '202608201', teamName: '导入队', awardText: '参赛' },
      { row: 3, studentNo: '202608202', teamName: '导入队', awardText: '参赛' },
      { row: 4, studentNo: '202608203', teamName: '审核队', awardText: '参赛' },
      { row: 5, studentNo: '202608205', teamName: '审核队', awardText: '参赛' },
    ]
    const { event: { id: eventId } } = await imports.commit(importer, { event, rows })
    const imported = await db.teamCompetitionEntry.findFirstOrThrow({ where: { eventId, team: { name: '导入队' } } })
    await db.teamCompetitionEntry.update({
      where: { id: imported.id },
      data: {
        resultScore: '70', resultDetail: { source: 'competition_import', memberResults: [
          { userId: first.userId, points: '70', awardText: '银奖' },
          { userId: second.userId, points: '55', awardText: '铜奖' },
        ] },
      },
    })
    const base = await db.pointsLedgerEntry.findFirstOrThrow({ where: { userId: first.userId } })
    await scoring.postLedgerEntry(importer, {
      userId: first.userId, sourceKey: `${base.sourceKey}:topup:35`, amount: '15', category: 'award', scoreMonth,
      detail: { eventId, teamId: imported.teamId, previousTotal: '20', targetTotal: '35' },
      evidenceRef: `team_competition_entry:${imported.id}`,
    })

    const reviewed = await db.teamCompetitionEntry.findFirstOrThrow({ where: { eventId, team: { name: '审核队' } } })
    await db.teamCompetitionEntry.update({
      where: { id: reviewed.id }, data: { resultScore: '55', resultDetail: { tier: 'provincial', medal: 'bronze' } },
    })
    await db.pointsLedgerEntry.updateMany({
      where: { userId: former.userId }, data: { detail: { eventId, eventTitle: event.title, teamId: reviewed.teamId, tier: 'provincial', medal: null } },
    })
    const reviewedAt = reviewed.reviewedAt!.getTime()
    await db.teamMember.update({
      where: { teamId_userId: { teamId: reviewed.teamId, userId: former.userId } },
      data: { status: 'left', leftAt: new Date(reviewedAt + 1000) },
    })
    await db.teamMember.update({
      where: { teamId_userId: { teamId: reviewed.teamId, userId: withdrawn.userId } },
      data: { status: 'left', joinedAt: new Date(reviewedAt - 86400000), leftAt: new Date(reviewedAt - 1000) },
    })
    await db.teamMember.create({
      data: { id: crypto.randomUUID(), teamId: reviewed.teamId, userId: newcomer.userId, role: 'member', status: 'active' },
    })

    runAwardBackfill()
    const teamMembers = [first, second, former, newcomer, withdrawn]
    expect(await Promise.all(teamMembers.map((m) => memberMonthPoints(m.userId)))).toEqual([70, 55, 55, 0, 20])
    const payments = await db.pointsLedgerEntry.findMany({ where: { userId: first.userId }, orderBy: { amount: 'asc' } })
    expect(payments.map((payment) => Number(payment.amount))).toEqual([15, 20, 35])
    runAwardBackfill()
    const replay = await imports.commit(importer, { event, rows: [{ ...rows[0], awardText: '银奖' }, { ...rows[1], awardText: '铜奖' }] })
    expect(replay).toMatchObject({ posted: 0, duplicate: 2, failed: 0 })
    expect(await Promise.all(teamMembers.map((m) => memberMonthPoints(m.userId)))).toEqual([70, 55, 55, 0, 20])
  })
})
