import { Controller, Get, Post, Query, Req, Res, HttpCode, BadRequestException } from '@nestjs/common'
import type { Request, Response } from 'express'
import { isDevSimulatorEnabled, loadEnv } from '../../config/env.js'
import { AuthService } from './auth.service.js'
import { isValidCampusId } from '../../common/utils.js'

/**
 * dev-only CAS 模拟器（03 方案 3.3）：
 * - 仅 development/test 且 AUTH_DEV_SIMULATOR=true 时可用；production 下所有路由直接 404。
 * - 行为对齐真实 CAS 契约：登录页 → 顶层导航带 service → POST 签发 ST → 回调 service?ticket=ST → 一次验证。
 * - 启动日志与页面均标记模拟模式；模拟测试通过不代表校园 CAS 联调成功。
 */
@Controller('/api/v1/dev-cas')
export class DevCasSimulatorController {
  constructor(private readonly auth: AuthService) {}

  private guard(): void {
    if (!isDevSimulatorEnabled(loadEnv())) {
      throw new BadRequestException('CAS 模拟器仅在开发模式可用（production 强制禁用）')
    }
  }

  /** 模拟学校 CAS 登录页：明显示式样 + 模拟标记 */
  @Get('login')
  loginPage(@Query('service') service: string, @Res() res: Response) {
    this.guard()
    if (!service) throw new BadRequestException('缺少 service')
    res.type('html').send(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>【模拟】校园统一认证 - 开发专用</title>
<style>body{font-family:system-ui;background:#f5f7fd;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#fff;border:1px solid #dee5f0;border-radius:16px;padding:32px;max-width:380px;width:90%}
.badge{background:#fff2de;color:#92531c;border-radius:6px;padding:4px 10px;font-size:13px;display:inline-block;margin-bottom:16px}
h1{font-size:20px;margin:8px 0}label{font-size:14px;display:block;margin:12px 0 4px}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #7d8ba5;border-radius:10px;font-size:16px}
button{margin-top:20px;width:100%;padding:12px;background:#3659cf;color:#fff;border:0;border-radius:10px;font-size:16px;cursor:pointer}
.note{font-size:12px;color:#61708a;margin-top:12px}</style></head>
<body><form class="card" method="post" action="/api/v1/dev-cas/login?service=${encodeURIComponent(service)}">
<span class="badge">模拟模式 · 开发专用</span>
<h1>校园统一认证（模拟器）</h1>
<label>校园编号<input name="campusId" pattern="[A-Za-z0-9._-]{1,64}" maxlength="64" required placeholder="202600001"></label>
<label>姓名<input name="realName" required placeholder="林同学"></label>
<label>模拟口令（AUTH_DEV_SIMULATOR_PASSWORD）<input name="password" type="password" autocomplete="off"></label>
<button type="submit">模拟登录（签发 ST）</button>
<p class="note">本页仅本地开发使用，不代表学校 cas.dlufl.edu.cn；生产环境强制禁用。</p>
</form></body></html>`)
  }

  /** 模拟 CAS 接受凭证并签发 ST，302 回 service?ticket=... */
  @Post('login')
  @HttpCode(302)
  loginSubmit(
    @Req() req: Request,
    @Query('service') service: string,
    @Res() res: Response,
  ) {
    this.guard()
    const campusId = String(req.body?.campusId ?? '')
    const realName = String(req.body?.realName ?? '')
    const password = String(req.body?.password ?? '')
    const env = loadEnv()
    if (env.AUTH_DEV_SIMULATOR_PASSWORD && password !== env.AUTH_DEV_SIMULATOR_PASSWORD) {
      return res.redirect(`/api/v1/dev-cas/login?service=${encodeURIComponent(service)}&error=bad_password`)
    }
    if (!isValidCampusId(campusId) || !realName.trim()) {
      return res.redirect(`/api/v1/dev-cas/login?service=${encodeURIComponent(service)}&error=bad_input`)
    }
    const ticket = this.auth.devIssueTicket(service, campusId, realName.trim())
    const sep = service.includes('?') ? '&' : '?'
    return res.redirect(302, `${service}${sep}ticket=${encodeURIComponent(ticket)}`)
  }
}
