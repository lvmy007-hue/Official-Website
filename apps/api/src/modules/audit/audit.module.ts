import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { AuditDetailService } from './audit-detail.service'
import { AuditListService } from './audit-list.service'
import { AuditPiiService } from './audit-pii.service'
import { AuditController } from './audit.controller'

@Module({ imports: [AuthModule], controllers: [AuditController], providers: [AuditListService, AuditDetailService, AuditPiiService] })
export class AuditModule {}
