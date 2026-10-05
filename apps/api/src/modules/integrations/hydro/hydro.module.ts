import { Module } from '@nestjs/common'
import { HydroController } from './hydro.controller.js'
import { HydroService } from './hydro.service.js'
import { JobsService } from '../../../infrastructure/jobs/jobs.service.js'

@Module({
  controllers: [HydroController],
  providers: [HydroService, JobsService],
  exports: [HydroService],
})
export class HydroModule {}
