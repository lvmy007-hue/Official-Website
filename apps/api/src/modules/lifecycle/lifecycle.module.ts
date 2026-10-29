import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { InitialSyncService } from './initial-sync.service'
import { InvitationService } from './invitation.service'
import { InvitationController, OnboardingController } from './lifecycle.controller'
import { OnboardingService } from './onboarding.service'
import { SupportGrantService } from './support-grant.service'

@Module({
  imports: [AuthModule],
  controllers: [InvitationController, OnboardingController],
  providers: [InvitationService, OnboardingService, InitialSyncService, SupportGrantService],
  exports: [OnboardingService],
})
export class LifecycleModule {}
