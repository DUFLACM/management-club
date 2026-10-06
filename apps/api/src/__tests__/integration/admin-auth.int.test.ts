import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Request, Response } from 'express'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { SessionService } from '../../modules/auth/session.service.js'
import { AdminAuthService } from '../../modules/auth/admin-auth.service.js'
import { hashAdminSecret } from '../../modules/auth/admin-auth.crypto.js'
import { ensureTestDatabase, TEST_URL } from './setup.js'

process.env.DATABASE_URL = TEST_URL

const USERNAME = 'root.admin'
const PASSWORD = 'test-password-with-entropy-2026'
const ACCESS_SECRET = 'test-entry-secret-with-entropy'

let db: PrismaService
let sessions: SessionService
let adminAuth: AdminAuthService
let principalId: string

function captureRes(): Response & { captured: Record<string, string>; cleared: string[] } {
  const captured: Record<string, string> = {}
  const cleared: string[] = []
  return {
    captured,
    cleared,
    cookie(name: string, value: string) { captured[name] = value },
    clearCookie(name: string) { cleared.push(name); delete captured[name] },
  } as never
}

function request(jar: Record<string, string>, csrfToken?: string): Request {
  return {
    cookies: { ...jar },
    headers: { ...(csrfToken ? { 'x-clubs-csrf': csrfToken } : {}), origin: 'http://localhost:5173', 'user-agent': 'integration-test' },
    ip: '127.0.0.77',
    socket: { remoteAddress: '127.0.0.77' },
  } as never
}

async function primeCsrf(): Promise<{ token: string; jar: Record<string, string> }> {
  const jar: Record<string, string> = {}
  const res = captureRes()
  const { token } = await sessions.issueAnonymousCsrf(request(jar), res)
  Object.assign(jar, res.captured)
  return { token, jar }
}

function absorb(jar: Record<string, string>, res: ReturnType<typeof captureRes>): void {
  Object.assign(jar, res.captured)
}

function answerFromSvg(svg: string): string {
  return Array.from(svg.matchAll(/<text[^>]*>([^<])<\/text>/g), (match) => match[1]).join('')
}

async function openGate(jar: Record<string, string>, token: string, secret = ACCESS_SECRET): Promise<void> {
  const res = captureRes()
  await adminAuth.openGate(request(jar, token), res, secret, token)
  absorb(jar, res)
}

beforeAll(async () => {
  const url = ensureTestDatabase()
  db = new PrismaService(url)
  const audit = new AuditService(db)
  sessions = new SessionService(db)
  adminAuth = new AdminAuthService(db, sessions, audit)
  principalId = crypto.randomUUID()
  const [passwordHash, secretHash] = await Promise.all([hashAdminSecret(PASSWORD), hashAdminSecret(ACCESS_SECRET)])
  await db.$transaction(async (tx) => {
    await tx.principal.create({ data: { id: principalId, kind: 'system' } })
    await tx.adminCredential.create({
      data: { id: crypto.randomUUID(), principalId, username: USERNAME, displayName: '本地管理员', passwordHash },
    })
    await tx.adminAccessSecret.create({ data: { key: 'primary', secretHash } })
    for (const role of ['presidium', 'system_admin']) {
      await tx.roleGrant.create({ data: { id: crypto.randomUUID(), principalId, role, grantedBy: principalId } })
    }
  })
})

afterAll(async () => {
  await db.$disconnect()
})

