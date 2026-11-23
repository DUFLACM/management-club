import { Controller, Get, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common'
import { SessionGuard, CurrentActor, ok } from '../../common/guards.js'
import type { SessionActor } from '../auth/session.service.js'
import { NotificationsService } from './notifications.service.js'

@Controller('/api/v1/me/notifications')
@UseGuards(SessionGuard)
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get()
  async list(@CurrentActor() actor: SessionActor) {
    return ok(await this.notifications.listForUser(actor.userId ?? null))
  }

  @Post('read-all')
  async readAll(@CurrentActor() actor: SessionActor) {
    if (!actor.userId) return ok({ updated: 0 })
    return ok(await this.notifications.markAllRead(actor.userId))
  }

  @Post(':id/read')
  async readOne(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    if (!actor.userId) return ok({ marked: false })
    return ok(await this.notifications.markRead(actor.userId, id))
  }
}
