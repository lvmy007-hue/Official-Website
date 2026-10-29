import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { PreferencesService } from './preferences.service'
import { ProfileController } from './profile.controller'

@Module({
  imports: [AuthModule],
  controllers: [ProfileController],
  providers: [PreferencesService],
})
export class ProfileModule {}
