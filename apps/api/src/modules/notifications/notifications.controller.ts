import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common'
import { SessionGuard, CurrentActor, CurrentUser, ok } from '../../common/guards.js'
import type { SessionActor } from '../auth/session.service.js'
import { NotificationsService } from './notifications.service.js'
import { WxPusherService } from './wxpusher.service.js'

@Controller('/api/v1/me/notifications')
@UseGuards(SessionGuard)
export class NotificationsController {
  constructor(
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(WxPusherService) private readonly wxpusher: WxPusherService,
  ) {}

  @Get()
  async list(@CurrentActor() actor: SessionActor) {
    return ok(await this.notifications.listForUser(actor.userId ?? null))
  }

  @Post('read-all')
  async readAll(@CurrentActor() actor: SessionActor) {
    if (!actor.userId) return ok({ updated: 0 })
    return ok(await this.notifications.markAllRead(actor.userId))
  }

  @Get('wxpusher')
  async wxpusherStatus(@CurrentActor() actor: SessionActor) {
    return ok(await this.wxpusher.getStatus(actor.userId ?? null))
  }

  @Post('wxpusher/qrcode')
  async wxpusherQrCode(@CurrentUser() user: { userId: string }) {
    return ok(await this.wxpusher.createBindQrCode(user.userId))
  }

  @Post('wxpusher/bind-uid')
  async wxpusherBindUid(@CurrentUser() user: { userId: string }, @Body() body: { uid?: string }) {
    return ok(await this.wxpusher.bindUidManually(user.userId, String(body?.uid ?? '')))
  }

  @Patch('wxpusher')
  async wxpusherPreferences(@CurrentUser() user: { userId: string }, @Body() body: unknown) {
    return ok(await this.wxpusher.updatePreferences(user.userId, body))
  }

  @Post('wxpusher/test')
  async wxpusherTest(@CurrentUser() user: { userId: string }) {
    return ok(await this.wxpusher.sendTestMessage(user.userId))
  }

  @Delete('wxpusher')
  async wxpusherUnbind(@CurrentUser() user: { userId: string }) {
    return ok(await this.wxpusher.unbind(user.userId))
  }

  @Post(':id/read')
  async readOne(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    if (!actor.userId) return ok({ marked: false })
    return ok(await this.notifications.markRead(actor.userId, id))
  }
}
