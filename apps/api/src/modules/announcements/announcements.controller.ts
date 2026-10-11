import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common'
import { SessionGuard, PermissionsGuard, ActionGuard, RequireAction, CurrentActor, ok } from '../../common/guards.js'
import type { SessionActor } from '../auth/session.service.js'
import { AnnouncementsError, AnnouncementsService, announcementInputSchema } from './announcements.service.js'

function parseInput(body: unknown) {
  const parsed = announcementInputSchema.safeParse(body)
  if (!parsed.success) throw new AnnouncementsError(parsed.error.issues[0].message, 'INVALID_INPUT')
  return parsed.data
}

/** 管理端公告（announcements.manage）：草稿 / 发布 / 撤回 / 删除 */
@Controller('/api/v1/admin/announcements')
@UseGuards(SessionGuard, PermissionsGuard, ActionGuard)
export class AnnouncementsAdminController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  @RequireAction('announcements.manage')
  async list() {
    return ok(await this.announcements.adminList())
  }

  /** ?publish=1 直接发布，否则存草稿 */
  @Post()
  @RequireAction('announcements.manage')
  async create(@CurrentActor() actor: SessionActor, @Body() body: unknown, @Query('publish') publish?: string) {
    return ok(await this.announcements.create(actor, parseInput(body), publish === '1' || publish === 'true'))
  }

  @Put(':id')
  @RequireAction('announcements.manage')
  async update(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return ok(await this.announcements.update(actor, id, parseInput(body)))
  }

  @Post(':id/publish')
  @RequireAction('announcements.manage')
  async publish(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.announcements.publish(actor, id))
  }

  @Post(':id/withdraw')
  @RequireAction('announcements.manage')
  async withdraw(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.announcements.withdraw(actor, id))
  }

  @Delete(':id')
  @RequireAction('announcements.manage')
  async remove(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.announcements.remove(actor, id))
  }
}

/** 登录用户可见的公告与已读标记（成员、管理员均可） */
@Controller('/api/v1/announcements')
@UseGuards(SessionGuard, PermissionsGuard)
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  async list(@CurrentActor() actor: SessionActor) {
    return ok(await this.announcements.visible(actor.principalId))
  }

  @Post(':id/read')
  async read(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.announcements.markVisibleRead(actor.principalId, id))
  }
}
