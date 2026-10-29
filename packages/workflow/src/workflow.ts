// 流程状态机引擎（12.3）：所有异步流程 = 状态机 + 持久化步骤记录。
// 对外部有副作用的步骤（亚马逊写操作）遵循“先记录意图 → 调用 → 记录结果”：
//   1. 调用之前，把请求（含稳定的幂等键）写入步骤记录；
//   2. 调用成功后，把响应写入步骤记录；
//   3. 进程崩溃或超时后重新执行时，若该步骤曾经发出过调用，先用 reconcile 去亚马逊查询状态，
//      查到就直接采用查到的结果，查不到才重新调用——因此不会重复创建亚马逊对象。
// 不可重试的失败会按相反顺序执行补偿动作；可重试的失败按指数退避+抖动留给队列重试。

import { backoffDelayMs, type BackoffOptions } from './backoff'
import { classifyError, NonRetryableError, RetryableError, WorkflowError } from './errors'
import type { LockLease } from './lock'
import { TERMINAL_RUN_STATUSES, type CreateRunInput, type RunRecord, type StepRecord, type WorkflowStore } from './store'

export interface StepContext<TIntent = any> {
  tenantId: string
  runId: string
  seq: number
  name: string
  intent: TIntent
  /** 调用前已持久化的请求（意图）：重试与恢复都复用同一份，其中的幂等键保持不变。 */
  request: any
  /** 本步骤第几次执行（从 1 开始）。 */
  attempt: number
  /** 上一次执行是否发出过调用但没有留下结果（崩溃/超时后的恢复）。 */
  recovered: boolean
  checkpoint: unknown | null
  responseOf(seq: number): unknown
  saveCheckpoint(value: unknown): Promise<void>
  heartbeat(): Promise<void>
}

export type ReconcileResult = { found: true; response: unknown } | { found: false }

export interface StepDefinition<TIntent = any> {
  name: string
  /** 构造请求（意图）。只在第一次执行时调用，结果被持久化。 */
  buildRequest?(ctx: Omit<StepContext<TIntent>, 'request'>): unknown | Promise<unknown>
  run(ctx: StepContext<TIntent>): Promise<unknown>
  /** 有外部副作用的步骤必须提供：去外部系统查询这次请求是否已经生效。 */
  reconcile?(ctx: StepContext<TIntent>): Promise<ReconcileResult>
  /** 补偿动作：流程失败时按相反顺序撤销已成功步骤的副作用。 */
  compensate?(ctx: StepContext<TIntent> & { response: unknown }): Promise<void>
}

export interface WorkflowDefinition<TIntent = any> {
  kind: string
  steps: StepDefinition<TIntent>[]
}

export interface ExecuteOptions {
  owner?: string
  /** 分布式锁租约：每个步骤前后检查，丢锁立刻停止。 */
  lease?: { assertHeld(): void }
  /** 为 true 时可重试错误也直接按失败处理（队列重试已用尽）。 */
  isLastAttempt?: boolean
}

export interface EngineOptions {
  ownerId?: string
  now?: () => Date
  backoff?: BackoffOptions
  /** 流程级最大执行次数，超过后可重试错误也判失败。默认 5。 */
  maxRunAttempts?: number
  heartbeatEveryMs?: number
}

export interface RecoverResult {
  runId: string
  tenantId: string
  outcome: 'resumed' | 'failed' | 'retry-later' | 'skipped'
  errorCode?: string
}

export class WorkflowEngine {
  private readonly definitions = new Map<string, WorkflowDefinition>()
  private readonly now: () => Date
  private readonly ownerId: string
  private readonly maxRunAttempts: number

  constructor(
    private readonly store: WorkflowStore,
    private readonly options: EngineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.ownerId = options.ownerId ?? `engine-${process.pid}`
    this.maxRunAttempts = options.maxRunAttempts ?? 5
  }

  register(definition: WorkflowDefinition) {
    this.definitions.set(definition.kind, definition)
    return this
  }

  start(input: CreateRunInput) {
    return this.store.createRun(input, this.now())
  }

  async execute(tenantId: string, runId: string, definition: WorkflowDefinition, options: ExecuteOptions = {}): Promise<RunRecord> {
    let run = await this.mustGetRun(tenantId, runId)
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return run
    const owner = options.owner ?? this.ownerId
    run = await this.store.updateRun(tenantId, runId, { attempt: run.attempt + 1, lockOwner: owner, heartbeatAt: this.now() })
    const isLastAttempt = options.isLastAttempt ?? run.attempt >= this.maxRunAttempts

    const stopHeartbeat = this.startHeartbeat(tenantId, runId)
    try {
      if (run.deadlineAt && run.deadlineAt < this.now()) {
        throw await this.failRun(tenantId, runId, definition, 'WORKFLOW_DEADLINE_EXCEEDED', '流程超过截止时间，已停止并执行补偿')
      }
      let lastResponse: unknown = null
      for (let seq = 0; seq < definition.steps.length; seq++) {
        options.lease?.assertHeld()
        lastResponse = await this.runStep(run, definition, seq, options, isLastAttempt)
      }
      options.lease?.assertHeld()
      return await this.store.updateRun(tenantId, runId, { status: 'SUCCEEDED', result: lastResponse ?? null, finishedAt: this.now(), heartbeatAt: this.now(), errorCode: null })
    } finally {
      stopHeartbeat()
    }
  }

