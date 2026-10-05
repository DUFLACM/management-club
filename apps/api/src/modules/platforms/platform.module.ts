import { Module } from '@nestjs/common'
import { PlatformMeController, PlatformAdminController } from './platform.controller.js'
import { PlatformService } from './platform.service.js'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'

@Module({
  controllers: [PlatformMeController, PlatformAdminController],
  providers: [PlatformService, JobsService],
  exports: [PlatformService],
})
export class PlatformModule {}
