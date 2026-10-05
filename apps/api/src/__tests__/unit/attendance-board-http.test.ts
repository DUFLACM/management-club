import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { SessionActor } from '../../modules/auth/session.service.js'

const { AttendanceAdminController } = require('../../../dist/modules/attendance/attendance.admin.controller.js')
const { AttendanceService } = require('../../../dist/modules/attendance/attendance.service.js')
const { PrismaService } = require('../../../dist/infrastructure/database/database.module.js')
const { AuditService } = require('../../../dist/infrastructure/audit/audit.service.js')
const { SessionService } = require('../../../dist/modules/auth/session.service.js')
const { NoStoreInterceptor } = require('../../../dist/common/guards.js')

const activityId = '5719b631-53e9-43eb-8056-3041711d527f'
const findUnique = vi.fn()
const count = vi.fn()
const findMany = vi.fn()
const db = {
  activity: { findUnique },
  attendanceCheckpoint: { count, findMany },
  $transaction: async (queries: Promise<unknown>[]) => Promise.all(queries),
}
let actor: SessionActor | null
let app: INestApplication

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [AttendanceAdminController],
    providers: [
      { provide: AttendanceService, useValue: {} },
      { provide: PrismaService, useValue: db },
      { provide: AuditService, useValue: {} },
      { provide: SessionService, useValue: { resolveActor: async () => actor } },
    ],
  }).compile()
  app = module.createNestApplication()
  app.useGlobalInterceptors(new NoStoreInterceptor())
  await app.init()
})

beforeEach(() => {
  actor = { principalKind: 'staff', principalId: crypto.randomUUID(), sessionId: crypto.randomUUID(), authzVersion: 1, roles: ['activity_manager'] }
  findUnique.mockReset().mockResolvedValue({ id: activityId })
  count.mockReset().mockImplementation(({ where }) => Promise.resolve(where.checkpoint === 'IN' ? 75 : 16))
  findMany.mockReset().mockResolvedValue(Array.from({ length: 24 }, (_, i) => ({
    userId: `member-${i}`, acceptedAt: new Date('2026-10-06T10:00:00Z'), user: { verifiedRealName: `成员${i}` },
  })))
})
afterAll(async () => { await app?.close() })

it('大屏总人数覆盖全部检查点，最近名单仅包含姓名与签到时间，支持无学生账号的管理主体', async () => {
  const response = await request(app.getHttpServer()).get(`/api/v1/admin/activities/${activityId}/attendance/board`).expect(200)
  expect(response.headers['cache-control']).toBe('private, no-store')
  expect(response.body.data).toMatchObject({ checkedIn: 75, checkedOut: 16 })
  expect(response.body.data.recentCheckins).toHaveLength(24)
  expect(response.body.data.recentCheckins[0]).toEqual({ userId: 'member-0', name: '成员0', acceptedAt: '2026-10-06T10:00:00.000Z' })
  expect(findMany.mock.calls[0][0]).toMatchObject({ where: { activityId, checkpoint: 'IN' }, take: 24 })
  expect(count.mock.calls.map(call => call[0].where)).toEqual([{ activityId, checkpoint: 'IN' }, { activityId, checkpoint: 'OUT' }])
})

it('后续刷新返回新签到人数与最新成员，无记录时返回零人数', async () => {
  count.mockResolvedValueOnce(0).mockResolvedValueOnce(0)
  findMany.mockResolvedValueOnce([])
  const empty = await request(app.getHttpServer()).get(`/api/v1/admin/activities/${activityId}/attendance/board`).expect(200)
  expect(empty.body.data).toMatchObject({ checkedIn: 0, checkedOut: 0, recentCheckins: [] })
  count.mockImplementation(({ where }) => Promise.resolve(where.checkpoint === 'IN' ? 1 : 0))
  findMany.mockResolvedValue([{ userId: 'new-member', acceptedAt: new Date('2026-10-06T10:01:00Z'), user: { verifiedRealName: null } }])
  const updated = await request(app.getHttpServer()).get(`/api/v1/admin/activities/${activityId}/attendance/board`).expect(200)
  expect(updated.body.data).toMatchObject({ checkedIn: 1, checkedOut: 0, recentCheckins: [{ userId: 'new-member', name: '成员' }] })
})

it.each([['member'], ['points_reviewer'], ['system_admin']])('无现场码权限的 %j 无法读取大屏名单', async (...roles) => {
  actor!.roles = roles
  await request(app.getHttpServer()).get(`/api/v1/admin/activities/${activityId}/attendance/board`).expect(403)
  expect(count).not.toHaveBeenCalled()
  expect(findMany).not.toHaveBeenCalled()
})

it('匿名、非法活动编号与不存在的活动分别返回 401、400、404', async () => {
  actor = null
  await request(app.getHttpServer()).get(`/api/v1/admin/activities/${activityId}/attendance/board`).expect(401)
  actor = { principalKind: 'system', principalId: crypto.randomUUID(), sessionId: crypto.randomUUID(), authzVersion: 1, roles: ['presidium'] }
  await request(app.getHttpServer()).get('/api/v1/admin/activities/not-a-uuid/attendance/board').expect(400)
  findUnique.mockResolvedValue(null)
  const response = await request(app.getHttpServer()).get(`/api/v1/admin/activities/${activityId}/attendance/board`).expect(404)
  expect(response.body.code).toBe('NOT_FOUND')
  expect(count).not.toHaveBeenCalled()
})