  /** 把仍在运行但心跳过期的流程（进程崩溃遗留）重新接起来：已完成的步骤直接复用，未完成的步骤先对账再继续。 */
  async recover(options: { staleMs: number; limit?: number; lockFor?: (run: RunRecord) => Promise<LockLease | null> }): Promise<RecoverResult[]> {
    const stale = await this.store.listStaleRuns(new Date(this.now().getTime() - options.staleMs), options.limit ?? 50)
    const results: RecoverResult[] = []
    for (const run of stale) {
      const definition = this.definitions.get(run.kind)
      if (!definition) {
        await this.store.updateRun(run.tenantId, run.id, { status: 'FAILED', errorCode: 'WORKFLOW_KIND_UNKNOWN', finishedAt: this.now() })
        results.push({ runId: run.id, tenantId: run.tenantId, outcome: 'failed', errorCode: 'WORKFLOW_KIND_UNKNOWN' })
        continue
      }
      // 抢流程锁：另一个进程正在执行同一个流程（例如队列任务刚好也在跑）就跳过，避免同一步骤被并发执行。
      const lease = options.lockFor ? await options.lockFor(run) : undefined
      if (lease === null) {
        results.push({ runId: run.id, tenantId: run.tenantId, outcome: 'skipped' })
        continue
      }
      try {
        await this.execute(run.tenantId, run.id, definition, { lease })
        results.push({ runId: run.id, tenantId: run.tenantId, outcome: 'resumed' })
      } catch (error) {
        const info = classifyError(error)
        results.push({ runId: run.id, tenantId: run.tenantId, outcome: info.retryable ? 'retry-later' : 'failed', errorCode: info.code })
      } finally {
        await lease?.release().catch(() => undefined)
      }
    }
    return results
  }

  /** 主动取消：已成功的步骤执行补偿。 */
  async cancel(tenantId: string, runId: string, definition: WorkflowDefinition): Promise<RunRecord> {
    const run = await this.mustGetRun(tenantId, runId)
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return run
    await this.compensate(run, definition)
    return this.store.updateRun(tenantId, runId, { status: 'CANCELLED', finishedAt: this.now(), errorCode: 'WORKFLOW_CANCELLED' })
  }

  // ---- 内部 ----

  private async mustGetRun(tenantId: string, runId: string) {
    const run = await this.store.getRun(tenantId, runId)
    if (!run) throw new NonRetryableError('WORKFLOW_RUN_NOT_FOUND', `流程 ${runId} 不存在`)
    return run
  }

