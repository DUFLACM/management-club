import { Module } from '@nestjs/common'
import { ScoringMeController, ScoringAdminController } from './scoring.controller.js'
import { ScoringService } from './scoring.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'

@Module({
  controllers: [ScoringMeController, ScoringAdminController],
  providers: [ScoringService, AuditService],
  exports: [ScoringService],
})
export class ScoringModule {}
