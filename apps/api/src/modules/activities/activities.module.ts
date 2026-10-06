import { Module } from '@nestjs/common'
import { ActivityUserController, ActivityAdminController } from './activity.controller.js'
import { AttendanceAdminController } from '../attendance/attendance.admin.controller.js'
import { ActivityService } from './activity.service.js'
import { AttendanceService } from '../attendance/attendance.service.js'
import { ContestStandingsService } from './contest-standings.service.js'
import { VenueModule } from '../venues/venue.module.js'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'

@Module({
  imports: [VenueModule],
  controllers: [ActivityUserController, ActivityAdminController, AttendanceAdminController],
  providers: [ActivityService, AttendanceService, ContestStandingsService, JobsService, AuditService],
  exports: [ActivityService, AttendanceService, ContestStandingsService],
})
export class ActivitiesModule {}
