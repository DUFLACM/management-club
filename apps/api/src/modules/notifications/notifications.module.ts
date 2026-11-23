import { Global, Module } from '@nestjs/common'
import { NotificationsService } from './notifications.service.js'
import { NotificationsController } from './notifications.controller.js'

@Global()
@Module({
  providers: [NotificationsService],
  controllers: [NotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
