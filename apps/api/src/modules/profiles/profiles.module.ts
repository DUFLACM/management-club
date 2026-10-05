import { Module } from '@nestjs/common'
import { ProfilesController, BadgesAdminController } from './profiles.controller.js'
import { ProfilesService } from './profiles.service.js'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'

@Module({
  controllers: [ProfilesController, BadgesAdminController],
  providers: [ProfilesService, JobsService],
  exports: [ProfilesService],
})
export class ProfilesModule {}