describe('独立管理员认证', () => {
  it('密语 gate → 单次验证码 → 账密登录建立 system 会话', async () => {
    const { token, jar } = await primeCsrf()
    await openGate(jar, token)
    const captcha = await adminAuth.createCaptcha(request(jar, token), token)
    const answer = answerFromSvg(captcha.svg)
    expect(answer).toHaveLength(5)
    const loginRes = captureRes()
    const result = await adminAuth.login(request(jar, token), loginRes, {
      username: USERNAME.toUpperCase(), password: PASSWORD, challengeId: captcha.challengeId, captcha: answer, csrfToken: token,
    })
    expect(result).toMatchObject({ principalId })
    expect(result.roles).toEqual(expect.arrayContaining(['presidium', 'system_admin']))
    const sessionToken = loginRes.captured[sessions.cookieName()]
    expect(sessionToken).toBeTruthy()
    const actor = await sessions.resolveActor(request({ [sessions.cookieName()]: sessionToken }))
    expect(actor).toMatchObject({ principalId, principalKind: 'system', realName: '本地管理员' })
    expect(actor?.roles).toEqual(expect.arrayContaining(['presidium', 'system_admin']))
  })

  it('验证码答案无论成败都单次消费', async () => {
    const { token, jar } = await primeCsrf()
    await openGate(jar, token)
    const captcha = await adminAuth.createCaptcha(request(jar, token), token)
    const answer = answerFromSvg(captcha.svg)
    const wrong = answer === 'AAAAA' ? 'BBBBB' : 'AAAAA'
    await expect(adminAuth.login(request(jar, token), captureRes(), {
      username: USERNAME, password: PASSWORD, challengeId: captcha.challengeId, captcha: wrong, csrfToken: token,
    })).rejects.toMatchObject({ code: 'ADMIN_CAPTCHA_INVALID' })
    await expect(adminAuth.login(request(jar, token), captureRes(), {
      username: USERNAME, password: PASSWORD, challengeId: captcha.challengeId, captcha: answer, csrfToken: token,
    })).rejects.toMatchObject({ code: 'ADMIN_CAPTCHA_INVALID' })
  })

  it('密语失败并发累计不产生唯一键 500，达阈值后持久限流', async () => {
    const { token, jar } = await primeCsrf()
    const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => adminAuth.openGate(request(jar, token), captureRes(), 'wrong-secret', token)))
    expect(attempts.every((attempt) => attempt.status === 'rejected' && (attempt.reason as { code?: string }).code === 'ADMIN_GATE_INVALID')).toBe(true)
    const throttle = await db.adminAuthThrottle.findFirst({ where: { scope: 'gate' } })
    expect(throttle?.failedCount).toBe(5)
    expect(throttle?.blockedUntil && throttle.blockedUntil > new Date()).toBe(true)
    await expect(adminAuth.openGate(request(jar, token), captureRes(), ACCESS_SECRET, token)).rejects.toMatchObject({ code: 'ADMIN_AUTH_THROTTLED' })
    await db.adminAuthThrottle.deleteMany({ where: { scope: 'gate' } })
  })

  it('密码连续失败会锁定账号', async () => {
    await db.adminAuthThrottle.deleteMany({ where: { scope: 'login' } })
    const { token, jar } = await primeCsrf()
    await openGate(jar, token)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const captcha = await adminAuth.createCaptcha(request(jar, token), token)
      await expect(adminAuth.login(request(jar, token), captureRes(), {
        username: USERNAME, password: 'wrong-password-value', challengeId: captcha.challengeId,
        captcha: answerFromSvg(captcha.svg), csrfToken: token,
      })).rejects.toMatchObject({ code: 'ADMIN_CREDENTIAL_INVALID' })
    }
    const credential = await db.adminCredential.findUnique({ where: { username: USERNAME } })
    expect(credential?.lockedUntil && credential.lockedUntil > new Date()).toBe(true)
    await db.adminCredential.update({ where: { username: USERNAME }, data: { failedAttempts: 0, lockedUntil: null } })
    await db.adminAuthThrottle.deleteMany({ where: { scope: 'login' } })
  })

  it('密语轮换要求当前密码，并撤销所有旧 gate', async () => {
    const { token, jar } = await primeCsrf()
    await openGate(jar, token)
    expect(await db.adminGateChallenge.count({ where: { consumedAt: null } })).toBeGreaterThan(0)
    const actor = { principalId, roles: ['system_admin'], principalKind: 'system' } as never
    await expect(adminAuth.rotateAccessSecret(actor, 'wrong-password-value', 'replacement-entry-secret-2026')).rejects.toMatchObject({ code: 'ADMIN_CURRENT_PASSWORD_INVALID' })
    const rotated = await adminAuth.rotateAccessSecret(actor, PASSWORD, 'replacement-entry-secret-2026')
    expect(rotated.version).toBe(2)
    expect(await db.adminGateChallenge.count()).toBe(0)

    const fresh = await primeCsrf()
    await expect(adminAuth.openGate(request(fresh.jar, fresh.token), captureRes(), ACCESS_SECRET, fresh.token)).rejects.toMatchObject({ code: 'ADMIN_GATE_INVALID' })
    const newGateRes = captureRes()
    await expect(adminAuth.openGate(request(fresh.jar, fresh.token), newGateRes, 'replacement-entry-secret-2026', fresh.token)).resolves.toBeTruthy()
  })

  it('密语下限为 5 字符：5 位可用，4 位拒绝', async () => {
    const actor = { principalId, roles: ['system_admin'], principalKind: 'system' } as never
    await expect(adminAuth.rotateAccessSecret(actor, PASSWORD, 'abcd')).rejects.toMatchObject({ code: 'ADMIN_SECRET_FORMAT' })

    const rotated = await adminAuth.rotateAccessSecret(actor, PASSWORD, 'acm66')
    expect(rotated.version).toBeGreaterThan(1)

    // 短密语同样要能真正通过入口校验，不是只放过了长度检查
    const fresh = await primeCsrf()
    await expect(
      adminAuth.openGate(request(fresh.jar, fresh.token), captureRes(), 'acm66', fresh.token),
    ).resolves.toBeTruthy()
  })
})
