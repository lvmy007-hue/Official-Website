import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { EnterpriseSettingsController } from './enterprise-settings.controller'
import { EnterpriseSettingsReadService } from './enterprise-settings-read.service'
import { EnterpriseSettingsWriteService } from './enterprise-settings-write.service'
import { SettingsController } from './settings.controller'
import { SettingsService } from './settings.service'

@Module({
  imports: [AuthModule],
  controllers: [SettingsController, EnterpriseSettingsController],
  providers: [SettingsService, EnterpriseSettingsReadService, EnterpriseSettingsWriteService],
  exports: [SettingsService],
})
export class SettingsModule {}
