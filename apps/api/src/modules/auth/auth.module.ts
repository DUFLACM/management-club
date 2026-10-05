import { Global, Module } from '@nestjs/common'
import { AuthController } from './auth.controller.js'
import { DevCasSimulatorController } from './dev-cas-simulator.controller.js'
import { AuthService } from './auth.service.js'
import { SessionService } from './session.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { AdminAuthController } from './admin-auth.controller.js'
import { AdminAuthService } from './admin-auth.service.js'

// SessionService 全局可用：SessionGuard 在各业务模块使用
@Global()
@Module({
  controllers: [AuthController, AdminAuthController, DevCasSimulatorController],
  providers: [AuthService, AdminAuthService, SessionService, AuditService],
  exports: [SessionService, AuthService, AdminAuthService],
})
export class AuthModule {}
