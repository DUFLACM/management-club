import { Module } from '@nestjs/common'
import { EvaluationAdminController, EvaluationMemberController, EvaluationPublicController } from './evaluation.controller.js'
import { EvaluationService } from './evaluation.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'

@Module({
  controllers: [EvaluationAdminController, EvaluationMemberController, EvaluationPublicController],
  providers: [EvaluationService, AuditService],
  exports: [EvaluationService],
})
export class EvaluationModule {}
