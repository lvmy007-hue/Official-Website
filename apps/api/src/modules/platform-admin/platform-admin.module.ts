import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { PlatformAuthController, PlatformTenantsController } from './platform-admin.controller'
import { PlatformAuditService } from './platform-audit.service'
import { PlatformAuthService } from './platform-auth.service'
import { PlatformLifecycleService } from './platform-lifecycle.service'
import { PlatformGuard } from './platform.guard'
import { PlatformSupportService } from './platform-support.service'
import { PlatformTenantsService } from './platform-tenants.service'

// 平台运营后台：独立的账号体系与令牌，只提供 /platform/* 接口；引入 AuthModule 仅为使用其导出的 JwtModule。
@Module({
  imports: [AuthModule],
  controllers: [PlatformAuthController, PlatformTenantsController],
  providers: [PlatformAuthService, PlatformTenantsService, PlatformLifecycleService, PlatformSupportService, PlatformAuditService, PlatformGuard],
})
export class PlatformAdminModule {}
