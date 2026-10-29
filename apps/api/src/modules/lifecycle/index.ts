// 租户注册与生命周期（租户侧）的公开面：邀请接受、初始化向导、支持访问授权、配额占用。
export { LifecycleModule } from './lifecycle.module'
export { OnboardingService } from './onboarding.service'
export { appPublicUrl, generateInviteToken, hashInviteToken, inviteLink, isWellFormedInviteToken } from './invitation-token'
export { createTenantWithDefaults } from './tenant-bootstrap'
export { quotaUsage } from './quota-usage'
export type { QuotaStatus, QuotaUsageClient } from './quota-usage'
export { currentStep, initialOnboardingState, isOnboardingComplete, parseOnboardingState } from './onboarding-state'
export type { OnboardingState } from './onboarding-state'
