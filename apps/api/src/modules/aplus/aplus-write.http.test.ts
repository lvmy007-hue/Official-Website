import { APLUS_WRITE_JOB, aplusModulesToAmazon } from '@nova/api-contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeAplus, contentRow, logoModule, openAplus, OTHER_SCOPE, READ, textModule, uploadRun, WRITE } from '../../testing/aplus-kit'

// A+ 内容写入接口（P4-14）：创建、保存修改、关联 ASIN、提交审核。检查顺序固定：权限 → 参数 → 店铺范围 → 连接 → 开关 → 业务条件 → 事务。
// 图片上传见 aplus-upload.http.test.ts。事务内的真实行为（行锁、唯一键、隔离）见 testing/aplus.db.test.ts。
afterEach(closeAplus)

const CREATE = { storeId: 's1', name: '新内容', modules: [textModule()] }
const actions = (stubs: Record<string, any>): string[] => stubs.auditEvent.create.mock.calls.map((call: Array<{ data: { action: string } }>) => call[0]!.data.action)
const BAD_CONNECTION = { platformConnection: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) } }
const SWITCH_OFF = { integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) } }
/** 内容查询的替身：版本 3 的草稿；进行中或创建失败的写入按 where 区分（runStateOf 用两次 findFirst）。 */
const withContent = (over: Record<string, unknown> = {}, run: { busy?: boolean; createFailed?: boolean } = {}) => ({
  aplusContent: { findFirst: vi.fn().mockResolvedValue(contentRow(over)), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  aplusWriteRun: {
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    findFirst: vi.fn(async (args: { where: { status?: unknown; kind?: string } }) =>
      args.where.status ? (run.busy ? { kind: 'UPDATE', status: 'RUNNING' } : null) : run.createFailed ? { status: 'FAILED' } : null,
    ),
  },
})

describe('A+ 创建：检查顺序', () => {
  it('没有 aplus.write 是 403（先于参数校验，不查店铺）；未登录 401', async () => {
    const { app, stubs } = await openAplus([READ])
    expect((await app.call('POST', '/aplus', { body: {} })).status).toBe(403)
    expect((await app.call('POST', '/aplus', { body: CREATE, auth: false })).status).toBe(401)
    expect(stubs.sellerAccount.findFirst).not.toHaveBeenCalled()
  })

  it('参数不合格 422（在店铺、连接、开关之前）：缺名称、没有模块、模块超过 5 个、未知字段', async () => {
    const { app, stubs } = await openAplus([WRITE])
    for (const body of [
      { storeId: 's1', modules: [textModule()] },
      { ...CREATE, modules: [] },
      { ...CREATE, modules: Array(6).fill(textModule()) },
      { ...CREATE, extra: 1 },
    ]) {
      expect((await app.call('POST', '/aplus', { body })).status).toBe(422)
    }
    expect(stubs.sellerAccount.findFirst).not.toHaveBeenCalled()
    expect(stubs.integrationSwitch.findFirst).not.toHaveBeenCalled()
  })

  it('店铺不在范围内 403，先于连接与开关；店铺不存在 404', async () => {
    const scoped = await openAplus([WRITE], OTHER_SCOPE)
    const res = await scoped.app.call('POST', '/aplus', { body: CREATE })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('SCOPE_STORE_FORBIDDEN')
    expect(scoped.stubs.platformConnection.findFirst).not.toHaveBeenCalled()
    const missing = await openAplus([WRITE], { sellerAccount: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) } })
    expect((await missing.app.call('POST', '/aplus', { body: CREATE })).status).toBe(404)
  })

  it('没有授权连接 409（先于开关）；开关关闭 409；都不进事务、不入队', async () => {
    const noConnection = await openAplus([WRITE], { ...BAD_CONNECTION, ...SWITCH_OFF })
    const first = await noConnection.app.call('POST', '/aplus', { body: CREATE })
    expect(first.status).toBe(409)
    expect(first.json.error.details.step).toBe('CONNECTION')
    expect(noConnection.stubs.integrationSwitch.findFirst).not.toHaveBeenCalled()
    const off = await openAplus([WRITE], SWITCH_OFF)
    const second = await off.app.call('POST', '/aplus', { body: CREATE })
    expect(second.status).toBe(409)
    expect(second.json.error.details.step).toBe('SWITCH')
    for (const { stubs, app } of [noConnection, off]) {
      expect(stubs.$transaction).not.toHaveBeenCalled()
      expect(app.queue.add).not.toHaveBeenCalled()
    }
  })
})

