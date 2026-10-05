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
const registrationFindMany = vi.fn()
const participantFindMany = vi.fn()
const leaveFindMany = vi.fn()
const remoteFindMany = vi.fn()
const db = {
  activity: { findUnique },
  attendanceCheckpoint: { count, findMany },
  activityRegistration: { findMany: registrationFindMany },
  activityParticipant: { findMany: participantFindMany },
  leaveRequest: { findMany: leaveFindMany },
  remotePermission: { findMany: remoteFindMany },
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
  // select 含 acceptedAt 的是最近 24 位名单；仅取 userId 的是全量 IN 检查点（未到分栏差集用）
  findMany.mockReset().mockImplementation((args: { select?: Record<string, unknown> }) =>
    args.select && 'acceptedAt' in args.select
      ? Promise.resolve(Array.from({ length: 24 }, (_, i) => ({
          userId: `member-${i}`, acceptedAt: new Date('2026-10-06T10:00:00Z'), user: { verifiedRealName: `成员${i}` },
        })))
      : Promise.resolve([{ userId: 'u-1' }, { userId: 'u-9' }]))
  registrationFindMany.mockReset().mockResolvedValue([
    { userId: 'u-1', user: { verifiedRealName: '张一', studentNo: '202600001' } },
    { userId: 'u-2', user: { verifiedRealName: '张二', studentNo: '202600002' } },
    { userId: 'u-3', user: { verifiedRealName: '张三', studentNo: '202600003' } },
    { userId: 'u-4', user: { verifiedRealName: '张四', studentNo: '202600004' } },
  ])
  participantFindMany.mockReset().mockResolvedValue([
    { userId: 'u-3', user: { verifiedRealName: '张三', studentNo: '202600003' } },
    { userId: 'r-1', user: { verifiedRealName: '李必', studentNo: '202600009' } },
  ])
  leaveFindMany.mockReset().mockResolvedValue([{ userId: 'u-2' }])
  remoteFindMany.mockReset().mockResolvedValue([{ userId: 'u-9' }])
})
afterAll(async () => { await app?.close() })

it('大屏总人数覆盖全部检查点，报名/必到未到分栏排除已签到与已批请假或远程，支持无学生账号的管理主体', async () => {
  const response = await request(app.getHttpServer()).get(`/api/v1/admin/activities/${activityId}/attendance/board`).expect(200)
  expect(response.headers['cache-control']).toBe('private, no-store')
  expect(response.body.data).toMatchObject({ checkedIn: 75, checkedOut: 16, registeredTotal: 5, pendingTotal: 3 })
  expect(response.body.data.recentCheckins).toHaveLength(24)
  expect(response.body.data.recentCheckins[0]).toEqual({ userId: 'member-0', name: '成员0', acceptedAt: '2026-10-06T10:00:00.000Z' })
  // 未到 = 报名 4 人 ∪ 必到 1 人（u-3 重复计入一次）− 已签到 u-1 − 已批请假 u-2，按学号排序
  expect(response.body.data.pendingCheckins).toEqual([
    { userId: 'u-3', name: '张三', studentNo: '202600003' },
    { userId: 'u-4', name: '张四', studentNo: '202600004' },
    { userId: 'r-1', name: '李必', studentNo: '202600009' },
  ])
  expect(findMany.mock.calls[0][0]).toMatchObject({ where: { activityId, checkpoint: 'IN' }, take: 24 })
  expect(count.mock.calls.map(call => call[0].where)).toEqual([{ activityId, checkpoint: 'IN' }, { activityId, checkpoint: 'OUT' }])
  expect(registrationFindMany.mock.calls[0][0]).toMatchObject({ where: { activityId, status: 'enrolled' } })
  expect(participantFindMany.mock.calls[0][0]).toMatchObject({ where: { activityId, required: true } })
  expect(leaveFindMany.mock.calls[0][0]).toMatchObject({ where: { activityId, status: 'approved' } })
  expect(remoteFindMany.mock.calls[0][0]).toMatchObject({ where: { activityId, status: 'approved' } })
})

it('后续刷新返回新签到人数与最新成员，无记录时返回零人数', async () => {
  count.mockResolvedValueOnce(0).mockResolvedValueOnce(0)
  findMany.mockResolvedValueOnce([])
  registrationFindMany.mockResolvedValueOnce([])
  participantFindMany.mockResolvedValueOnce([])
  leaveFindMany.mockResolvedValueOnce([])
  remoteFindMany.mockResolvedValueOnce([])
  const empty = await request(app.getHttpServer()).get(`/api/v1/admin/activities/${activityId}/attendance/board`).expect(200)
  expect(empty.body.data).toMatchObject({ checkedIn: 0, checkedOut: 0, registeredTotal: 0, pendingTotal: 0, pendingCheckins: [], recentCheckins: [] })
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
  expect(registrationFindMany).not.toHaveBeenCalled()
  expect(participantFindMany).not.toHaveBeenCalled()
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
