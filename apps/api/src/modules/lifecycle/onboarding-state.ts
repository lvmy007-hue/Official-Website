import { ONBOARDING_STEPS, type OnboardingStepKey, type OnboardingStepState } from '@nova/api-contracts'

// 初始化向导的保存格式（TenantOnboarding.stepStateJson）：每一步的状态与保存的内容。
export interface StepRecord {
  state: OnboardingStepState
  data?: unknown
  updatedAt?: string
}

export interface OnboardingState {
  steps: Record<OnboardingStepKey, StepRecord>
  /** 向导完成后触发的首次同步：开始时间与任务数（任务进度在同步中心查看） */
  firstSync?: { startedAt: string; jobs: number; segments: number }
}

export const initialOnboardingState = (): OnboardingState => ({
  steps: Object.fromEntries(ONBOARDING_STEPS.map(step => [step.key, { state: 'PENDING' as const }])) as Record<OnboardingStepKey, StepRecord>,
})

/** 读取保存的状态；缺失的步骤按“待处理”补齐（兼容以后新增步骤）。 */
export function parseOnboardingState(raw: unknown): OnboardingState {
  const base = initialOnboardingState()
  if (!raw || typeof raw !== 'object') return base
  const source = raw as Partial<OnboardingState>
  for (const step of ONBOARDING_STEPS) {
    const saved = source.steps?.[step.key]
    if (saved && ['PENDING', 'COMPLETED', 'SKIPPED'].includes(saved.state)) base.steps[step.key] = saved
  }
  if (source.firstSync) base.firstSync = source.firstSync
  return base
}

/** 当前应该停留的步骤：第一个未完成也未跳过的；全部处理完则为 DONE。 */
export function currentStep(state: OnboardingState): OnboardingStepKey | 'DONE' {
  return ONBOARDING_STEPS.find(step => state.steps[step.key].state === 'PENDING')?.key ?? 'DONE'
}

/** 必填步骤全部完成才算向导完成；选填步骤可以跳过。 */
export const isOnboardingComplete = (state: OnboardingState) =>
  ONBOARDING_STEPS.every(step => (step.required ? state.steps[step.key].state === 'COMPLETED' : state.steps[step.key].state !== 'PENDING'))