describe('A+ 创建：内容与图片', () => {
  it('模块内容不合格 422 并写明第几个模块；不进事务', async () => {
    const { app, stubs } = await openAplus([WRITE])
    const res = await app.call('POST', '/aplus', { body: { ...CREATE, modules: [textModule('', '')] } })
    expect(res.status).toBe(422)
    expect(res.json.error.message).toContain('第 1 个模块')
    expect(res.json.error.message).toContain('正文不能为空')
    expect(stubs.$transaction).not.toHaveBeenCalled()
  })

  it('图片编号不是这个店铺成功上传的 422（只查本店铺、已成功的上传记录）', async () => {
    const { app, stubs } = await openAplus([WRITE])
    const res = await app.call('POST', '/aplus', { body: { ...CREATE, modules: [logoModule('u-other')] } })
    expect(res.status).toBe(422)
    expect(res.json.error.message).toContain('成功上传')
    expect(stubs.aplusWriteRun.findMany.mock.calls[0]![0].where).toMatchObject({ tenantId: 'tenant-1', sellerAccountId: 's1', kind: 'UPLOAD', status: 'SUCCEEDED' })
    expect(stubs.$transaction).not.toHaveBeenCalled()
  })

  it('图片比模块要求的小 422，并写明实际与要求的像素', async () => {
    const { app, stubs } = await openAplus([WRITE], { aplusWriteRun: { findMany: vi.fn().mockResolvedValue([uploadRun('u1', 500, 200)]) } })
    const res = await app.call('POST', '/aplus', { body: { ...CREATE, modules: [logoModule('u1')] } })
    expect(res.status).toBe(422)
    expect(res.json.error.message).toContain('500×200')
    expect(res.json.error.message).toContain('600×180')
    expect(stubs.$transaction).not.toHaveBeenCalled()
  })

  it('成功 201：事务里建草稿（版本 1、没有亚马逊编号）、写入记录、后台任务、审计；提交后入队；任务与写入记录互相对得上', async () => {
    const { app, stubs } = await openAplus([WRITE], { aplusWriteRun: { findMany: vi.fn().mockResolvedValue([uploadRun('u1', 600, 180)]), create: vi.fn().mockResolvedValue({}) } })
    const res = await app.call('POST', '/aplus', { body: { ...CREATE, modules: [textModule(), logoModule('u1')] } })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    const { contentId, runId } = res.json.data
    expect(res.json.data).toMatchObject({ status: 'QUEUED', version: 1, queued: true })
    expect(stubs.aplusContent.create.mock.calls[0]![0].data).toMatchObject({
      id: contentId,
      tenantId: 'tenant-1',
      sellerAccountId: 's1',
      contentReferenceKey: null,
      name: '新内容',
      contentType: 'EBC',
      locale: 'en-US',
      status: 'DRAFT',
      version: 1,
      createdBy: 'user-1',
    })
    const run = stubs.aplusWriteRun.create.mock.calls[0]![0].data
    expect(run).toMatchObject({ id: runId, tenantId: 'tenant-1', sellerAccountId: 's1', contentId, kind: 'CREATE', status: 'QUEUED', requestedBy: 'user-1' })
    expect(run.requestJson).toMatchObject({ name: '新内容', contentType: 'EBC', locale: 'en-US' })
    expect(run.requestJson.contentModuleList).toHaveLength(2)
    const job = stubs.syncJob.create.mock.calls[0]![0].data
    expect(job).toMatchObject({ id: run.syncJobId, type: APLUS_WRITE_JOB, status: 'PENDING', connectionId: 'conn-1', context: { aplusRunId: runId, storeId: 's1' } })
    expect(actions(stubs)).toContain('APLUS_CREATED')
    expect(app.workflow.registerWriteRun).toHaveBeenCalled()
    expect(app.queue.add).toHaveBeenCalledWith(
      'sync',
      expect.objectContaining({ tenantId: 'tenant-1', syncJobId: job.id, aplusRunId: runId }),
      job.id,
      expect.objectContaining({ type: APLUS_WRITE_JOB }),
    )
  })

  it('入队失败：仍然 201 但 queued 为 false；写入记录标为失败（QUEUE_UNAVAILABLE），任务标为永久失败', async () => {
    const { app, stubs } = await openAplus([WRITE])
    app.queue.add.mockRejectedValueOnce(new Error('redis down'))
    const res = await app.call('POST', '/aplus', { body: CREATE })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.data).toMatchObject({ queued: false, status: 'QUEUED' })
    expect(stubs.aplusWriteRun.updateMany).toHaveBeenCalledWith({
      where: { id: res.json.data.runId, tenantId: 'tenant-1' },
      data: expect.objectContaining({ status: 'FAILED', failureCode: 'QUEUE_UNAVAILABLE' }),
    })
    expect(stubs.syncJob.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'FAILED_PERMANENT', failureCode: 'QUEUE_UNAVAILABLE' })
  })
})

