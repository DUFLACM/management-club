import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { ok } from '../../common/guards.js'
import { AdminAuthService } from './admin-auth.service.js'

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
