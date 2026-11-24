import { Global, Module } from '@nestjs/common'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'
import { NotificationsService } from './notifications.service.js'
import { NotificationsController } from './notifications.controller.js'
import { WxPusherService } from './wxpusher.service.js'
import { WxPusherWebhookController } from './wxpusher-webhook.controller.js'

@Global()
@Module({
  providers: [NotificationsService, WxPusherService, JobsService],
  controllers: [NotificationsController, WxPusherWebhookController],
  exports: [NotificationsService, WxPusherService],
})
export class NotificationsModule {}