describe('A+ 保存修改（PATCH）', () => {
  const body = { version: 3, name: '新名字' }
  const patch = (app: Awaited<ReturnType<typeof openAplus>>['app'], payload: unknown = body) => app.call('PATCH', '/aplus/c1', { body: payload })

  it('没有权限 403；参数不合格 422（缺版本、什么都没改、未知字段）；内容不存在 404 且先于连接与开关', async () => {
    const denied = await openAplus([READ])
    expect((await patch(denied.app, {})).status).toBe(403)
    expect(denied.stubs.aplusContent.findFirst).not.toHaveBeenCalled()
    const { app, stubs } = await openAplus([WRITE])
    for (const payload of [{ name: 'x' }, { version: 3 }, { version: 3, name: 'x', extra: 1 }, { version: 0, name: 'x' }]) expect((await patch(app, payload)).status).toBe(422)
    expect(stubs.aplusContent.findFirst).not.toHaveBeenCalled()
    expect((await patch(app)).status).toBe(404)
    expect(stubs.integrationSwitch.findFirst).not.toHaveBeenCalled()
  })

  it('没有授权连接 409；开关关闭 409', async () => {
    const noConnection = await openAplus([WRITE], { ...withContent(), ...BAD_CONNECTION })
    expect((await patch(noConnection.app)).json.error.details.step).toBe('CONNECTION')
    const off = await openAplus([WRITE], { ...withContent(), ...SWITCH_OFF })
    expect((await patch(off.app)).json.error.details.step).toBe('SWITCH')
    expect(noConnection.stubs.$transaction).not.toHaveBeenCalled()
  })

  it('版本不一致 409（带当前版本）；有进行中的写入 409；已提交的内容不能编辑 409；不进事务', async () => {
    const stale = await openAplus([WRITE], withContent())
    const res = await patch(stale.app, { version: 2, name: 'x' })
    expect(res.status).toBe(409)
    expect(res.json.error.details).toMatchObject({ currentVersion: 3, expectedVersion: 2 })
    const busy = await openAplus([WRITE], withContent({}, { busy: true }))
    const second = await patch(busy.app)
    expect(second.status).toBe(409)
    expect(second.json.error.details.code).toBe('APLUS_RUN_BUSY')
    const submitted = await openAplus([WRITE], withContent({ status: 'SUBMITTED' }))
    const third = await patch(submitted.app)
    expect(third.status).toBe(409)
    expect(third.json.error.message).toContain('草稿和被拒')
    for (const item of [stale, busy, submitted]) expect(item.stubs.$transaction).not.toHaveBeenCalled()
  })

  it('当前文档含不支持的模块：只改名称也拒绝，说明原因（整份快照会覆盖亚马逊上的内容）', async () => {
    const draftJson = { contentModuleList: [{ contentModuleType: 'STANDARD_TECH_SPECS', standardTechSpecs: {} }] }
    const { app, stubs } = await openAplus([WRITE], withContent({ draftJson }))
    const res = await patch(app)
    expect(res.status).toBe(409)
    expect(res.json.error.message).toBeTruthy()
    expect(stubs.$transaction).not.toHaveBeenCalled()
  })

  it('已有图片沿用旧图（不查上传记录）；新选的图片要核对：不是本店成功上传的 422', async () => {
    const draftJson = { contentModuleList: aplusModulesToAmazon([logoModule('old')]) }
    const kept = await openAplus([WRITE], withContent({ draftJson }))
    const ok = await patch(kept.app, { version: 3, modules: [logoModule('old')] })
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    expect(kept.stubs.aplusWriteRun.findMany).not.toHaveBeenCalled()
    const fresh = await openAplus([WRITE], withContent({ draftJson }))
    const res = await patch(fresh.app, { version: 3, modules: [logoModule('new')] })
    expect(res.status).toBe(422)
    expect(res.json.error.message).toContain('成功上传')
  })

  it('成功：版本加一立即更新名称与草稿文档，写入记录存整份快照（200，版本 4）', async () => {
    const { app, stubs } = await openAplus([WRITE], withContent())
    const res = await patch(app, { version: 3, name: '新名字', modules: [textModule('新标题', '新正文')] })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ contentId: 'c1', version: 4, queued: true, status: 'QUEUED' })
    const update = stubs.aplusContent.updateMany.mock.calls[0]![0]
    expect(update.where).toEqual({ id: 'c1', tenantId: 'tenant-1', version: 3 })
    expect(update.data).toMatchObject({ name: '新名字', version: { increment: 1 } })
    expect(update.data.draftJson.contentModuleList).toEqual(aplusModulesToAmazon([textModule('新标题', '新正文')]))
    const run = stubs.aplusWriteRun.create.mock.calls[0]![0].data
    expect(run).toMatchObject({ contentId: 'c1', kind: 'UPDATE', status: 'QUEUED' })
    expect(run.requestJson).toMatchObject({ name: '新名字', contentType: 'EBC', locale: 'en-US' })
    expect(actions(stubs)).toContain('APLUS_UPDATED')
    expect(app.queue.add).toHaveBeenCalledTimes(1)
  })

  it('只改名称：快照里的模块沿用现有文档；现有文档是空的就拒绝（422），避免清空亚马逊上的内容', async () => {
    const { app, stubs } = await openAplus([WRITE], withContent())
    expect((await patch(app)).status).toBe(200)
    expect(stubs.aplusWriteRun.create.mock.calls[0]![0].data.requestJson.contentModuleList).toEqual(aplusModulesToAmazon([textModule()]))
    const empty = await openAplus([WRITE], withContent({ draftJson: {} }))
    const res = await patch(empty.app)
    expect(res.status).toBe(422)
    expect(res.json.error.message).toContain('清空')
  })

  it('没有亚马逊编号的内容：创建失败过才允许再保存，保存按“创建”重发；没失败过（还在创建中）拒绝', async () => {
    const retry = await openAplus([WRITE], withContent({ contentReferenceKey: null }, { createFailed: true }))
    expect((await patch(retry.app)).status).toBe(200)
    expect(retry.stubs.aplusWriteRun.create.mock.calls[0]![0].data.kind).toBe('CREATE')
    const waiting = await openAplus([WRITE], withContent({ contentReferenceKey: null }))
    expect((await patch(waiting.app)).status).toBe(409)
  })

  it('并发：条件更新没命中（别人先改了）409 并回滚；拿到行锁后发现有进行中的写入也是 409；都不建写入记录、不入队', async () => {
    const raced = await openAplus([WRITE], withContent())
    raced.stubs.aplusContent.updateMany.mockResolvedValue({ count: 0 })
    const res = await patch(raced.app)
    expect(res.status).toBe(409)
    expect(res.json.error.details).toMatchObject({ currentVersion: 3, expectedVersion: 3 })
    const busy = await openAplus([WRITE], withContent())
    busy.stubs.aplusWriteRun.count.mockResolvedValue(1)
    const second = await patch(busy.app)
    expect(second.status).toBe(409)
    expect(second.json.error.details.code).toBe('APLUS_RUN_BUSY')
    for (const item of [raced, busy]) {
      expect(item.stubs.aplusWriteRun.create).not.toHaveBeenCalled()
      expect(item.app.queue.add).not.toHaveBeenCalled()
    }
  })
})

