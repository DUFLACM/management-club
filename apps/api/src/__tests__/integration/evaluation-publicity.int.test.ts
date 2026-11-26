import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { SessionActor } from '../../modules/auth/session.service.js'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { monthKey } from '../../common/utils.js'
import { createTestUser, makeActor } from './helpers.js'
import { ensureTestDatabase } from './setup.js'

// HTTP 使用编译后的 Nest 装饰器元数据。只有会话解析使用测试身份，批次写入、榜单与事务均使用 PostgreSQL。
const { EvaluationAdminController, EvaluationMemberController, EvaluationPublicController } = require('../../../dist/modules/evaluation/evaluation.controller.js')
const { EvaluationService } = require('../../../dist/modules/evaluation/evaluation.service.js')
const { SessionService } = require('../../../dist/modules/auth/session.service.js')
const actors = new Map<string, SessionActor>([['admin', makeActor({ principalKind: 'staff' })]])
const adminPath = '/api/v1/admin/evaluation/batches'
let app: INestApplication
let db: PrismaService

beforeAll(async () => {
  db = new PrismaService(ensureTestDatabase())
  const module = await Test.createTestingModule({
    controllers: [EvaluationAdminController, EvaluationMemberController, EvaluationPublicController],
    providers: [
      { provide: EvaluationService, useValue: new EvaluationService(db, new AuditService(db)) },
      { provide: SessionService, useValue: { resolveActor: (req: { headers: Record<string, string> }) => actors.get(req.headers['x-fixture-actor']) ?? null } },
    ],
  }).compile()
  app = module.createNestApplication()
  await app.init()
})

afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
})

async function newSemester(code: string) {
  const day = 86_400_000
  return db.semester.create({ data: {
    id: crypto.randomUUID(), code, name: code, startsOn: new Date(Date.now() - 31 * day), endsOn: new Date(Date.now() + day),
  } })
}

async function generate(semesterId: string): Promise<string> {
  const res = await request(app.getHttpServer()).post(adminPath).set('x-fixture-actor', 'admin').send({ semesterId }).expect(201)
  return res.body.data.batchId
}

async function edit(batchId: string, userId: string, values: Record<string, unknown>) {
  const row = await db.evaluationRow.findUniqueOrThrow({ where: { batchId_userId: { batchId, userId } } })
  await request(app.getHttpServer()).post(`${adminPath}/${batchId}/rows/${row.id}`).set('x-fixture-actor', 'admin')
    .send({ ...values, reason: '人工复核结果' }).expect(201)
}

async function board(semesterId: string, actor?: string) {
  const path = `/api/v1/${actor ? 'me' : 'public'}/evaluation/semesters/${semesterId}/leaderboard`
  const response = await request(app.getHttpServer()).get(path).set('x-fixture-actor', actor ?? '').expect(200)
  return response.body.data
}

