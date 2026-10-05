import { Module } from '@nestjs/common'
import { SettingsController, SecretsController } from './settings.controller.js'
import { SettingsService } from './settings.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'

@Module({
  controllers: [SettingsController, SecretsController],
  providers: [SettingsService, AuditService],
  exports: [SettingsService],
})
export class SettingsModule {}