describe('A+ 关联 ASIN 与提交审核', () => {
  const asins = { version: 3, asins: ['b0aaaaaaa1', ' B0AAAAAAA2 '] }

  it('关联：参数不合格 422（空、格式不对、重复、超过 50 个）；没有权限 403', async () => {
    const denied = await openAplus([READ])
    expect((await denied.app.call('POST', '/aplus/c1/asins', { body: {} })).status).toBe(403)
    const { app } = await openAplus([WRITE], withContent())
    const many = Array.from({ length: 51 }, (_, index) => `B0AAAA${String(index).padStart(4, '0')}`)
    for (const payload of [
      { version: 3, asins: [] },
      { version: 3, asins: ['bad'] },
      { version: 3, asins: ['B0AAAAAAA1', 'b0aaaaaaa1'] },
      { version: 3, asins: many },
    ]) {
      expect((await app.call('POST', '/aplus/c1/asins', { body: payload })).status).toBe(422)
    }
  })

  it('关联成功 201：ASIN 去空格转大写，只写入记录与版本加一（不改名称与文档），审计 APLUS_ASINS_ASSOCIATED', async () => {
    const { app, stubs } = await openAplus([WRITE], withContent())
    const res = await app.call('POST', '/aplus/c1/asins', { body: asins })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.data).toMatchObject({ contentId: 'c1', version: 4, queued: true })
    expect(stubs.aplusContent.updateMany.mock.calls[0]![0].data).toEqual({ version: { increment: 1 } })
    expect(stubs.aplusWriteRun.create.mock.calls[0]![0].data).toMatchObject({ kind: 'ASSOCIATE', requestJson: { asins: ['B0AAAAAAA1', 'B0AAAAAAA2'] } })
    expect(actions(stubs)).toContain('APLUS_ASINS_ASSOCIATED')
  })

  it('关联：审核中不允许 409；版本不一致 409；有进行中的写入 409；没有亚马逊编号 409', async () => {
    const cases: Array<[Record<string, unknown>, { busy?: boolean }, unknown]> = [
      [{ status: 'SUBMITTED' }, {}, asins],
      [{}, {}, { ...asins, version: 1 }],
      [{}, { busy: true }, asins],
      [{ contentReferenceKey: null }, {}, asins],
    ]
    for (const [over, run, payload] of cases) {
      const { app, stubs } = await openAplus([WRITE], withContent(over, run))
      expect((await app.call('POST', '/aplus/c1/asins', { body: payload })).status).toBe(409)
      expect(stubs.$transaction).not.toHaveBeenCalled()
    }
  })

  it('提交审核成功 201：写入记录 SUBMIT（请求内容为空对象）、版本加一、审计 APLUS_SUBMITTED', async () => {
    const { app, stubs } = await openAplus([WRITE], withContent())
    const res = await app.call('POST', '/aplus/c1/submit', { body: { version: 3 } })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.data).toMatchObject({ contentId: 'c1', version: 4, queued: true })
    expect(stubs.aplusWriteRun.create.mock.calls[0]![0].data).toMatchObject({ kind: 'SUBMIT', requestJson: {} })
    expect(actions(stubs)).toContain('APLUS_SUBMITTED')
  })

  it('提交审核：没有关联 ASIN 409；已发布 409；版本不一致 409；草稿里有必填项为空 422；参数不合格 422；没有权限 403', async () => {
    const denied = await openAplus([READ])
    expect((await denied.app.call('POST', '/aplus/c1/submit', { body: {} })).status).toBe(403)
    const bad = await openAplus([WRITE], withContent())
    expect((await bad.app.call('POST', '/aplus/c1/submit', { body: {} })).status).toBe(422)
    expect((await bad.app.call('POST', '/aplus/c1/submit', { body: { version: 3, extra: 1 } })).status).toBe(422)
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ asinCount: 0 }, 409],
      [{ status: 'PUBLISHED' }, 409],
      [{ version: 9 }, 409],
    ]
    for (const [over, status] of cases) {
      const { app } = await openAplus([WRITE], withContent(over))
      expect((await app.call('POST', '/aplus/c1/submit', { body: { version: 3 } })).status).toBe(status)
    }
    const emptyBody = await openAplus([WRITE], withContent({ draftJson: { contentModuleList: aplusModulesToAmazon([textModule('标题', '')]) } }))
    const res = await emptyBody.app.call('POST', '/aplus/c1/submit', { body: { version: 3 } })
    expect(res.status).toBe(422)
    expect(res.json.error.message).toContain('正文不能为空')
    expect(emptyBody.stubs.$transaction).not.toHaveBeenCalled()
  })
})
