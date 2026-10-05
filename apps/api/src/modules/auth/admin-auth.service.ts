import { HttpException, Inject, Injectable } from '@nestjs/common'
import type { Request, Response } from 'express'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { loadEnv } from '../../config/env.js'
import { newId, randomToken, sha256Hex } from '../../common/utils.js'
import { SessionService, type SessionActor } from './session.service.js'
import {
  ADMIN_PASSWORD_MIN_LENGTH,
  ADMIN_SECRET_MIN_LENGTH,
  generateCaptcha,
  hashAdminSecret,
  hashOneTimeCode,
  normalizeAdminUsername,
  verifyAdminSecret,
  verifyOneTimeCode,
} from './admin-auth.crypto.js'

const GATE_TTL_MS = 10 * 60_000
const CAPTCHA_TTL_MS = 3 * 60_000
const THROTTLE_WINDOW_MS = 15 * 60_000
const THROTTLE_BLOCK_MS = 15 * 60_000
const THROTTLE_MAX_FAILURES = 5
const ACCOUNT_LOCK_MS = 30 * 60_000
const ACCOUNT_MAX_FAILURES = 5
const DUMMY_PASSWORD_HASH = hashAdminSecret('timing-only-password-value-never-used')

export class AdminAuthError extends HttpException {
  constructor(message: string, readonly code: string, status = 400) {
    super({ code, message }, status)
  }
}

