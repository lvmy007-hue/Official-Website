import { describe, expect, it } from 'vitest'
import { DistributedLockManager, MemoryLockStore, MemoryWorkflowStore, NonRetryableError, RetryableError, WorkflowEngine, type WorkflowDefinition, type WorkflowStore } from './index'

// 假亚马逊：故意不做服务端去重——如果引擎重复调用创建，对象数量就会变成 2，测试会抓到。
class FakeAmazon {
  objects: Array<{ id: string; clientRequestId: string }> = []
  createCalls = 0
  failBeforeCommit = 0
  failAfterCommit = 0
  onAfterCommit: (() => void) | null = null
  async create(clientRequestId: string) {
    this.createCalls++
    if (this.failBeforeCommit > 0) {
      this.failBeforeCommit--
      throw Object.assign(new Error('服务暂不可用'), { status: 503 })
    }
    const object = { id: `OBJ-${this.objects.length + 1}`, clientRequestId }
    this.objects.push(object)
    this.onAfterCommit?.()
    if (this.failAfterCommit > 0) {
      this.failAfterCommit--
      throw Object.assign(new Error('响应超时'), { code: 'ETIMEDOUT' })
    }
    return object
  }
  async find(clientRequestId: string) {
    return this.objects.find(object => object.clientRequestId === clientRequestId) ?? null
  }
  async remove(id: string) {
    this.objects = this.objects.filter(object => object.id !== id)
  }
}

/** 进程“猝死”模拟：死亡后所有存储写入都失败，状态停留在崩溃那一刻；复活后可继续使用同一份数据。 */
class CrashableStore implements WorkflowStore {
  dead = false
  constructor(readonly inner = new MemoryWorkflowStore()) {}
  private guard<T>(fn: () => Promise<T>) {
    if (this.dead) throw new Error('进程已终止')
    return fn()
  }
  createRun: WorkflowStore['createRun'] = (input, now) => this.guard(() => this.inner.createRun(input, now))
  getRun: WorkflowStore['getRun'] = (t, r) => this.guard(() => this.inner.getRun(t, r))
  updateRun: WorkflowStore['updateRun'] = (t, r, p) => this.guard(() => this.inner.updateRun(t, r, p))
  getStep: WorkflowStore['getStep'] = (t, r, s) => this.guard(() => this.inner.getStep(t, r, s))
  saveStep: WorkflowStore['saveStep'] = (t, r, s, n, p) => this.guard(() => this.inner.saveStep(t, r, s, n, p))
  listSteps: WorkflowStore['listSteps'] = (t, r) => this.guard(() => this.inner.listSteps(t, r))
  listStaleRuns: WorkflowStore['listStaleRuns'] = (b, l) => this.guard(() => this.inner.listStaleRuns(b, l))
}

function build() {
  let now = new Date('2026-10-21T00:00:00Z')
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms)
    },
  }
  const amazon = new FakeAmazon()
  const store = new CrashableStore()
  const log: string[] = []
  const definition: WorkflowDefinition = {
    kind: 'listing.create',
    steps: [
      {
        name: '校验',
        run: async () => {
          log.push('校验')
          return { ok: true }
        },
      },
      {
        name: '创建亚马逊对象',
        buildRequest: ctx => ({ clientRequestId: `req-${ctx.runId}` }),
        run: async ctx => amazon.create(ctx.request.clientRequestId),
        reconcile: async ctx => {
          const found = await amazon.find(ctx.request.clientRequestId)
          return found ? { found: true, response: found } : { found: false }
        },
        compensate: async ctx => {
          log.push('补偿：删除亚马逊对象')
          await amazon.remove((ctx.response as { id: string }).id)
        },
      },
      {
        name: '登记结果',
        run: async ctx => {
          log.push('登记')
          return { objectId: (ctx.responseOf(1) as { id: string }).id }
        },
        compensate: async () => {
          log.push('补偿：撤销登记')
        },
      },
    ],
  }
  const engine = new WorkflowEngine(store, { now: clock.now, backoff: { baseMs: 1000, jitter: 0 }, maxRunAttempts: 4 })
  engine.register(definition)
  return { amazon, store, log, definition, engine, clock }
}

const intent = { sku: 'SKU-1' }

