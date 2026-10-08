import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { AuthService, AuthFlowError } from './auth.service.js'
import { SessionService, type SessionActor } from './session.service.js'
import { SessionGuard, CurrentActor, ok } from '../../common/guards.js'
import { buildCasLogoutUrl } from './cas.client.js'
import { loadEnv } from '../../config/env.js'
import { PrismaService } from '../../infrastructure/database/database.module.js'

/**
 * 认证 API（03 方案 11）。认证与出勤相关响应一律 private,no-store。
 * CAS 回调是后端接口（303/302 顶层导航），SPA fallback 不得截获 /api/v1/auth/cas/callback。
 */
@Controller('/api/v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(PrismaService) private readonly db: PrismaService,
  ) {}

  /** 未登录匿名绑定或已有会话的 CSRF token */
  @Get('csrf')
  async csrf(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const actor = await this.sessions.resolveActor(req)
    if (actor) {
      const token = await this.sessions.issueSessionCsrf(req, res)
      // 登录绑定门用：随会话一起返回是否已绑定牛客，前端不必再串行请求一次平台账号列表
      const nowcoderBound = actor.userId
        ? (await this.db.platformAccount.count({ where: { userId: actor.userId, platform: 'nowcoder', status: { not: 'revoked' } } })) > 0
        : null
      return ok({
        token,
        authenticated: true,
        principalId: actor.principalId,
        principalKind: actor.principalKind,
        roles: actor.roles,
        userId: actor.userId,
        studentNo: actor.studentNo,
        staffNo: actor.staffNo,
        campusId: actor.campusId,
        nowcoderBound,
      })
    }
    const { token } = await this.sessions.issueAnonymousCsrf(req, res)
    return ok({ token, authenticated: false })
  }

  /** 发起 CAS 登录（顶层导航/表单 POST 承接；校验 CSRF 与 Origin） */
  @Post('cas/start')
  @HttpCode(200)
  async startLogin(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { csrfToken?: string; returnTarget?: string; purpose?: 'login' | 'register'; registrationIntentId?: string; renew?: boolean },
  ) {
    this.assertOrigin(req)
    if (!(await this.sessions.verifyCsrf(req, body.csrfToken))) {
      throw new AuthFlowError('CSRF 校验失败，请刷新页面重试', 'CSRF_INVALID')
    }
    const url = await this.auth.startCasAuth(req, res, {
      purpose: body.purpose ?? 'login',
      returnTarget: body.returnTarget,
      registrationIntentId: body.registrationIntentId,
      renew: body.renew,
    })
    return ok({ redirectUrl: url, mode: 'top_level_navigation' })
  }

  /** CAS 回调：验证 flow/cookie/service/ticket；建立会话或预注册会话，重定向干净本站路径 */
  @Get('cas/callback')
  async casCallback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('flow') flow: string,
    @Query('ticket') ticket: string,
  ) {
    if (!flow || !ticket) {
      return res.redirect('/login?error=callback_params_missing')
    }
    try {
      const { redirect } = await this.auth.handleCasCallback(req, res, flow, ticket)
      return res.redirect(303, redirect)
    } catch (e) {
      const code = e instanceof AuthFlowError || e instanceof Error ? (e as { code?: string }).code ?? 'CAS_ERROR' : 'CAS_ERROR'
      return res.redirect(`/login?error=${encodeURIComponent(code)}`)
    }
  }

  /** 邀请交换：建立注册意图，不扣名额 */
  @Post('invitations/exchange')
  @HttpCode(200)
  async exchangeInvitation(
    @Req() req: Request,
    @Body() body: { code?: string; secret?: string; csrfToken?: string },
  ) {
    this.assertOrigin(req)
    const result = await this.auth.exchangeInvitation(req, { code: body.code, secret: body.secret }, body.csrfToken ?? '')
    return ok(result)
  }

  /** 最终注册：受限预注册会话内原子兑换邀请 */
  @Post('register/complete')
  @HttpCode(200)
  async registerComplete(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { grade?: number; phone?: string; csrfToken?: string },
  ) {
    this.assertOrigin(req)
    const env = loadEnv()
    const prereg = req.cookies?.[`${env.COOKIE_NAME}_reg`]
    const result = await this.auth.completeRegistration(req, res, { grade: body.grade, phone: body.phone }, prereg, body.csrfToken ?? '')
    return ok({ ...result, next: '/app?section=profile&registered=applicant' })
  }

  /** 当前身份/权限 */
  @Get('session')
  @UseGuards(SessionGuard)
  async session(@CurrentActor() actor: SessionActor) {
    // 外壳侧栏头像用：展示名与头像资产随资料更新，不进会话快照，按需读一次
    const profile = actor.userId
      ? await this.db.userProfile.findUnique({
          where: { userId: actor.userId },
          select: { displayName: true, avatarAssetId: true },
        })
      : null
    return ok({
      principalId: actor.principalId,
      principalKind: actor.principalKind,
      userId: actor.userId,
      studentNo: actor.studentNo,
      staffNo: actor.staffNo,
      campusId: actor.campusId,
      realName: actor.realName,
      displayName: profile?.displayName ?? actor.realName ?? null,
      avatarAssetId: profile?.avatarAssetId ?? null,
      roles: actor.roles,
    })
  }

  /** 退出：撤销本地会话，再提供 CAS 联动退出链接 */
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const actor = await this.sessions.resolveActor(req)
    if (actor) await this.sessions.revokeSession(actor.sessionId, 'user_logout')
    this.sessions.clearSessionCookie(res)
    const env = loadEnv()
    const casLogout = buildCasLogoutUrl(`${new URL(env.PUBLIC_BASE_URL).origin}/login`)
    return ok({ casLogoutUrl: casLogout })
  }

  private assertOrigin(req: Request): void {
    const env = loadEnv()
    const origin = req.headers.origin
    if (!origin) return // 同源表单 POST（非跨域浏览器）无 Origin 时由 CSRF token 保护
    try {
      if (new URL(origin).origin !== new URL(env.PUBLIC_BASE_URL).origin) {
        throw new AuthFlowError('跨站请求被拒绝', 'ORIGIN_MISMATCH')
      }
    } catch (e) {
      if (e instanceof AuthFlowError) throw e
      throw new AuthFlowError('Origin 非法', 'ORIGIN_INVALID')
    }
  }
}
