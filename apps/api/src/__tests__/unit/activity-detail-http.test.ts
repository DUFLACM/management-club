import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { SessionActor } from '../../modules/auth/session.service.js'

// 使用 tsc 输出的 Nest 装饰器元数据，避免 Vitest 变换遗漏构造函数注入信息。
const { ActivityAdminController, ActivityUserController } = require('../../../dist/modules/activities/activity.controller.js')
const { ActivityService } = require('../../../dist/modules/activities/activity.service.js')
const { AttendanceService } = require('../../../dist/modules/attendance/attendance.service.js')
const { PrismaService } = require('../../../dist/infrastructure/database/database.module.js')
const { SessionService } = require('../../../dist/modules/auth/session.service.js')

const activityId = '5719b631-53e9-43eb-8056-3041711d527f'
const fixture = {
  id: activityId, title: '管理活动草稿', status: 'draft', announcement: '活动详情公告',
  policy: { policy: 'QR_ONLY' }, venueBindings: [], venueVersion: null,
}
const findUnique = vi.fn()
const db = { activity: { findUnique } }
let actor: SessionActor | null
let app: INestApplication

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [ActivityAdminController, ActivityUserController],
    providers: [
      { provide: ActivityService, useValue: new ActivityService(db, {}, {}, {}) },
      { provide: AttendanceService, useValue: {} },
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

it.each([['member'], ['system_admin']])('没有活动管理权限的 %j 被拒绝', async (...roles) => {
  actor!.roles = roles
  await request(app.getHttpServer()).get(`/api/v1/admin/activities/${activityId}`).expect(403)
  expect(findUnique).not.toHaveBeenCalled()
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
