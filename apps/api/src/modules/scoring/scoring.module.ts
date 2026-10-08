import { Module } from '@nestjs/common'
import { ScoringMeController, ScoringAdminController } from './scoring.controller.js'
import { ScoringService } from './scoring.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { ActivitiesModule } from '../activities/activities.module.js'
import { ContestSettleScheduler } from './contest-settle.scheduler.js'
import { HistoryImportController } from './history-import.controller.js'
import { HistoryImportService } from './history-import.service.js'

@Module({
  imports: [ActivitiesModule],
  controllers: [ScoringMeController, ScoringAdminController, HistoryImportController],
  providers: [ScoringService, AuditService, ContestSettleScheduler, HistoryImportService],
  exports: [ScoringService],
})
export class ScoringModule {}
