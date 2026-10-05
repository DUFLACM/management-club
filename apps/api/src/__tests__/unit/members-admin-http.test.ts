import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { SessionActor } from '../../modules/auth/session.service.js'

// 使用 tsc 输出的 Nest 装饰器元数据，避免 Vitest 变换遗漏构造函数注入信息。
const { MembersAdminController } = require('../../../dist/modules/members/members.controller.js')
const { MembersService } = require('../../../dist/modules/members/members.service.js')
const { PrismaService } = require('../../../dist/infrastructure/database/database.module.js')
const { SessionService } = require('../../../dist/modules/auth/session.service.js')

const userId = '6f19c0de-1111-4111-8111-111111111111'
const accountId = '7e20d1ef-2222-4222-8222-222222222222'
const db = {}
const setMembership = vi.fn()
const updateMemberPlatformAccount = vi.fn()
const revokeMemberPlatformAccount = vi.fn()
const members = { setMembership, updateMemberPlatformAccount, revokeMemberPlatformAccount }
let actor: SessionActor | null
let app: INestApplication

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [MembersAdminController],
    providers: [
      { provide: MembersService, useValue: members },
      { provide: PrismaService, useValue: db },
      { provide: SessionService, useValue: { resolveActor: async () => actor } },
    ],
  }).compile()
  app = module.createNestApplication()
  await app.init()
})

beforeEach(() => {
  actor = { principalKind: 'staff', principalId: crypto.randomUUID(), sessionId: crypto.randomUUID(), authzVersion: 1, roles: ['presidium'] }
  setMembership.mockReset().mockResolvedValue(undefined)
  updateMemberPlatformAccount.mockReset().mockResolvedValue(undefined)
  revokeMemberPlatformAccount.mockReset().mockResolvedValue(undefined)
})
afterAll(async () => { await app?.close() })

it('presidium 直接调整身份：透传 status/reason 并返回 updated', async () => {
  const response = await request(app.getHttpServer())
    .post(`/api/v1/admin/members/${userId}/membership`)
    .send({ status: 'formal', reason: '评定会议决议：竞赛成绩达标' })
    .expect(201)
  expect(response.body.data).toEqual({ updated: true })
  expect(setMembership).toHaveBeenCalledTimes(1)
  expect(setMembership).toHaveBeenCalledWith(actor, userId, 'formal', '评定会议决议：竞赛成绩达标')
})

it.each([
  ['未知身份', { status: 'vip', reason: '原因长度足够的测试文案' }],
  ['原因过短', { status: 'formal', reason: '短' }],
  ['缺 status', { reason: '原因长度足够的测试文案' }],
])('%s 返回 400 且不触达服务', async (_name, payload) => {
  await request(app.getHttpServer()).post(`/api/v1/admin/members/${userId}/membership`).send(payload).expect(400)
  expect(setMembership).not.toHaveBeenCalled()
})

it.each([['activity_manager'], ['advisor'], ['member']])('无 members.manage 的 %j 不能调整身份或平台绑定', async (...roles) => {
  actor!.roles = roles
  await request(app.getHttpServer()).post(`/api/v1/admin/members/${userId}/membership`).send({ status: 'formal', reason: '原因长度足够的测试文案' }).expect(403)
  await request(app.getHttpServer()).post(`/api/v1/admin/members/${userId}/platform-accounts/${accountId}`).send({ externalId: 'tourist123' }).expect(403)
  await request(app.getHttpServer()).post(`/api/v1/admin/members/${userId}/platform-accounts/${accountId}/revoke`).expect(403)
  expect(setMembership).not.toHaveBeenCalled()
  expect(updateMemberPlatformAccount).not.toHaveBeenCalled()
  expect(revokeMemberPlatformAccount).not.toHaveBeenCalled()
})

it('更改平台绑定账号：校验 accountId UUID 与 externalId 长度后透传', async () => {
  const response = await request(app.getHttpServer())
    .post(`/api/v1/admin/members/${userId}/platform-accounts/${accountId}`)
    .send({ externalId: 'tourist123', displayHandle: 'Tourist123' })
    .expect(201)
  expect(response.body.data).toEqual({ updated: true })
  expect(updateMemberPlatformAccount).toHaveBeenCalledTimes(1)
  expect(updateMemberPlatformAccount).toHaveBeenCalledWith(actor, userId, accountId, { externalId: 'tourist123', displayHandle: 'Tourist123' })
  await request(app.getHttpServer()).post(`/api/v1/admin/members/${userId}/platform-accounts/not-a-uuid`).send({ externalId: 'tourist123' }).expect(400)
  await request(app.getHttpServer()).post(`/api/v1/admin/members/${userId}/platform-accounts/${accountId}`).send({ externalId: 'x' }).expect(400)
  expect(updateMemberPlatformAccount).toHaveBeenCalledTimes(1)
})

it('解绑平台账号：无 body 也要校验权限并透传路径参数', async () => {
  const response = await request(app.getHttpServer())
    .post(`/api/v1/admin/members/${userId}/platform-accounts/${accountId}/revoke`)
    .expect(201)
  expect(response.body.data).toEqual({ revoked: true })
  expect(revokeMemberPlatformAccount).toHaveBeenCalledTimes(1)
  expect(revokeMemberPlatformAccount).toHaveBeenCalledWith(actor, userId, accountId)
})

it('匿名请求返回 401，非法成员编号返回 400', async () => {
  actor = null
  await request(app.getHttpServer()).post(`/api/v1/admin/members/${userId}/membership`).send({ status: 'formal', reason: '原因长度足够的测试文案' }).expect(401)
  actor = { principalKind: 'staff', principalId: crypto.randomUUID(), sessionId: crypto.randomUUID(), authzVersion: 1, roles: ['presidium'] }
  await request(app.getHttpServer()).post('/api/v1/admin/members/not-a-uuid/membership').send({ status: 'formal', reason: '原因长度足够的测试文案' }).expect(400)
  expect(setMembership).not.toHaveBeenCalled()
})
