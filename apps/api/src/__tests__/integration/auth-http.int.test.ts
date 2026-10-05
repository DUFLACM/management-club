import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Test } from '@nestjs/testing'
import { HttpException, type INestApplication, type ArgumentsHost } from '@nestjs/common'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { ensureTestDatabase, TEST_URL } from './setup.js'
import { sha256Hex } from '../../common/utils.js'

process.env.DATABASE_URL = TEST_URL
let app: INestApplication
let db: PrismaService

beforeAll(async () => {
  ensureTestDatabase()
  // 使用真实 tsc 装饰器元数据；Vitest 的源代码变换不生成 Nest constructor metadata。
  const { AppModule } = require('../../../dist/app.module.js')
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = module.createNestApplication()
  app.use(cookieParser())
  app.useGlobalFilters({
    catch(exception: unknown, host: ArgumentsHost) {
      const response = host.switchToHttp().getResponse()
      const status = exception instanceof HttpException ? exception.getStatus() : 500
      const body = exception instanceof HttpException ? exception.getResponse() : { code: 'INTERNAL', message: '服务器内部错误' }
      response.status(status).json({ error: body })
    },
  })
  await app.init()
  db = new PrismaService(TEST_URL)
})

afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
})

describe('真实 HTTP 认证与 CSRF 请求头', () => {
  it('匿名浏览器仅发送 X-Clubs-Csrf 即可发起 CAS，缺少 token 为稳定 403', async () => {
    const agent = request.agent(app.getHttpServer())
    const csrf = await agent.get('/api/v1/auth/csrf').expect(200)
    const started = await agent.post('/api/v1/auth/cas/start')
      .set('Origin', 'http://localhost:5173').set('X-Clubs-Csrf', csrf.body.data.token).send({}).expect(200)
    expect(new URL(started.body.data.redirectUrl).pathname).toBe('/api/v1/dev-cas/login')
    const missing = await agent.post('/api/v1/auth/cas/start').send({}).expect(403)
    expect(missing.body.error.code).toBe('CSRF_INVALID')
  })

  it('邀请交换与注册完成接受同一请求头；业务拒绝返回稳定错误', async () => {
    const invitationId = crypto.randomUUID()
    const invitationCode = 'ABCDEFGHJKMN'
    await db.invitation.create({ data: { id: invitationId, tokenHash: sha256Hex(invitationCode), batchLabel: 'HTTP 回归测试', purpose: 'registration', maxUses: 1, expiresAt: new Date(Date.now() + 3600_000), createdBy: crypto.randomUUID() } })
    const agent = request.agent(app.getHttpServer())
    const csrf = await agent.get('/api/v1/auth/csrf').expect(200)
    const exchanged = await agent.post('/api/v1/auth/invitations/exchange')
      .set('X-Clubs-Csrf', csrf.body.data.token).send({ code: invitationCode }).expect(200)
    expect(exchanged.body.data.intentId).toBeTruthy()
    expect((await db.invitation.findUnique({ where: { id: invitationId } }))?.usedCount).toBe(0)
    const preregToken = 'http-regression-preregister'
    await db.registrationIntent.update({ where: { id: exchanged.body.data.intentId }, data: { status: 'cas_verified', casSubject: 'dev-202607001', studentNo: '202607001', realName: 'HTTP 测试成员', anonymousCookieHash: sha256Hex(preregToken) } })
    const csrfCookie = csrf.headers['set-cookie'][0].split(';')[0]
    const completed = await agent.post('/api/v1/auth/register/complete')
      .set('Cookie', `${csrfCookie}; club_session_reg=${preregToken}`).set('X-Clubs-Csrf', csrf.body.data.token)
      .send({ grade: 2026 }).expect(200)
    expect(completed.body.data.ok).toBe(true)
    expect((await db.invitation.findUnique({ where: { id: invitationId } }))?.usedCount).toBe(1)
    const invalid = await agent.post('/api/v1/auth/invitations/exchange')
      .set('X-Clubs-Csrf', csrf.body.data.token).send({ code: 'INVALID' }).expect(400)
    expect(invalid.body.error.code).toBe('INVITE_FORMAT')
  })
})
