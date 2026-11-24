import { Module } from '@nestjs/common'
import { ScoringMeController, ScoringAdminController } from './scoring.controller.js'
import { ScoringService } from './scoring.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { ActivitiesModule } from '../activities/activities.module.js'
import { ContestSettleScheduler } from './contest-settle.scheduler.js'
import { HistoryImportController } from './history-import.controller.js'
import { HistoryImportService } from './history-import.service.js'
import { CompetitionImportController } from './competition-import.controller.js'
import { CompetitionImportService } from './competition-import.service.js'

@Module({
  imports: [ActivitiesModule],
  controllers: [ScoringMeController, ScoringAdminController, HistoryImportController, CompetitionImportController],
  providers: [ScoringService, AuditService, ContestSettleScheduler, HistoryImportService, CompetitionImportService],
  exports: [ScoringService],
})
export class ScoringModule {}
