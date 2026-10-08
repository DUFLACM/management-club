import { Body, Controller, HttpCode, Post, Put, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { CurrentActor, SessionGuard, ok } from '../../common/guards.js'
import { AdminAuthError, AdminAuthService } from './admin-auth.service.js'
import { ADMIN_PASSWORD_MAX_LENGTH, ADMIN_PASSWORD_MIN_LENGTH } from './admin-auth.crypto.js'
import { SessionService, type SessionActor } from './session.service.js'

@Controller('/api/v1/auth/admin')
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  @Post('gate')
  @HttpCode(200)
  async gate(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    const input = z.object({ secret: z.string().min(1).max(256), csrfToken: z.string().min(1) }).strict().parse(body)
    return ok({ verified: true, ...(await this.adminAuth.openGate(req, res, input.secret, input.csrfToken)) })
  }

  @Post('captcha')
  @HttpCode(200)
  async captcha(@Req() req: Request, @Body() body: unknown) {
    const input = z.object({ csrfToken: z.string().min(1) }).strict().parse(body)
    const challenge = await this.adminAuth.createCaptcha(req, input.csrfToken)
    return ok({
      challengeId: challenge.challengeId,
      imageDataUrl: `data:image/svg+xml;base64,${Buffer.from(challenge.svg, 'utf8').toString('base64')}`,
      expiresAt: challenge.expiresAt,
    })
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    const input = z.object({
      username: z.string().min(1).max(64),
      password: z.string().min(1).max(512),
      challengeId: z.uuid(),
      captcha: z.string().min(1).max(12),
      csrfToken: z.string().min(1),
    }).strict().parse(body)
    const result = await this.adminAuth.login(req, res, input)
    return ok({ authenticated: true, next: '/admin', roles: result.roles })
  }
}

/** 已登录的本地管理员修改自己的密码（不需要额外业务权限，凭当前密码确认） */
@Controller('/api/v1/admin/account')
@UseGuards(SessionGuard)
export class AdminAccountController {
  constructor(
    private readonly adminAuth: AdminAuthService,
    private readonly sessions: SessionService,
  ) {}

  @Put('password')
  async changePassword(@CurrentActor() actor: SessionActor, @Req() req: Request, @Body() body: unknown) {
    const parsed = z.object({
      currentPassword: z.string().min(1).max(512),
      newPassword: z.string()
        .min(ADMIN_PASSWORD_MIN_LENGTH, `新密码须为 ${ADMIN_PASSWORD_MIN_LENGTH}–${ADMIN_PASSWORD_MAX_LENGTH} 位`)
        .max(ADMIN_PASSWORD_MAX_LENGTH, `新密码须为 ${ADMIN_PASSWORD_MIN_LENGTH}–${ADMIN_PASSWORD_MAX_LENGTH} 位`),
      csrfToken: z.string().optional(),
    }).strict().safeParse(body)
    if (!parsed.success) throw new AdminAuthError(parsed.error.issues[0].message, 'INVALID_INPUT')
    if (!(await this.sessions.verifyCsrf(req, parsed.data.csrfToken))) {
      throw new AdminAuthError('CSRF 校验失败，请刷新页面重试', 'CSRF_INVALID', 403)
    }
    return ok(await this.adminAuth.changeOwnPassword(actor, parsed.data.currentPassword, parsed.data.newPassword))
  }
}