it('人工保存后普通成员与干部公示同步，实名与脱敏视图共用结果，生成、刷新和旧发布操作不切换来源', async () => {
  const http = request(app.getHttpServer())
  const { id: semesterId } = await newSemester('BOARD')
  const people = []
  for (const [i, name] of ['江明', '张晴', '李言', '余夏', '赵宁'].entries()) {
    people.push(await createTestUser(db, { name, studentNo: `20261100${i}`, semesterId }))
  }
  const [first, second, cadre, unscoredCadre, excluded] = people
  actors.set('cadre', { ...cadre.actor, roles: ['member'] })
  await db.roleGrant.createMany({ data: [cadre, unscoredCadre].map((u) => ({
    id: crypto.randomUUID(), principalId: u.principalId, role: 'presidium', grantedBy: u.principalId,
  })) })
  await db.userProfile.update({ where: { userId: cadre.userId }, data: { displayName: '羽衣', visibility: 'public_opt_in' } })
  await db.membershipTerm.updateMany({ where: { userId: excluded.userId }, data: { membershipStatus: 'withdrawn' } })
  actors.set('withdrawn', { ...excluded.actor, roles: ['member'] })
  await db.pointsLedgerEntry.create({ data: {
    id: crypto.randomUUID(), userId: first.userId, amount: 5, category: 'activity',
    scoreMonth: monthKey(new Date()), recordedAt: new Date(), status: 'approved', sourceKey: 'fixture:attendance',
  } })

  const live = await board(semesterId)
  expect(live).toMatchObject({ source: 'live', adjustedAt: null, rows: [{ displayName: '江同学', rank: 1 }, { displayName: '张同学', rank: 2 }] })
  expect(live.cadres).toEqual([{ displayName: '羽衣', suggestedScore: null }, { displayName: '余同学', suggestedScore: null }])
  const a = await generate(semesterId)
  const b = await generate(semesterId)
  await http.post(`${adminPath}/${b}/publish`).set('x-fixture-actor', 'admin').expect(201)
  await db.evaluationBatch.update({ where: { id: b }, data: { status: 'published' } }) // 老版本已发布的批次
  expect(await board(semesterId)).toEqual(live)

  // 最后修改的是 A，虽然 B 生成及标记发布时间更晚，A 的最终加分、排名和干部名单仍须整体一致。
  await edit(a, second.userId, { pointsStd: 100, contestStd: 100, serviceStd: 100, score: 0.875 })
  await edit(a, cadre.userId, { score: 0 })
  await edit(a, excluded.userId, { score: 4, excludeReason: '含私人情况的排除说明' })
  for (const action of ['recompute', 'refresh', 'publish']) {
    await http.post(`${adminPath}/${b}/${action}`).set('x-fixture-actor', 'admin').expect(201)
  }
  const adjusted = await board(semesterId)
  expect(adjusted.source).toBe('adjusted')
  expect(new Date(adjusted.adjustedAt).getTime()).toBeGreaterThan(0)
  expect(adjusted.rows).toEqual([
    { displayName: '张同学', rank: 1, tier: 'A', hScore: 100, suggestedScore: 0.875, needsManual: false },
    { displayName: '江同学', rank: 2, tier: 'C', hScore: 70, suggestedScore: 0.5, needsManual: false },
  ])
  expect(adjusted.cadres).toEqual([{ displayName: '羽衣', suggestedScore: 0 }, { displayName: '余同学', suggestedScore: null }])
  const named = await board(semesterId, 'cadre')
  expect(named).toEqual({
    ...adjusted,
    rows: adjusted.rows.map((r: object, i: number) => ({ ...r, displayName: ['张晴', '江明'][i], isMe: false })),
    cadres: [{ displayName: '羽衣（李言）', suggestedScore: 0, isMe: true }, { displayName: '余夏', suggestedScore: null, isMe: false }],
  })
  const namesUrl = `/api/v1/me/evaluation/semesters/${semesterId}/leaderboard`
  await http.get(namesUrl).expect(401)
  await http.get(namesUrl).set('x-fixture-actor', 'withdrawn').expect(403)

  await edit(b, first.userId, { cadre: true, score: 1.25 })
  const switched = await board(semesterId)
  expect(switched.rows).toMatchObject([{ displayName: '张同学', rank: 1, tier: 'A' }])
  expect(switched.cadres).toEqual([
    { displayName: '江同学', suggestedScore: 1.25 }, { displayName: '羽衣', suggestedScore: null }, { displayName: '余同学', suggestedScore: null },
  ])
  const otherTerm = await newSemester('OTHER-BOARD')
  const other = await generate(otherTerm.id)
  await edit(other, first.userId, { score: 3 })
  expect(await board(semesterId)).toEqual(switched)
  const testBatch = await generate(semesterId)
  await db.evaluationBatch.update({ where: { id: testBatch }, data: { isTest: true } })
  await edit(testBatch, first.userId, { score: 5 })
  expect(await board(semesterId)).toEqual(switched)

  const adminBatches = (await http.get(adminPath).set('x-fixture-actor', 'admin').expect(200)).body.data
  expect(adminBatches.filter((batch: { isPublicSource: boolean }) => batch.isPublicSource)
    .map((batch: { id: string }) => batch.id).sort()).toEqual([b, other].sort())
  const detail = await http.get(`${adminPath}/${b}`).set('x-fixture-actor', 'admin').expect(200)
  expect(detail.body.data.batch).toMatchObject({ isPublicSource: true, adjustedAt: switched.adjustedAt })

  // 同一毫秒修改时两种榜单必须稳定地指向同一份快照。
  await db.evaluationRow.updateMany({ where: { batchId: { in: [a, b] }, overrideAt: { not: null } }, data: { overrideAt: new Date() } })
  const expectedCadreScore = a > b ? 0 : null
  expect((await board(semesterId)).cadres.find((r: { displayName: string }) => r.displayName === '羽衣').suggestedScore).toBe(expectedCadreScore)
  expect((await board(semesterId, 'cadre')).cadres.find((r: { isMe: boolean }) => r.isMe).suggestedScore).toBe(expectedCadreScore)

  await Promise.all([edit(a, second.userId, { score: 0.123 }), edit(b, second.userId, { score: 0.456 })])
  const saves = await db.evaluationRow.findMany({
    where: { batchId: { in: [a, b] }, userId: second.userId },
    orderBy: { overrideAt: 'desc' }, select: { overrideAt: true, overrideScore: true },
  })
  expect(saves[0].overrideAt!.getTime()).toBeGreaterThan(saves[1].overrideAt!.getTime())
  expect((await board(semesterId)).rows[0].suggestedScore).toBe(Number(saves[0].overrideScore))
  expect((await board(semesterId, 'cadre')).rows[0].suggestedScore).toBe(Number(saves[0].overrideScore))
  for (const id of [a, b]) await http.delete(`${adminPath}/${id}`).set('x-fixture-actor', 'admin').expect(200)
  expect(await board(semesterId)).toEqual(live)
})
