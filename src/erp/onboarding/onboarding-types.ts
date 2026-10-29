import type { OnboardingStepKey } from '@nova/api-contracts'
import type { QuotaStatus } from '../platform/platform-queries'

// 初始化向导（P1-19）的数据类型：与服务端 GET/PATCH /onboarding 的返回一致。

export type StepState = 'PENDING' | 'COMPLETED' | 'SKIPPED'
export type StepAction = 'SAVE' | 'COMPLETE' | 'SKIP'

export type StepInfo = {
  key: OnboardingStepKey
  no: number
  title: string
  required: boolean
  hint: string
  state: StepState
  data: unknown
  prerequisite: { met: boolean; message?: string }
}

export type InvitationResult = { email: string; link: string | null; expiresAt: string; emailed: boolean }

export type OnboardingView = {
  initialized: boolean
  version: number
  completed: boolean
  completedAt: string | null
  currentStep: OnboardingStepKey | 'DONE'
  steps: StepInfo[]
  tenant: { name: string; timezone: string; localTimezone: string; defaultCurrency: string }
  quotas: QuotaStatus[]
  firstSync: { startedAt: string; jobs: number; segments: number } | null
  /** 仅 PATCH 响应带：本次生成的邀请（邮件未配置时含一次性链接） */
  invitations?: InvitationResult[]
  /** 仅 PATCH 响应带：超配额等不阻断的提示 */
  warnings?: string[]
}

/** 每个步骤面板的统一入参：提交动作由向导页面调用服务端。 */
export type StepPanelProps = {
  step: StepInfo
  view: OnboardingView
  busy: boolean
  onSubmit: (action: StepAction, data?: unknown) => void
}
