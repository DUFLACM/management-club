import { Module } from '@nestjs/common'
import { VenueAdminController } from './venue.controller.js'
import { VenueService } from './venue.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'

@Module({
  controllers: [VenueAdminController],
  providers: [VenueService, AuditService],
  exports: [VenueService],
})
export class VenueModule {}
