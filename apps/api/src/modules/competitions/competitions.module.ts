import { Module } from '@nestjs/common'
import { CompetitionMeController, CompetitionAdminController } from './competition-event.controller.js'
import { TeamMeController, TeamAdminController } from './team.controller.js'
import { CompetitionEventService } from './competition-event.service.js'
import { TeamService } from './team.service.js'
import { CompetitionSettleScheduler } from './competition-settle.scheduler.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { ScoringModule } from '../scoring/scoring.module.js'
import { ActivitiesModule } from '../activities/activities.module.js'

@Module({
  imports: [ScoringModule, ActivitiesModule],
  controllers: [CompetitionMeController, CompetitionAdminController, TeamMeController, TeamAdminController],
  providers: [CompetitionEventService, TeamService, AuditService, CompetitionSettleScheduler],
  exports: [CompetitionEventService, TeamService],
})
export class CompetitionsModule {}
