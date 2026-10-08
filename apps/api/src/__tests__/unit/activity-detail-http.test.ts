import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { SessionActor } from '../../modules/auth/session.service.js'

// 使用 tsc 输出的 Nest 装饰器元数据，避免 Vitest 变换遗漏构造函数注入信息。
const { ActivityAdminController, ActivityUserController } = require('../../../dist/modules/activities/activity.controller.js')
const { ActivityService } = require('../../../dist/modules/activities/activity.service.js')
const { AttendanceService } = require('../../../dist/modules/attendance/attendance.service.js')
const { ContestStandingsService } = require('../../../dist/modules/activities/contest-standings.service.js')
const { PrismaService } = require('../../../dist/infrastructure/database/database.module.js')
const { SessionService } = require('../../../dist/modules/auth/session.service.js')

const activityId = '5719b631-53e9-43eb-8056-3041711d527f'
const fixture = {
  id: activityId, title: '管理活动草稿', status: 'draft', announcement: '活动详情公告',
  policy: { policy: 'QR_ONLY' }, venueBindings: [], venueVersion: null,
}
const findUnique = vi.fn()
const update = vi.fn()
const audit = { log: vi.fn() }
const db = {
  activity: { findUnique, update },
  pointsLedgerEntry: { findMany: vi.fn().mockResolvedValue([]) },
  // 讲题满意度区块：无获批讲题时提前返回，不再读取出勤口径
  lectureRequest: { findMany: vi.fn().mockResolvedValue([]) },
  // 签到墙
  attendanceCheckpoint: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
  $executeRaw: vi.fn(),
  $transaction: async (callback: (tx: unknown) => unknown) => callback(db),
}
let actor: SessionActor | null
let app: INestApplication

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [ActivityAdminController, ActivityUserController],
    providers: [
      { provide: ActivityService, useValue: new ActivityService(db, audit, {}, {}) },
      { provide: AttendanceService, useValue: {} },
      { provide: ContestStandingsService, useValue: {} },
      { provide: PrismaService, useValue: db },
      { provide: SessionService, useValue: { resolveActor: async () => actor } },
    ],
  }).compile()
  app = module.createNestApplication()
  await app.init()
})

beforeEach(() => {
  actor = {
    principalKind: 'system', principalId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
    authzVersion: 1, roles: ['presidium', 'system_admin'],
  }
  findUnique.mockReset().mockResolvedValue(fixture)
  update.mockReset().mockResolvedValue({ revision: 2, title: '已编辑草稿' })
  audit.log.mockReset()
})

afterAll(async () => { await app?.close() })

it.each(['system', 'staff'])('有活动管理权限的 %s 主体无需学生账号即可读取草稿详情', async (kind) => {
  actor!.principalKind = kind
  actor!.roles = ['activity_manager']
  const response = await request(app.getHttpServer()).get(`/api/v1/admin/activities/${activityId}`).expect(200)
  expect(response.body.data).toMatchObject(fixture)
  expect(findUnique.mock.calls[0][0].include).toMatchObject({
    registrations: false, participants: false, leaveRequests: false, remotePermissions: false, checkpoints: false,
  })
})

it('没有活动管理权限的成员被拒绝', async () => {
  actor!.roles = ['member']
  await request(app.getHttpServer()).get(`/api/v1/admin/activities/${activityId}`).expect(403)
  expect(findUnique).not.toHaveBeenCalled()
})

it('系统管理员拥有全部权限，可读取活动详情', async () => {
  actor!.roles = ['system_admin']
  await request(app.getHttpServer()).get(`/api/v1/admin/activities/${activityId}`).expect(200)
})

it('未登录仍返回 401，活动不存在返回 404', async () => {
  actor = null
  await request(app.getHttpServer()).get(`/api/v1/admin/activities/${activityId}`).expect(401)
  actor = { principalKind: 'system', principalId: crypto.randomUUID(), sessionId: crypto.randomUUID(), authzVersion: 1, roles: ['presidium'] }
  findUnique.mockResolvedValue(null)
  const missing = await request(app.getHttpServer()).get(`/api/v1/admin/activities/${activityId}`).expect(404)
  expect(missing.body.code).toBe('NOT_FOUND')
})

it('成员接口保留学生身份要求与本人记录过滤', async () => {
  await request(app.getHttpServer()).get(`/api/v1/activities/${activityId}`).expect(401)
  actor!.userId = crypto.randomUUID()
  actor!.studentNo = '202600001'
  actor!.roles = ['member']
  await request(app.getHttpServer()).get(`/api/v1/activities/${activityId}`).expect(200)
  expect(findUnique.mock.calls[0][0].include.registrations).toEqual({ where: { userId: actor!.userId } })
})

it('草稿 PATCH 接受有管理权限的本地管理员，校验版本并写审计', async () => {
  const venueVersionId = crypto.randomUUID()
  findUnique.mockResolvedValue({ ...fixture, revision: 1, startAt: new Date('2026-10-06T10:00:00Z'), endAt: new Date('2026-10-06T12:00:00Z'), venueVersionId, venueBindings: [{ venueVersionId }] })
  const result = await request(app.getHttpServer()).patch(`/api/v1/admin/activities/${activityId}`)
    .send({ expectedRevision: 1, title: '已编辑草稿' }).expect(200)
  expect(result.body.data.revision).toBe(2)
  expect(update.mock.calls[0][0].data.title).toBe('已编辑草稿')
  expect(audit.log.mock.calls[0][0]).toMatchObject({ action: 'activity.update', actorPrincipalId: actor!.principalId })
})

it('PATCH 拒绝无权限、缺少版本与修改状态等非白名单字段', async () => {
  actor!.roles = ['member']
  await request(app.getHttpServer()).patch(`/api/v1/admin/activities/${activityId}`).send({ expectedRevision: 1, title: '成员不可编辑' }).expect(403)
  actor!.roles = ['presidium']
  await request(app.getHttpServer()).patch(`/api/v1/admin/activities/${activityId}`).send({ title: '缺少版本' }).expect(400)
  await request(app.getHttpServer()).patch(`/api/v1/admin/activities/${activityId}`).send({ expectedRevision: 1, status: 'published' }).expect(400)
  expect(update).not.toHaveBeenCalled()
})

it('新建活动请求缺少地点时直接拒绝', async () => {
  const response = await request(app.getHttpServer()).post('/api/v1/admin/activities').send({
    type: 'training', title: '缺少地点活动', announcement: '应当在创建时校验',
    startAt: '2026-10-06T10:00:00Z', endAt: '2026-10-06T12:00:00Z',
  }).expect(400)
  expect(response.body.code).toBe('NO_VENUE')
})
