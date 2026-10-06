import { Module } from '@nestjs/common'
import { EvaluationAdminController } from './evaluation.controller.js'
import { EvaluationService } from './evaluation.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'

@Module({
  controllers: [EvaluationAdminController],
  providers: [EvaluationService, AuditService],
  exports: [EvaluationService],
})
export class EvaluationModule {}
