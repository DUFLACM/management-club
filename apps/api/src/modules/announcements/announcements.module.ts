import { Module } from '@nestjs/common'
import { AnnouncementsAdminController, AnnouncementsController } from './announcements.controller.js'
import { AnnouncementsService } from './announcements.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'

@Module({
  controllers: [AnnouncementsAdminController, AnnouncementsController],
  providers: [AnnouncementsService, AuditService],
})
export class AnnouncementsModule {}
