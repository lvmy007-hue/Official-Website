import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { SettingsModule } from '../settings'
import { FxController } from './fx.controller'
import { FxService } from './fx.service'
import { FxWriteService } from './fx-write.service'

@Module({ imports: [AuthModule, SettingsModule], controllers: [FxController], providers: [FxService, FxWriteService], exports: [FxWriteService] })
export class FxModule {}
