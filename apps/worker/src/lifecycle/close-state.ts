// 注销流程的状态（Tenant.closeStateJson）：与 @nova/api-contracts 的 CLOSE_STEPS / CloseState 保持一致（close-state.test.ts 核对）。
// 后台任务不直接依赖契约包，这里放一份同构的定义。

export const CLOSE_STEP_KEYS = ['EXPORT', 'REVOKE_AUTH', 'DELETE_TOKENS', 'DELETE_PII', 'DELETE_DATA', 'PROOF'] as const
export type CloseStepKey = (typeof CLOSE_STEP_KEYS)[number]

export interface CloseStepRecord {
  state: 'PENDING' | 'DONE' | 'FAILED'
  finishedAt?: string
  detail?: Record<string, unknown>
  error?: string
}

export interface CloseState {
  runs: number
  startedAt: string
  requestedBy: string
  steps: Record<CloseStepKey, CloseStepRecord>
  export?: { key: string; bytes: number; sha256: string; rows: number; expiresAt: string }
  proof?: { completedAt: string; tables: Record<string, number>; files: number; authorizationsRevokedLocally: number }
  failed?: boolean
  /** 到期清理的完成时间：导出包（30 天）与审计（730 天） */
  purged?: { export?: string; audit?: string }
}

/** 读取保存的状态；缺失的步骤补为“待处理”。 */
export function parseCloseState(raw: unknown, fallbackActor = 'unknown'): CloseState {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<CloseState>
  const steps = {} as Record<CloseStepKey, CloseStepRecord>
  for (const key of CLOSE_STEP_KEYS) steps[key] = source.steps?.[key] && ['PENDING', 'DONE', 'FAILED'].includes(source.steps[key].state) ? source.steps[key] : { state: 'PENDING' }
  return { ...source, runs: source.runs ?? 1, startedAt: source.startedAt ?? new Date().toISOString(), requestedBy: source.requestedBy ?? fallbackActor, steps }
}
