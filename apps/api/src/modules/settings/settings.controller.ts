import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { z } from 'zod'
import { SessionGuard, PermissionsGuard, ActionGuard, RequireAction, CurrentActor, ok } from '../../common/guards.js'
import { SettingsService, SETTING_GROUPS, type SettingGroup } from './settings.service.js'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import type { SessionActor } from '../auth/session.service.js'
import { SessionService } from '../auth/session.service.js'
import { AdminAuthError, AdminAuthService } from '../auth/admin-auth.service.js'

@Controller('/api/v1/admin/settings')
@UseGuards(SessionGuard, PermissionsGuard, ActionGuard)
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly db: PrismaService,
    private readonly sessions: SessionService,
    private readonly adminAuth: AdminAuthService,
  ) {}

  @Get()
  @RequireAction('settings.manage')
  async view(@Query('group') group?: string) {
    const g = SETTING_GROUPS.includes(group as SettingGroup) ? (group as SettingGroup) : 'branding'
    return ok({ group: g, ...(await this.settings.groupView(g)) })
  }

  @Get('versions')
  @RequireAction('settings.manage')
  async versions(@Query('group') group?: string) {
    const g = SETTING_GROUPS.includes(group as SettingGroup) ? (group as SettingGroup) : undefined
    const rows = await this.db.siteSettingVersion.findMany({
      where: g ? { group: g } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, group: true, status: true, revision: true, changeSummary: true, createdAt: true, publishedAt: true, revertOfId: true },
    })
    return ok(rows)
  }

  @Post('drafts')
  @RequireAction('settings.manage')
  async createDraft(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const parsed = z.object({ group: z.enum(SETTING_GROUPS), value: z.record(z.string(), z.unknown()), changeSummary: z.string().min(3).max(200) }).parse(body)
    return ok(await this.settings.createDraft(actor, parsed.group, parsed.value, parsed.changeSummary))
  }

  @Post('drafts/:id/validate')
  @RequireAction('settings.manage')
  async validate(@Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.settings.validateDraft(id))
  }

  @Post('drafts/:id/approve')
  async approve(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.settings.approve(actor, id))
  }

  @Post('drafts/:id/publish')
  @RequireAction('settings.manage')
  async publish(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    await this.settings.publish(actor, id)
    return ok({ published: true })
  }

  @Post('versions/:id/revert')
  @RequireAction('settings.manage')
  async revert(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(body)
    return ok(await this.settings.revert(actor, id, reason))
  }

  /** 轮换管理员入口密语：需要已登录 system_admin + 当前本地密码二次确认。 */
  @Put('admin-access-secret')
  @RequireAction('settings.manage')
  async rotateAdminAccessSecret(
    @CurrentActor() actor: SessionActor,
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = z.object({
      currentPassword: z.string().min(1).max(512),
      newSecret: z.string().min(16).max(256),
      csrfToken: z.string().optional(),
    }).strict().parse(body)
    if (!(await this.sessions.verifyCsrf(req, input.csrfToken))) {
      throw new AdminAuthError('CSRF 校验失败，请刷新页面重试', 'CSRF_INVALID', 403)
    }
    return ok(await this.adminAuth.rotateAccessSecret(actor, input.currentPassword, input.newSecret))
  }
}

@Controller('/api/v1/admin/secrets')
@UseGuards(SessionGuard, PermissionsGuard, ActionGuard)
export class SecretsController {
  constructor(private readonly settings: SettingsService) {}

  /** 状态只读：configured/版本/轮换时间，不回明文 */
  @Get()
  @RequireAction('secrets.write')
  async status() {
    return ok(await this.settings.secretStatus())
  }

  @Put(':key')
  @RequireAction('secrets.write')
  async write(@CurrentActor() actor: SessionActor, @Param('key') key: string, @Body() body: unknown) {
    const { secret } = z.object({ secret: z.string().min(16).max(4096) }).parse(body)
    if (!/^[-a-z0-9_:]{3,60}$/.test(key)) return ok({ error: 'key 格式不合法' })
    return ok(await this.settings.writeSecret(actor, key, secret))
  }

  @Delete(':key')
  @RequireAction('secrets.write')
  async disable(@CurrentActor() actor: SessionActor, @Param('key') key: string) {
    await this.settings.disableSecret(actor, key)
    return ok({ disabled: true })
  }
}
