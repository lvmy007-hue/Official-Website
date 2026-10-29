import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { TenantController } from './tenant.controller'
import { TenantService } from './tenant.service'

@Module({ imports: [AuthModule], controllers: [TenantController], providers: [TenantService], exports: [TenantService] })
export class TenantModule {}