describe('流程状态机：正常路径与去重', () => {
  it('按顺序执行，逐步持久化，最终结果为最后一步响应', async () => {
    const { engine, definition, store } = build()
    const { run } = await engine.start({ tenantId: 't1', kind: definition.kind, intent })
    const done = await engine.execute('t1', run.id, definition)
    expect(done.status).toBe('SUCCEEDED')
    expect(done.result).toEqual({ objectId: 'OBJ-1' })
    const steps = await store.listSteps('t1', run.id)
    expect(steps.map(step => step.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED'])
    expect(steps[1].request).toEqual({ clientRequestId: `req-${run.id}` }) // 意图在调用前已持久化
  })

  it('同一去重键只会创建一个流程；已完成的流程再次执行不会重复调用亚马逊', async () => {
    const { engine, definition, amazon } = build()
    const first = await engine.start({ tenantId: 't1', kind: definition.kind, dedupeKey: 'sku-1', intent })
    const second = await engine.start({ tenantId: 't1', kind: definition.kind, dedupeKey: 'sku-1', intent })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.run.id).toBe(first.run.id)
    await engine.execute('t1', first.run.id, definition)
    await engine.execute('t1', first.run.id, definition)
    expect(amazon.createCalls).toBe(1)
    const other = await engine.start({ tenantId: 't2', kind: definition.kind, dedupeKey: 'sku-1', intent })
    expect(other.created).toBe(true) // 不同租户的同名去重键互不干扰
  })
})

describe('故障注入：重试与断点续传', () => {
  it('可重试错误：留下退避时间，下次只重做失败的步骤，已完成步骤不重跑', async () => {
    const { engine, definition, amazon, log, store, clock } = build()
    const { run } = await engine.start({ tenantId: 't1', kind: definition.kind, intent })
    amazon.failBeforeCommit = 1
    const error = await engine.execute('t1', run.id, definition).catch(e => e)
    expect(error).toBeInstanceOf(RetryableError)
    expect(error.code).toBe('HTTP_503')
    expect(error.retryAfterMs).toBe(1000)
    const step = await store.getStep('t1', run.id, 1)
    expect(step).toMatchObject({ status: 'PENDING', errorCode: 'HTTP_503', attempt: 1 })
    expect(step!.nextRunAt!.getTime()).toBe(clock.now().getTime() + 1000)
    expect((await store.getRun('t1', run.id))!.status).toBe('RUNNING')

    const done = await engine.execute('t1', run.id, definition)
    expect(done.status).toBe('SUCCEEDED')
    expect(log.filter(item => item === '校验')).toHaveLength(1) // 断点续传：第 0 步没有重跑
    expect(amazon.objects).toHaveLength(1)
  })

  it('指数退避：连续失败时等待时间翻倍', async () => {
    const { engine, definition, amazon } = build()
    const { run } = await engine.start({ tenantId: 't1', kind: definition.kind, intent })
    amazon.failBeforeCommit = 2
    expect((await engine.execute('t1', run.id, definition).catch(e => e)).retryAfterMs).toBe(1000)
    expect((await engine.execute('t1', run.id, definition).catch(e => e)).retryAfterMs).toBe(2000)
    expect((await engine.execute('t1', run.id, definition)).status).toBe('SUCCEEDED')
  })

  it('不可重试错误：立刻失败并按相反顺序补偿已完成的步骤', async () => {
    const { engine, store, amazon, log } = build()
    const definition: WorkflowDefinition = {
      kind: 'x',
      steps: [
        {
          name: 'A',
          run: async () => 'a',
          compensate: async () => {
            log.push('补偿A')
          },
        },
        {
          name: 'B',
          run: async () => 'b',
          compensate: async () => {
            log.push('补偿B')
          },
        },
        {
          name: 'C',
          run: async () => {
            throw Object.assign(new Error('参数错误'), { status: 400 })
          },
        },
      ],
    }
    const { run } = await engine.start({ tenantId: 't1', kind: 'x', intent })
    const error = await engine.execute('t1', run.id, definition).catch(e => e)
    expect(error).toBeInstanceOf(NonRetryableError)
    expect(error.code).toBe('HTTP_400')
    expect(log).toEqual(['补偿B', '补偿A'])
    expect(await store.getRun('t1', run.id)).toMatchObject({ status: 'COMPENSATED', errorCode: 'HTTP_400' })
    expect((await store.listSteps('t1', run.id)).map(step => step.status)).toEqual(['COMPENSATED', 'COMPENSATED', 'FAILED'])
    void amazon
  })

  it('没有任何可补偿内容时流程记为 FAILED', async () => {
    const { engine, store } = build()
    const definition: WorkflowDefinition = {
      kind: 'y',
      steps: [
        {
          name: 'A',
          run: async () => {
            throw new Error('程序缺陷')
          },
        },
      ],
    }
    const { run } = await engine.start({ tenantId: 't1', kind: 'y', intent })
    await expect(engine.execute('t1', run.id, definition)).rejects.toMatchObject({ code: 'UNEXPECTED_ERROR' })
    expect((await store.getRun('t1', run.id))!.status).toBe('FAILED')
  })

  it('补偿本身失败：流程记为 FAILED 并标记 COMPENSATION_FAILED，其余补偿继续执行', async () => {
    const { engine, store, log } = build()
    const definition: WorkflowDefinition = {
      kind: 'z',
      steps: [
        {
          name: 'A',
          run: async () => 'a',
          compensate: async () => {
            log.push('补偿A')
          },
        },
        {
          name: 'B',
          run: async () => 'b',
          compensate: async () => {
            throw new Error('撤销失败')
          },
        },
        {
          name: 'C',
          run: async () => {
            throw Object.assign(new Error('拒绝'), { status: 403 })
          },
        },
      ],
    }
    const { run } = await engine.start({ tenantId: 't1', kind: 'z', intent })
    await expect(engine.execute('t1', run.id, definition)).rejects.toMatchObject({ code: 'COMPENSATION_FAILED' })
    expect(log).toEqual(['补偿A'])
    expect(await store.getRun('t1', run.id)).toMatchObject({ status: 'FAILED', errorCode: 'COMPENSATION_FAILED' })
  })

  it('重试用尽：可重试错误也判失败（RETRIES_EXHAUSTED）并补偿', async () => {
    const { engine, definition, amazon, store, log } = build()
    const { run } = await engine.start({ tenantId: 't1', kind: definition.kind, intent })
    amazon.failBeforeCommit = 10
    const error = await engine.execute('t1', run.id, definition, { isLastAttempt: true }).catch(e => e)
    expect(error).toBeInstanceOf(NonRetryableError)
    expect(error.code).toBe('RETRIES_EXHAUSTED')
    expect((await store.getRun('t1', run.id))!.status).toBe('FAILED')
    expect(log).not.toContain('登记')
  })

  it('流程级最大执行次数：达到上限后可重试错误也终止', async () => {
    const { engine, definition, amazon } = build()
    const { run } = await engine.start({ tenantId: 't1', kind: definition.kind, intent })
    amazon.failBeforeCommit = 100
    for (let i = 0; i < 3; i++) expect(await engine.execute('t1', run.id, definition).catch(e => e)).toBeInstanceOf(RetryableError)
    expect((await engine.execute('t1', run.id, definition).catch(e => e)).code).toBe('RETRIES_EXHAUSTED')
  })

  it('截止时间已过：不再执行，直接失败并补偿', async () => {
    const { engine, definition, amazon, clock, store } = build()
    const { run } = await engine.start({ tenantId: 't1', kind: definition.kind, intent, deadlineAt: new Date(clock.now().getTime() + 1000) })
    clock.advance(2000)
    await expect(engine.execute('t1', run.id, definition)).rejects.toMatchObject({ code: 'WORKFLOW_DEADLINE_EXCEEDED' })
    expect(amazon.createCalls).toBe(0)
    expect((await store.getRun('t1', run.id))!.status).toBe('FAILED')
  })
})

describe('故障注入：不会重复创建亚马逊对象', () => {
  it('调用已生效但响应超时：下次先对账，找到已创建的对象，绝不再调用创建', async () => {
    const { engine, definition, amazon } = build()
    const { run } = await engine.start({ tenantId: 't1', kind: definition.kind, intent })
    amazon.failAfterCommit = 1
    expect(await engine.execute('t1', run.id, definition).catch(e => e)).toBeInstanceOf(RetryableError)
    expect(amazon.objects).toHaveLength(1)
    const done = await engine.execute('t1', run.id, definition)
    expect(done.status).toBe('SUCCEEDED')
    expect(done.result).toEqual({ objectId: 'OBJ-1' })
    expect(amazon.createCalls).toBe(1)
    expect(amazon.objects).toHaveLength(1)
  })

  it('进程在“调用已生效、结果未记录”时崩溃：恢复扫描接管，对账后继续，不重复创建', async () => {
    const { engine, definition, amazon, store, clock } = build()
    const { run } = await engine.start({ tenantId: 't1', kind: definition.kind, intent })
    amazon.onAfterCommit = () => {
      store.dead = true
    } // 对象刚创建完，进程就死了
    await expect(engine.execute('t1', run.id, definition)).rejects.toThrow('进程已终止')
    amazon.onAfterCommit = null

    store.dead = false // 新进程启动
    const stuck = (await store.getRun('t1', run.id))!
    expect(stuck.status).toBe('RUNNING')
    expect(await store.getStep('t1', run.id, 1)).toMatchObject({ status: 'RUNNING' })
    expect(amazon.objects).toHaveLength(1)

    expect(await engine.recover({ staleMs: 60_000 })).toEqual([]) // 心跳还新鲜，不会抢正在运行的流程
    clock.advance(120_000)
    const freshEngine = new WorkflowEngine(store, { now: clock.now, ownerId: 'new-process' }).register(definition)
    const recovered = await freshEngine.recover({ staleMs: 60_000 })
    expect(recovered).toEqual([{ runId: run.id, tenantId: 't1', outcome: 'resumed' }])
    expect(await store.getRun('t1', run.id)).toMatchObject({ status: 'SUCCEEDED', lockOwner: 'new-process' })
    expect(amazon.createCalls).toBe(1)
    expect(amazon.objects).toHaveLength(1)
  })

  it('进程在调用发出之前崩溃：对账查不到，恢复后正常创建，且只创建一次', async () => {
    const { engine, definition, amazon, store, clock } = build()
    const { run } = await engine.start({ tenantId: 't1', kind: definition.kind, intent })
    const original = amazon.create.bind(amazon)
    amazon.create = async id => {
      store.dead = true
      return original(id)
    } // 发出调用的瞬间进程死亡（对象会被创建，响应无人接收）
    await expect(engine.execute('t1', run.id, definition)).rejects.toThrow('进程已终止')
    amazon.create = original
    store.dead = false
    clock.advance(120_000)
    const recovered = await new WorkflowEngine(store, { now: clock.now }).register(definition).recover({ staleMs: 60_000 })
    expect(recovered[0].outcome).toBe('resumed')
    expect(amazon.objects).toHaveLength(1)
  })

  it('重试用尽前的最后一次机会也会对账：对象其实已创建则判成功而不是失败', async () => {
    const { engine, definition, amazon, store } = build()
    const { run } = await engine.start({ tenantId: 't1', kind: definition.kind, intent })
    amazon.failAfterCommit = 1
    const done = await engine.execute('t1', run.id, definition, { isLastAttempt: true })
    expect(done.status).toBe('SUCCEEDED')
    expect(amazon.objects).toHaveLength(1)
    expect((await store.getRun('t1', run.id))!.errorCode).toBeNull()
  })

  it('请求（含幂等键）只构造一次：重试复用同一份', async () => {
    const { engine, definition, amazon, store } = build()
    const { run } = await engine.start({ tenantId: 't1', kind: definition.kind, intent })
    amazon.failBeforeCommit = 2
    await engine.execute('t1', run.id, definition).catch(() => undefined)
    const first = (await store.getStep('t1', run.id, 1))!.request
    await engine.execute('t1', run.id, definition).catch(() => undefined)
    expect((await store.getStep('t1', run.id, 1))!.request).toEqual(first)
    await engine.execute('t1', run.id, definition)
    expect(amazon.objects.map(object => object.clientRequestId)).toEqual([(first as { clientRequestId: string }).clientRequestId])
  })
})

describe('崩溃恢复：流程锁', () => {
  it('拿不到流程锁（另一个进程正在执行）：跳过，不动流程，不执行任何步骤', async () => {
    const { engine, definition, amazon, store, clock } = build()
    const { run } = await engine.start({ tenantId: 't1', kind: definition.kind, intent })
    clock.advance(120_000)
    const results = await engine.recover({ staleMs: 60_000, lockFor: async () => null })
    expect(results).toEqual([{ runId: run.id, tenantId: 't1', outcome: 'skipped' }])
    expect(amazon.createCalls).toBe(0)
    expect((await store.getRun('t1', run.id))!.status).toBe('RUNNING')
  })

  it('拿到流程锁：执行完成后释放锁', async () => {
    const { engine, definition, store, clock } = build()
    const { run } = await engine.start({ tenantId: 't1', kind: definition.kind, intent })
    clock.advance(120_000)
    let released = 0
    const lease = {
      assertHeld: () => undefined,
      release: async () => {
        released += 1
      },
    } as never
    const results = await engine.recover({ staleMs: 60_000, lockFor: async () => lease })
    expect(results).toEqual([{ runId: run.id, tenantId: 't1', outcome: 'resumed' }])
    expect(released).toBe(1)
    expect((await store.getRun('t1', run.id))!.status).toBe('SUCCEEDED')
  })
})

describe('崩溃恢复：其他情形', () => {
  it('流程类型未注册：标记失败，不无限悬挂', async () => {
    const { store, clock } = build()
    const engine = new WorkflowEngine(store, { now: clock.now })
    const { run } = await engine.start({ tenantId: 't1', kind: 'unknown.kind', intent })
    clock.advance(120_000)
    expect(await engine.recover({ staleMs: 60_000 })).toEqual([{ runId: run.id, tenantId: 't1', outcome: 'failed', errorCode: 'WORKFLOW_KIND_UNKNOWN' }])
    expect((await store.getRun('t1', run.id))!.status).toBe('FAILED')
  })

  it('取消：已成功的步骤执行补偿，流程记为已取消', async () => {
    const { engine, definition, store, log, amazon } = build()
    const { run } = await engine.start({ tenantId: 't1', kind: definition.kind, intent })
    amazon.failBeforeCommit = 0
    await engine
      .execute('t1', run.id, {
        ...definition,
        steps: [
          ...definition.steps.slice(0, 2),
          {
            name: '卡住',
            run: async () => {
              throw new RetryableError('WAIT', '稍后')
            },
          },
        ],
      })
      .catch(() => undefined)
    const cancelled = await engine.cancel('t1', run.id, definition)
    expect(cancelled.status).toBe('CANCELLED')
    expect(log).toContain('补偿：删除亚马逊对象')
    expect(amazon.objects).toHaveLength(0)
    void store
  })

  it('租约丢失：立刻停止，不再记录结果', async () => {
    const { engine, definition, store, amazon } = build()
    const { run } = await engine.start({ tenantId: 't1', kind: definition.kind, intent })
    let held = true
    const lease = {
      assertHeld: () => {
        if (!held) throw new RetryableError('LOCK_LOST', '租约丢失')
      },
    }
    amazon.onAfterCommit = () => {
      held = false
    } // 创建对象之后租约被别人接管
    await expect(engine.execute('t1', run.id, definition, { lease })).rejects.toMatchObject({ code: 'LOCK_LOST' })
    expect((await store.getStep('t1', run.id, 1))!.status).not.toBe('SUCCEEDED') // 丢锁后不得记录结果
  })

  it('配合分布式锁：两个进程竞争同一流程，只有持锁的一方执行', async () => {
    const { engine, definition, amazon } = build()
    const { run } = await engine.start({ tenantId: 't1', kind: definition.kind, intent })
    const locks = new DistributedLockManager(new MemoryLockStore(), { renewEveryMs: 3_600_000 })
    const attempt = (owner: string) => locks.withLock('t1', `wf:${run.id}`, owner, lease => engine.execute('t1', run.id, definition, { lease }))
    const [a, b] = await Promise.all([attempt('w1'), attempt('w2')])
    expect([a.acquired, b.acquired].filter(Boolean)).toHaveLength(1)
    expect(amazon.createCalls).toBe(1)
  })
})