@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async openGate(req: Request, res: Response, secret: string, csrfToken?: string): Promise<{ expiresAt: Date }> {
    await this.assertRequestIntegrity(req, csrfToken)
    const ipHash = this.ipHash(req)
    await this.assertNotThrottled('gate', ipHash)
    const configured = await this.db.adminAccessSecret.findUnique({ where: { key: 'primary' } })
    const valid = configured && typeof secret === 'string' && secret.length <= 256
      ? await verifyAdminSecret(secret, configured.secretHash)
      : false
    if (!configured || !valid) {
      await this.recordFailure('gate', ipHash)
      await this.audit.log({ action: 'admin_auth.gate_failed', resourceType: 'admin_gate', resourceId: ipHash.slice(0, 16), reason: 'INVALID_SECRET' })
      throw new AdminAuthError('密语错误或入口尚未配置', 'ADMIN_GATE_INVALID', 401)
    }

    await this.clearThrottle('gate', ipHash)
    const token = randomToken(32)
    const expiresAt = new Date(Date.now() + GATE_TTL_MS)
    await this.db.adminGateChallenge.create({
      data: { id: newId(), tokenHash: sha256Hex(token), secretVersion: configured.version, ipHash, expiresAt },
    })
    res.cookie(this.gateCookieName(), token, {
      httpOnly: true,
      secure: loadEnv().COOKIE_SECURE,
      sameSite: 'strict',
      path: '/',
      expires: expiresAt,
    })
    await this.audit.log({ action: 'admin_auth.gate_opened', resourceType: 'admin_gate', resourceId: ipHash.slice(0, 16) })
    return { expiresAt }
  }

  async createCaptcha(req: Request, csrfToken?: string): Promise<{ challengeId: string; svg: string; expiresAt: Date }> {
    await this.assertRequestIntegrity(req, csrfToken)
    const gate = await this.requireGate(req)
    const { answer, svg } = generateCaptcha()
    const challengeId = newId()
    const expiresAt = new Date(Date.now() + CAPTCHA_TTL_MS)
    await this.db.adminLoginChallenge.create({
      data: { id: challengeId, gateId: gate.id, answerHash: hashOneTimeCode(challengeId, answer), expiresAt },
    })
    return { challengeId, svg, expiresAt }
  }

  async login(
    req: Request,
    res: Response,
    input: { username: string; password: string; challengeId: string; captcha: string; csrfToken?: string },
  ): Promise<{ principalId: string; roles: string[] }> {
    await this.assertRequestIntegrity(req, input.csrfToken)
    const gate = await this.requireGate(req)
    const username = normalizeAdminUsername(input.username)
    const throttleKey = sha256Hex(`${this.ipHash(req)}:${username ?? 'invalid'}`)
    await this.assertNotThrottled('login', throttleKey)

    const claimed = await this.db.$queryRaw<Array<{ answer_hash: string }>>`
      UPDATE admin_login_challenges
      SET consumed_at = now()
      WHERE id = ${input.challengeId}::uuid
        AND gate_id = ${gate.id}::uuid
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING answer_hash`
    if (claimed.length !== 1 || !verifyOneTimeCode(input.challengeId, input.captcha, claimed[0].answer_hash)) {
      await this.recordFailure('login', throttleKey)
      await this.auditFailure('ADMIN_CAPTCHA_INVALID', username, throttleKey)
      throw new AdminAuthError('验证码错误或已失效', 'ADMIN_CAPTCHA_INVALID', 401)
    }

    const credential = username ? await this.db.adminCredential.findUnique({ where: { username } }) : null
    const passwordHash = credential?.passwordHash ?? await DUMMY_PASSWORD_HASH
    const passwordValid = typeof input.password === 'string' && input.password.length <= 512
      ? await verifyAdminSecret(input.password, passwordHash)
      : false
    const now = new Date()
    if (credential && (credential.status !== 'active' || credential.disabledAt)) {
      await this.auditFailure('ADMIN_ACCOUNT_DISABLED', username, throttleKey, credential.principalId)
      throw new AdminAuthError('账号已停用', 'ADMIN_ACCOUNT_DISABLED', 403)
    }
    if (credential?.lockedUntil && credential.lockedUntil > now) {
      await this.recordFailure('login', throttleKey)
      await this.auditFailure('ADMIN_ACCOUNT_LOCKED', username, throttleKey, credential.principalId)
      throw new AdminAuthError('账号暂时锁定，请稍后再试', 'ADMIN_ACCOUNT_LOCKED', 423)
    }
    if (!credential || !passwordValid) {
      if (credential) {
        const updated = await this.db.adminCredential.update({
          where: { id: credential.id },
          data: { failedAttempts: { increment: 1 } },
        })
        if (updated.failedAttempts >= ACCOUNT_MAX_FAILURES) {
          await this.db.adminCredential.update({
            where: { id: credential.id },
            data: { failedAttempts: 0, lockedUntil: new Date(Date.now() + ACCOUNT_LOCK_MS) },
          })
        }
      }
      await this.recordFailure('login', throttleKey)
      await this.auditFailure('ADMIN_CREDENTIAL_INVALID', username, throttleKey, credential?.principalId)
      throw new AdminAuthError('用户名或密码错误', 'ADMIN_CREDENTIAL_INVALID', 401)
    }

    const principal = await this.db.principal.findUnique({
      where: { id: credential.principalId },
      include: { roleGrants: { where: { revokedAt: null } } },
    })
    if (!principal || principal.kind !== 'system') {
      await this.auditFailure('ADMIN_PRINCIPAL_INVALID', username, throttleKey, credential.principalId)
      throw new AdminAuthError('管理员主体配置异常', 'ADMIN_PRINCIPAL_INVALID', 403)
    }

    const roles = Array.from(new Set(principal.roleGrants
      .filter((grant) => grant.validUntil == null || grant.validUntil > now)
      .map((grant) => grant.role)))
    if (!roles.includes('system_admin') && !roles.includes('presidium')) {
      throw new AdminAuthError('账号没有管理权限', 'ADMIN_ROLE_MISSING', 403)
    }

    await this.db.$transaction([
      this.db.adminCredential.update({
        where: { id: credential.id },
        data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: now },
      }),
      this.db.adminGateChallenge.update({ where: { id: gate.id }, data: { consumedAt: now } }),
    ])
    const session = await this.sessions.createSession(principal.id, req.headers['user-agent'])
    await this.clearThrottle('login', throttleKey)
    this.sessions.setSessionCookie(res, session.token, session.expiresAt)
    res.clearCookie(this.gateCookieName(), { path: '/' })
    await this.audit.log({
      actorPrincipalId: principal.id,
      action: 'admin_auth.login_succeeded',
      resourceType: 'admin_credential',
      resourceId: credential.id,
      summary: '本地管理员登录成功',
    })
    return { principalId: principal.id, roles }
  }

  async rotateAccessSecret(actor: SessionActor, currentPassword: string, newSecret: string): Promise<{ version: number }> {
    if (newSecret.length < ADMIN_SECRET_MIN_LENGTH || newSecret.length > 256) {
      throw new AdminAuthError(`新密语长度必须为 ${ADMIN_SECRET_MIN_LENGTH}–256 个字符`, 'ADMIN_SECRET_FORMAT')
    }
    const credential = await this.db.adminCredential.findUnique({ where: { principalId: actor.principalId } })
    if (!credential || currentPassword.length < ADMIN_PASSWORD_MIN_LENGTH || !(await verifyAdminSecret(currentPassword, credential.passwordHash))) {
      await this.audit.log({
        actorPrincipalId: actor.principalId,
        action: 'admin_auth.secret_rotation_failed',
        resourceType: 'admin_access_secret',
        resourceId: 'primary',
        reason: 'CURRENT_PASSWORD_INVALID',
      })
      throw new AdminAuthError('当前管理员密码错误', 'ADMIN_CURRENT_PASSWORD_INVALID', 403)
    }
    const secretHash = await hashAdminSecret(newSecret)
    const result = await this.db.$transaction(async (tx) => {
      const updated = await tx.adminAccessSecret.update({
        where: { key: 'primary' },
        data: { secretHash, version: { increment: 1 } },
      })
      await tx.adminGateChallenge.deleteMany()
      await tx.auditLog.create({
        data: {
          id: newId(), actorPrincipalId: actor.principalId, action: 'admin_auth.secret_rotated',
          resourceType: 'admin_access_secret', resourceId: 'primary', summary: `入口密语轮换至版本 ${updated.version}`,
        },
      })
      return updated
    })
    return { version: result.version }
  }

  private async requireGate(req: Request) {
    const token = req.cookies?.[this.gateCookieName()]
    if (typeof token !== 'string') throw new AdminAuthError('请先验证入口密语', 'ADMIN_GATE_REQUIRED', 401)
    const gate = await this.db.adminGateChallenge.findUnique({ where: { tokenHash: sha256Hex(token) } })
    const configured = await this.db.adminAccessSecret.findUnique({ where: { key: 'primary' } })
    if (!gate || !configured || gate.consumedAt || gate.expiresAt <= new Date() || gate.secretVersion !== configured.version) {
      throw new AdminAuthError('入口授权已失效，请重新验证密语', 'ADMIN_GATE_EXPIRED', 401)
    }
    return gate
  }

  private async assertRequestIntegrity(req: Request, csrfToken?: string): Promise<void> {
    const origin = req.headers.origin
    if (origin) {
      try {
        if (new URL(origin).origin !== new URL(loadEnv().PUBLIC_BASE_URL).origin) {
          throw new AdminAuthError('跨站请求被拒绝', 'ORIGIN_MISMATCH', 403)
        }
      } catch (error) {
        if (error instanceof AdminAuthError) throw error
        throw new AdminAuthError('Origin 非法', 'ORIGIN_INVALID', 403)
      }
    }
    if (!(await this.sessions.verifyCsrf(req, csrfToken))) {
      throw new AdminAuthError('CSRF 校验失败，请刷新页面重试', 'CSRF_INVALID', 403)
    }
  }

  private gateCookieName(): string {
    const env = loadEnv()
    return env.COOKIE_SECURE && env.NODE_ENV === 'production'
      ? `__Host-${env.COOKIE_NAME}_admin_gate`
      : `${env.COOKIE_NAME}_admin_gate`
  }

  private ipHash(req: Request): string {
    const address = req.ip || req.socket?.remoteAddress || 'unknown'
    return sha256Hex(address)
  }

  private async assertNotThrottled(scope: string, keyHash: string): Promise<void> {
    const row = await this.db.adminAuthThrottle.findUnique({ where: { scope_keyHash: { scope, keyHash } } })
    if (row?.blockedUntil && row.blockedUntil > new Date()) {
      throw new AdminAuthError('尝试过于频繁，请稍后再试', 'ADMIN_AUTH_THROTTLED', 429)
    }
  }

  private async recordFailure(scope: string, keyHash: string): Promise<void> {
    const now = new Date()
    const windowFloor = new Date(now.getTime() - THROTTLE_WINDOW_MS)
    const blockedUntil = new Date(now.getTime() + THROTTLE_BLOCK_MS)
    await this.db.$executeRaw`
      INSERT INTO admin_auth_throttles
        (id, scope, key_hash, failed_count, window_started_at, blocked_until, updated_at)
      VALUES
        (${newId()}::uuid, ${scope}, ${keyHash}, 1, ${now}, NULL, ${now})
      ON CONFLICT (scope, key_hash) DO UPDATE SET
        failed_count = CASE
          WHEN admin_auth_throttles.window_started_at <= ${windowFloor} THEN 1
          ELSE admin_auth_throttles.failed_count + 1
        END,
        window_started_at = CASE
          WHEN admin_auth_throttles.window_started_at <= ${windowFloor} THEN ${now}
          ELSE admin_auth_throttles.window_started_at
        END,
        blocked_until = CASE
          WHEN (CASE
            WHEN admin_auth_throttles.window_started_at <= ${windowFloor} THEN 1
            ELSE admin_auth_throttles.failed_count + 1
          END) >= ${THROTTLE_MAX_FAILURES} THEN ${blockedUntil}
          WHEN admin_auth_throttles.window_started_at <= ${windowFloor} THEN NULL
          ELSE admin_auth_throttles.blocked_until
        END,
        updated_at = ${now}`
  }

  private async clearThrottle(scope: string, keyHash: string): Promise<void> {
    await this.db.adminAuthThrottle.deleteMany({ where: { scope, keyHash } })
  }

  private async auditFailure(code: string, username: string | null, throttleKey: string, principalId?: string): Promise<void> {
    await this.audit.log({
      actorPrincipalId: principalId ?? null,
      action: 'admin_auth.login_failed',
      resourceType: 'admin_credential',
      resourceId: username ? sha256Hex(username).slice(0, 16) : throttleKey.slice(0, 16),
      reason: code,
    })
  }
}
