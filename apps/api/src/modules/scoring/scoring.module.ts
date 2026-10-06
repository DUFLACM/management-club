import { Module } from '@nestjs/common'
import { ScoringMeController, ScoringAdminController } from './scoring.controller.js'
import { ScoringService } from './scoring.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { ActivitiesModule } from '../activities/activities.module.js'
import { ContestSettleScheduler } from './contest-settle.scheduler.js'

@Module({
  imports: [ActivitiesModule],
  controllers: [ScoringMeController, ScoringAdminController],
  providers: [ScoringService, AuditService, ContestSettleScheduler],
  exports: [ScoringService],
})
export class ScoringModule {}
