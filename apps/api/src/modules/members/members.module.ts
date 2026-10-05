import { Module } from '@nestjs/common'
import { MeController, MembersAdminController } from './members.controller.js'
import { MembersService } from './members.service.js'
import { AuthModule } from '../auth/auth.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'

@Module({
  imports: [AuthModule],
  controllers: [MeController, MembersAdminController],
  providers: [MembersService, AuditService],
})
export class MembersModule {}
