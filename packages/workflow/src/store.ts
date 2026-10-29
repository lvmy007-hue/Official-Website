// 流程状态机的存储接口与内存实现。真实存储（PostgreSQL）见 prisma-store.ts，两者行为一致，由同一套契约测试覆盖。

export type RunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'COMPENSATED' | 'CANCELLED'
export type StepStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'COMPENSATED' | 'SKIPPED'

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['SUCCEEDED', 'FAILED', 'COMPENSATED', 'CANCELLED']

export interface RunRecord {
  id: string
  tenantId: string
  kind: string
  status: RunStatus
  dedupeKey: string | null
  intent: unknown
  result: unknown | null
  checkpoint: unknown | null
  errorCode: string | null
  priority: number
  attempt: number
  syncJobId: string | null
  startedAt: Date
  finishedAt: Date | null
  heartbeatAt: Date
  deadlineAt: Date | null
  lockOwner: string | null
}

export interface StepRecord {
  id: string
  tenantId: string
  runId: string
  seq: number
  name: string
  status: StepStatus
  request: unknown | null
  response: unknown | null
  errorCode: string | null
  attempt: number
  nextRunAt: Date | null
  startedAt: Date | null
  finishedAt: Date | null
}

export interface CreateRunInput {
  tenantId: string
  kind: string
  dedupeKey?: string | null
  intent: unknown
  priority?: number
  syncJobId?: string | null
  deadlineAt?: Date | null
}

export type RunPatch = Partial<Omit<RunRecord, 'id' | 'tenantId' | 'kind' | 'startedAt' | 'dedupeKey' | 'intent'>>
export type StepPatch = Partial<Omit<StepRecord, 'id' | 'tenantId' | 'runId' | 'seq'>>

export interface WorkflowStore {
  /** 按 (租户, 类型, 去重键) 去重：已有同键流程返回它且 created=false，绝不重复创建。 */
  createRun(input: CreateRunInput, now: Date): Promise<{ run: RunRecord; created: boolean }>
  getRun(tenantId: string, runId: string): Promise<RunRecord | null>
  updateRun(tenantId: string, runId: string, patch: RunPatch): Promise<RunRecord>
  getStep(tenantId: string, runId: string, seq: number): Promise<StepRecord | null>
  /** 不存在则按 name 创建，再应用 patch。 */
  saveStep(tenantId: string, runId: string, seq: number, name: string, patch: StepPatch): Promise<StepRecord>
  listSteps(tenantId: string, runId: string): Promise<StepRecord[]>
  /** 跨租户：心跳早于 staleBefore 的运行中流程（崩溃恢复用，必须由系统连接实现）。 */
  listStaleRuns(staleBefore: Date, limit: number): Promise<RunRecord[]>
}

let counter = 0
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(++counter).toString(36)}`

export class MemoryWorkflowStore implements WorkflowStore {
  readonly runs = new Map<string, RunRecord>()
  readonly steps = new Map<string, StepRecord>()

  async createRun(input: CreateRunInput, now: Date) {
    if (input.dedupeKey) {
      for (const run of this.runs.values()) {
        if (run.tenantId === input.tenantId && run.kind === input.kind && run.dedupeKey === input.dedupeKey) return { run: { ...run }, created: false }
      }
    }
    const run: RunRecord = {
      id: nextId('run'),
      tenantId: input.tenantId,
      kind: input.kind,
      status: 'RUNNING',
      dedupeKey: input.dedupeKey ?? null,
      intent: structuredClone(input.intent),
      result: null,
      checkpoint: null,
      errorCode: null,
      priority: input.priority ?? 3,
      attempt: 0,
      syncJobId: input.syncJobId ?? null,
      startedAt: now,
      finishedAt: null,
      heartbeatAt: now,
      deadlineAt: input.deadlineAt ?? null,
      lockOwner: null,
    }
    this.runs.set(run.id, run)
    return { run: { ...run }, created: true }
  }

  async getRun(tenantId: string, runId: string) {
    const run = this.runs.get(runId)
    return run && run.tenantId === tenantId ? { ...run } : null
  }

  async updateRun(tenantId: string, runId: string, patch: RunPatch) {
    const run = this.runs.get(runId)
    if (!run || run.tenantId !== tenantId) throw new Error(`流程 ${runId} 不存在`)
    Object.assign(run, structuredClone(patch))
    return { ...run }
  }

  async getStep(tenantId: string, runId: string, seq: number) {
    const step = this.steps.get(`${runId}:${seq}`)
    return step && step.tenantId === tenantId ? { ...step } : null
  }

  async saveStep(tenantId: string, runId: string, seq: number, name: string, patch: StepPatch) {
    const key = `${runId}:${seq}`
    let step = this.steps.get(key)
    if (!step) {
      step = { id: nextId('step'), tenantId, runId, seq, name, status: 'PENDING', request: null, response: null, errorCode: null, attempt: 0, nextRunAt: null, startedAt: null, finishedAt: null }
      this.steps.set(key, step)
    }
    Object.assign(step, structuredClone(patch))
    return { ...step }
  }

  async listSteps(tenantId: string, runId: string) {
    return [...this.steps.values()]
      .filter(step => step.tenantId === tenantId && step.runId === runId)
      .sort((a, b) => a.seq - b.seq)
      .map(step => ({ ...step }))
  }

  async listStaleRuns(staleBefore: Date, limit: number) {
    return [...this.runs.values()]
      .filter(run => run.status === 'RUNNING' && run.heartbeatAt < staleBefore)
      .slice(0, limit)
      .map(run => ({ ...run }))
  }
}
