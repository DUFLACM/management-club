import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { SessionActor } from '../../modules/auth/session.service.js'

// 使用编译后的 Nest 控制器和守卫，覆盖路由、参数装饰器及业务动作权限。
const { EvaluationMemberController } = require('../../../dist/modules/evaluation/evaluation.controller.js')
const { EvaluationService } = require('../../../dist/modules/evaluation/evaluation.service.js')
const { ScoringAdminController, ScoringMeController } = require('../../../dist/modules/scoring/scoring.controller.js')
const { ScoringService } = require('../../../dist/modules/scoring/scoring.service.js')
const { ActivityService } = require('../../../dist/modules/activities/activity.service.js')
const { ContestStandingsService } = require('../../../dist/modules/activities/contest-standings.service.js')
const { PrismaService } = require('../../../dist/infrastructure/database/database.module.js')
const { SessionService } = require('../../../dist/modules/auth/session.service.js')

const semester = {
  id: crypto.randomUUID(), code: '2025S', name: '2025 春季',
  startsOn: new Date('2025-02-01'), endsOn: new Date('2025-07-31'),
}
const member: SessionActor = {
  sessionId: crypto.randomUUID(), principalId: crypto.randomUUID(), principalKind: 'student',
  userId: crypto.randomUUID(), studentNo: '202500001', authzVersion: 1, roles: ['member'],
}
const db = {
  semester: {
    findMany: async () => [semester],
    findFirst: async () => semester,
    findUnique: async () => semester,
  },
  user: { findUnique: vi.fn(), findMany: async () => [] },
  membershipTerm: { findMany: async () => [] },
  pointsLedgerEntry: { findMany: async () => [] },
}
const scoring = new ScoringService(db, {}, {}, {})
const setBonusVisibility = vi.spyOn(scoring, 'setBonusVisibility')
let actor: SessionActor | null
let app: INestApplication

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [EvaluationMemberController, ScoringMeController, ScoringAdminController],
    providers: [
      { provide: EvaluationService, useValue: new EvaluationService(db, {}) },
      { provide: ScoringService, useValue: scoring },
      { provide: PrismaService, useValue: db },
      { provide: ActivityService, useValue: {} },
      { provide: ContestStandingsService, useValue: {} },
      { provide: SessionService, useValue: { resolveActor: async () => actor } },
    ],
  }).compile()
  app = module.createNestApplication()
  await app.init()
})
afterAll(async () => { await app?.close() })
beforeEach(() => {
  actor = null
  db.user.findUnique.mockReset().mockResolvedValue({ accountStatus: 'active', membershipTerms: [{ membershipStatus: 'formal' }] })
  setBonusVisibility.mockClear()
})

it.each([
  ['/api/v1/me/evaluation/semesters', { defaultSemesterId: semester.id }],
  [`/api/v1/me/evaluation/semesters/${semester.id}/leaderboard`, { rows: [] }],
  [`/api/v1/me/bonus-records?semesterId=${semester.id}`, { items: [] }],
] as const)('%s 仅对已登录的在册成员开放', async (path, expected) => {
  const http = request(app.getHttpServer())
  await http.get(path).expect(401)
  actor = { ...member, principalKind: 'staff', userId: undefined, roles: ['system_admin'] }
  await http.get(path).expect(401)
  actor = member
  db.user.findUnique.mockResolvedValueOnce({ accountStatus: 'active', membershipTerms: [{ membershipStatus: 'withdrawn' }] })
  await http.get(path).expect(403)
  const response = await http.get(path).expect(200)
  expect(response.body.data).toMatchObject(expected)
})

it('更改加分公示状态要求积分审核权限', async () => {
  const id = crypto.randomUUID()
  const path = `/api/v1/admin/ledger-entries/${id}/bonus-visibility`
  const http = request(app.getHttpServer())
  await http.patch(path).send({ visible: false }).expect(401)
  actor = member
  await http.patch(path).send({ visible: false }).expect(403)
  expect(setBonusVisibility).not.toHaveBeenCalled()
  actor = { ...member, roles: ['points_reviewer'] }
  setBonusVisibility.mockResolvedValueOnce({ id, visible: false })
  const response = await http.patch(path).send({ visible: false }).expect(200)
  expect(response.body.data).toEqual({ id, visible: false })
  expect(setBonusVisibility).toHaveBeenCalledWith(actor, id, false)
})
