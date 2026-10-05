import { Inject, Injectable } from '@nestjs/common'
import type { Request, Response } from 'express'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { loadEnv } from '../../config/env.js'
import { randomToken, sha256Hex } from '../../common/utils.js'

/**
 * 服务端 opaque 会话（02/03 方案）：
 * - Cookie 仅存明文 token，服务端存摘要；HttpOnly/Secure/SameSite=Lax。
 * - 本地 http 开发使用普通 Cookie 名；生产 HTTPS 使用 __Host- 前缀。
 * - 撤销/权限变更通过 revoked_at 与 authz_version 生效。
 * - CSRF：会话级 token（HttpOnly cookie 绑定），变更接口校验 X-Clubs-Csrf + Origin。
 */

export interface SessionActor {
  sessionId: string
  principalId: string
  principalKind: string // student | staff | system
  userId?: string // 学生主体关联的 users.id
  studentNo?: string
  staffNo?: string
  campusId?: string
  realName?: string
  authzVersion: number
  roles: string[]
}

@Injectable()
export class SessionService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  cookieName(): string {
    const env = loadEnv()
    if (env.COOKIE_SECURE && env.NODE_ENV === 'production') return `__Host-${env.COOKIE_NAME}`
    return env.COOKIE_NAME
  }

  async createSession(principalId: string, userAgent?: string): Promise<{ token: string; expiresAt: Date }> {
    const env = loadEnv()
    const token = randomToken(32)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + env.SESSION_TTL_HOURS * 3600_000)
    const idleExpiresAt = new Date(now.getTime() + env.SESSION_IDLE_TTL_HOURS * 3600_000)
    await this.db.session.create({
      data: {
        id: crypto.randomUUID(),
        tokenHash: sha256Hex(token),
        principalId,
        authTime: now,
        expiresAt,
        idleExpiresAt,
        userAgent: userAgent?.slice(0, 200),
      },
    })
    return { token, expiresAt }
  }

  setSessionCookie(res: Response, token: string, expiresAt: Date): void {
    const env = loadEnv()
    res.cookie(this.cookieName(), token, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    })
  }

  clearSessionCookie(res: Response): void {
    res.clearCookie(this.cookieName(), { path: '/' })
  }

  /** 从请求解析并校验会话（idle 过期滚动更新）；未登录返回 null */
  async resolveActor(req: Request): Promise<SessionActor | null> {
    const token = req.cookies?.[this.cookieName()]
    if (!token || typeof token !== 'string') return null
    const session = await this.db.session.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: {
        principal: { include: { users: true, staffProfiles: true, adminCredential: true, roleGrants: { where: { revokedAt: null } } } },
      },
    })
    const now = new Date()
    if (!session) return null
    if (session.revokedAt != null || session.expiresAt < now || session.idleExpiresAt < now) return null
    if (session.principal.users.length > 0 && session.principal.users[0].accountStatus !== 'active') return null
    if (session.principal.staffProfiles.length > 0 && session.principal.staffProfiles[0].status !== 'active') return null
    if (session.principal.adminCredential && session.principal.adminCredential.status !== 'active') return null

    // idle 滚动续期
    if (session.idleExpiresAt.getTime() - now.getTime() < (loadEnv().SESSION_IDLE_TTL_HOURS * 3600_000) / 2) {
      await this.db.session.update({
        where: { id: session.id },
        data: { idleExpiresAt: new Date(now.getTime() + loadEnv().SESSION_IDLE_TTL_HOURS * 3600_000) },
      })
    }

    const user = session.principal.users[0]
    const staff = session.principal.staffProfiles[0]
    const roles = session.principal.roleGrants
      .filter((g) => g.validUntil == null || g.validUntil > now)
      .map((g) => g.role)
    return {
      sessionId: session.id,
      principalId: session.principal.id,
      principalKind: session.principal.kind,
      userId: user?.id,
      studentNo: user?.studentNo,
      staffNo: staff?.staffNo ?? undefined,
      campusId: user?.studentNo ?? staff?.staffNo ?? undefined,
      realName: user?.verifiedRealName ?? staff?.realName ?? session.principal.adminCredential?.displayName,
      authzVersion: session.authzVersion,
      roles: Array.from(new Set(roles)),
    }
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    })
  }

  async revokeAllForPrincipal(principalId: string, reason: string): Promise<void> {
    await this.db.session.updateMany({
      where: { principalId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    })
  }

  // ---------------- CSRF ----------------

  private csrfCookieName(): string {
    return `${this.cookieName()}_csrf`
  }

  /** 已登录会话的 CSRF：与匿名 bootstrap 同一机制（服务端绑定 + HttpOnly cookie），登录成功后重新签发轮换 */
  async issueSessionCsrf(req: Request, res: Response): Promise<string> {
    const { token } = await this.issueAnonymousCsrf(req, res)
    return token
  }

  /** 匿名 CSRF bootstrap（03 方案 3.3）：随机短期 HttpOnly 绑定 cookie + 关联 token */
  async issueAnonymousCsrf(req: Request, res: Response): Promise<{ token: string; cookieHash: string }> {
    const env = loadEnv()
    const cookieValue = randomToken(24)
    const token = randomToken(24)
    const expiresAt = new Date(Date.now() + env.CSRF_TTL_MINUTES * 60_000)
    const cookieHash = sha256Hex(cookieValue + token)
    await this.db.anonymousBinding.create({
      data: { id: crypto.randomUUID(), cookieHash, tokenHash: sha256Hex(token), expiresAt },
    })
    res.cookie(this.csrfCookieName(), cookieValue, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    })
    void req
    return { token, cookieHash }
  }

  /** 校验 CSRF：匿名绑定或会话 cookie 与请求头 token 匹配 */
  async verifyCsrf(req: Request, token: string | undefined): Promise<boolean> {
    const headerToken = req.headers?.['x-clubs-csrf']
    token ||= typeof headerToken === 'string' ? headerToken : undefined
    if (!token) return false
    const cookieValue = req.cookies?.[this.csrfCookieName()]
    if (!cookieValue || typeof cookieValue !== 'string') return false
    const binding = await this.db.anonymousBinding.findFirst({
      where: { cookieHash: sha256Hex(cookieValue + token), expiresAt: { gt: new Date() } },
    })
    return binding != null
  }

  async consumeAnonymousBinding(req: Request, token: string | undefined): Promise<string | null> {
    const headerToken = req.headers?.['x-clubs-csrf']
    token ||= typeof headerToken === 'string' ? headerToken : undefined
    if (!token) return null
    const cookieValue = req.cookies?.[this.csrfCookieName()]
    if (!cookieValue || typeof cookieValue !== 'string') return null
    const cookieHash = sha256Hex(cookieValue + token)
    const binding = await this.db.anonymousBinding.findFirst({ where: { cookieHash, expiresAt: { gt: new Date() } } })
    return binding ? cookieHash : null
  }

  async touchAnonymousBinding(cookieHash: string): Promise<void> {
    // 延长匿名绑定有效期（CAS 往返可能耗时）
    await this.db.anonymousBinding.updateMany({
      where: { cookieHash },
      data: { expiresAt: new Date(Date.now() + loadEnv().CSRF_TTL_MINUTES * 60_000 + 10 * 60_000) },
    })
  }
}