  private startHeartbeat(tenantId: string, runId: string) {
    const every = this.options.heartbeatEveryMs ?? 15_000
    const timer = setInterval(() => {
      void this.store.updateRun(tenantId, runId, { heartbeatAt: this.now() }).catch(() => undefined)
    }, every)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  private async runStep(run: RunRecord, definition: WorkflowDefinition, seq: number, options: ExecuteOptions, isLastAttempt: boolean): Promise<unknown> {
    const def = definition.steps[seq]
    const { tenantId } = run
    let step = await this.store.getStep(tenantId, run.id, seq)
    if (step?.status === 'SUCCEEDED') return step.response // 断点续传：已完成的步骤不再执行

    const context = async (current: StepRecord | null, recovered: boolean): Promise<StepContext> => {
      const steps = await this.store.listSteps(tenantId, run.id)
      return {
        tenantId,
        runId: run.id,
        seq,
        name: def.name,
        intent: run.intent,
        request: current?.request ?? null,
        attempt: (current?.attempt ?? 0) + 1,
        recovered,
        checkpoint: run.checkpoint,
        responseOf: (index: number) => steps.find(item => item.seq === index)?.response ?? null,
        saveCheckpoint: async value => {
          await this.store.updateRun(tenantId, run.id, { checkpoint: value, heartbeatAt: this.now() })
        },
        heartbeat: async () => {
          await this.store.updateRun(tenantId, run.id, { heartbeatAt: this.now() })
        },
      }
    }

    // 恢复：上一次发出过调用却没有留下结果 → 先对账。
    const mayHaveCalled = !!step && step.startedAt !== null
    if (def.reconcile && mayHaveCalled) {
      const found = await def.reconcile(await context(step, true))
      if (found.found) {
        step = await this.store.saveStep(tenantId, run.id, seq, def.name, { status: 'SUCCEEDED', response: found.response, finishedAt: this.now(), errorCode: null, nextRunAt: null })
        return step.response
      }
    }

    // 记录意图：请求只构造一次并持久化，之后的重试与恢复都复用同一份（幂等键不变）。
    let request = step?.request ?? null
    if (request === null && def.buildRequest) {
      request = (await def.buildRequest(await context(step, false))) ?? null
    }
    step = await this.store.saveStep(tenantId, run.id, seq, def.name, {
      status: 'RUNNING',
      request,
      attempt: (step?.attempt ?? 0) + 1,
      startedAt: step?.startedAt ?? this.now(),
      errorCode: null,
      nextRunAt: null,
    })
    const ctx = await context({ ...step, attempt: step.attempt - 1 }, mayHaveCalled)
    ctx.request = request

    try {
      const response = await def.run(ctx)
      options.lease?.assertHeld() // 丢锁后不得记录结果
      step = await this.store.saveStep(tenantId, run.id, seq, def.name, { status: 'SUCCEEDED', response: response ?? null, finishedAt: this.now(), errorCode: null })
      await this.store.updateRun(tenantId, run.id, { heartbeatAt: this.now() })
      return step.response
    } catch (error) {
      const info = classifyError(error)
      if (info.retryable && isLastAttempt && def.reconcile) {
        // 最后一次机会：超时类错误下对象可能已经创建，宣告失败前再对账一次，避免“其实成功了却记成失败”。
        const found = await def.reconcile(await context({ ...step, attempt: step.attempt - 1 }, true)).catch(() => ({ found: false as const }))
        if (found.found) {
          step = await this.store.saveStep(tenantId, run.id, seq, def.name, { status: 'SUCCEEDED', response: found.response, finishedAt: this.now(), errorCode: null, nextRunAt: null })
          return step.response
        }
      }
      if (info.retryable && !isLastAttempt) {
        const delay = backoffDelayMs(step.attempt, this.options.backoff, info.retryAfterMs)
        // 状态回到 PENDING 但保留 startedAt：下次执行会先对账（外部调用可能已经生效）。
        await this.store.saveStep(tenantId, run.id, seq, def.name, { status: 'PENDING', errorCode: info.code, nextRunAt: new Date(this.now().getTime() + delay) })
        throw new RetryableError(info.code, error instanceof Error ? error.message : String(error), delay)
      }
      const code = info.retryable ? 'RETRIES_EXHAUSTED' : info.code
      await this.store.saveStep(tenantId, run.id, seq, def.name, { status: 'FAILED', errorCode: info.code, finishedAt: this.now() })
      throw await this.failRun(tenantId, run.id, definition, code, error instanceof Error ? error.message : String(error), info.code)
    }
  }

  private async failRun(tenantId: string, runId: string, definition: WorkflowDefinition, code: string, message: string, rootCode?: string): Promise<WorkflowError> {
    const run = await this.mustGetRun(tenantId, runId)
    const outcome = await this.compensate(run, definition)
    const status = outcome.failed > 0 ? 'FAILED' : outcome.compensated > 0 ? 'COMPENSATED' : 'FAILED'
    const errorCode = outcome.failed > 0 ? 'COMPENSATION_FAILED' : code
    await this.store.updateRun(tenantId, runId, { status, errorCode, finishedAt: this.now(), heartbeatAt: this.now() })
    return new NonRetryableError(errorCode, rootCode && rootCode !== code ? `${message}（原始错误 ${rootCode}）` : message)
  }

  /** 按相反顺序补偿已成功的步骤；单个补偿失败不阻止其余补偿，最终汇总。 */
  private async compensate(run: RunRecord, definition: WorkflowDefinition): Promise<{ compensated: number; failed: number }> {
    const steps = (await this.store.listSteps(run.tenantId, run.id)).filter(step => step.status === 'SUCCEEDED').sort((a, b) => b.seq - a.seq)
    let compensated = 0
    let failed = 0
    for (const step of steps) {
      const def = definition.steps[step.seq]
      if (!def?.compensate) continue
      try {
        const all = await this.store.listSteps(run.tenantId, run.id)
        await def.compensate({
          tenantId: run.tenantId,
          runId: run.id,
          seq: step.seq,
          name: def.name,
          intent: run.intent,
          request: step.request,
          attempt: step.attempt,
          recovered: false,
          checkpoint: null,
          responseOf: index => all.find(item => item.seq === index)?.response ?? null,
          saveCheckpoint: async () => undefined,
          heartbeat: async () => undefined,
          response: step.response,
        })
        await this.store.saveStep(run.tenantId, run.id, step.seq, step.name, { status: 'COMPENSATED', finishedAt: this.now() })
        compensated++
      } catch (error) {
        failed++
        await this.store.saveStep(run.tenantId, run.id, step.seq, step.name, { errorCode: 'COMPENSATION_FAILED' })
        void error
      }
    }
    return { compensated, failed }
  }
}
