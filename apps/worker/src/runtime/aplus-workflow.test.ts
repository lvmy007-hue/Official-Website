import { Readable } from 'node:stream'
import { TenantObjectStore, type ObjectStorage } from '@nova/storage'
import { NonRetryableError } from '@nova/workflow'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UpstreamHttpError } from '../connectors/http-error'
import { fakeAplusDb } from '../importers/aplus/fake-db.test-helper'
import { createAplusWorkflow } from './aplus-workflow'

// A+ 写入流程（P4-14）：直接调用两个步骤（不起流程引擎）。假的 A+ 接口记下调用，内存数据库记下回写，验证：每种类型发了什么请求、回写了什么、
// 开关关闭与请求不完整时不发请求、key 缺失、文件缺失、失败原样抛出（交给引擎分类）、回写幂等、创建的对账。

const api = vi.hoisted(() => ({
  listContents: vi.fn(),
  createContent: vi.fn(),
  updateContent: vi.fn(),
  associateAsins: vi.fn(),
  submitForApproval: vi.fn(),
  uploadImage: vi.fn(),
}))
vi.mock('../connectors/aplus-api', () => ({
  AplusApi: class {
    listContents = api.listContents
    createContent = api.createContent
    updateContent = api.updateContent
    associateAsins = api.associateAsins
    submitForApproval = api.submitForApproval
    uploadImage = api.uploadImage
  },
}))
vi.mock('../connectors/amazon-sp-api', () => ({ AmazonSpApiClient: class {} }))

const NOW = new Date('2026-10-25T00:00:00.000Z')
const intent = { tenantId: 't1', connectionId: 'c1', aplusRunId: 'run1' }
const files = new Map<string, Buffer>()
const storage = {
  stat: async (key: string) => (files.has(key) ? { key, sizeBytes: files.get(key)!.length, lastModified: NOW } : null),
  openRead: async (key: string) => Readable.from([files.get(key)!]),
} as unknown as ObjectStorage
const newKey = (name = 'a.png') => new TenantObjectStore(storage, 't1').newKey({ domain: 'aplus-uploads', name })

function setup(options: { storage?: ObjectStorage; switchOn?: boolean } = {}) {
  const db = fakeAplusDb()
  Object.assign(db.prisma, { platformConnection: { findFirst: async () => ({ id: 'c1' }) } })
  if (options.switchOn !== false) db.switches.rows.push({ id: 'sw1', tenantId: 't1', switchKey: 'sw.aplus.submit', sellerAccountId: null, enabled: true })
  const flow = createAplusWorkflow({ prisma: db.prisma, guardFor: () => ({}), secrets: {}, storage: 'storage' in options ? options.storage : storage } as never)
  const ctx = (responses: unknown[] = [], request: unknown = { requestedAt: NOW.toISOString() }) =>
    ({ tenantId: 't1', runId: 'wf1', intent, request, responseOf: (index: number) => responses[index] ?? null }) as never
  const [call, writeBack] = flow.steps
  /** 种下一条写入记录（与内容），依次执行“调用亚马逊”和“回写本地”两步。 */
  const seed = (kind: string, requestJson: unknown, content?: Record<string, unknown>) => {
    const local = content === undefined ? undefined : db.seedContent({ id: 'c1', ...content })
    db.runs.rows.push({ id: 'run1', tenantId: 't1', sellerAccountId: 'sa1', contentId: local?.id ?? null, kind, status: 'RUNNING', requestJson })
    return local
  }
  const run = async (responses: unknown[] = []) => call.run(ctx(responses)) as Promise<Record<string, unknown>>
  const write = (outcome: unknown) => writeBack.run(ctx([outcome]))
  return { ...db, flow, call, ctx, seed, run, write, runRow: () => db.runs.rows[0] }
}

beforeEach(() => {
  Object.values(api).forEach(fn => fn.mockReset())
  files.clear()
})

describe('创建', () => {
  const body = { name: 'Summer', contentType: 'EBC', locale: 'en-US', contentModuleList: [{ m: 1 }] }

  it('调用创建接口，回写引用键与警告；内容保持草稿；写入记录置为成功并记下结果', async () => {
    const db = setup()
    const local = db.seed('CREATE', body, { name: 'Summer', contentReferenceKey: null })!
    api.createContent.mockResolvedValue({ contentReferenceKey: 'KEY-1', warnings: [{ message: 'Check alt text' }] })
    const outcome = await db.run()
    expect(api.createContent).toHaveBeenCalledWith({ name: 'Summer', contentType: 'EBC', locale: 'en-US', contentModuleList: [{ m: 1 }] })
    expect(outcome).toMatchObject({ contentReferenceKey: 'KEY-1', warnings: ['Check alt text'] })
    await db.write(outcome)
    expect(local).toMatchObject({ contentReferenceKey: 'KEY-1', status: 'DRAFT', version: 1 })
    expect(db.runRow()).toMatchObject({ status: 'SUCCEEDED', failureCode: null, resultJson: { contentReferenceKey: 'KEY-1' }, warningsJson: ['Check alt text'] })
    expect(db.runRow().finishedAt).toBeInstanceOf(Date)
  })

  it('响应里没有引用键：APL_RESPONSE_UNRECOGNIZED（不可重试），不回写', async () => {
    const db = setup()
    db.seed('CREATE', body, { contentReferenceKey: null })
    api.createContent.mockResolvedValue({ warnings: [] })
    await expect(db.run()).rejects.toMatchObject({ code: 'APL_RESPONSE_UNRECOGNIZED' })
    expect(db.runRow().status).toBe('RUNNING')
  })

  it('本地行已经有引用键（流程重放）：不再调用亚马逊', async () => {
    const db = setup()
    db.seed('CREATE', body, { contentReferenceKey: 'KEY-1' })
    expect(await db.run()).toMatchObject({ contentReferenceKey: 'KEY-1' })
    expect(api.createContent).not.toHaveBeenCalled()
  })
})

describe('保存修改', () => {
  it('提交完整快照：名称取请求，类型与语言取内容行；回写更新同步时间，不动 version 与状态', async () => {
    const db = setup()
    const local = db.seed('UPDATE', { name: 'New name', contentModuleList: [{ m: 2 }] }, { contentReferenceKey: 'KEY-1', contentType: 'EMC', locale: 'en-US', version: 4, status: 'REJECTED' })!
    api.updateContent.mockResolvedValue({ contentReferenceKey: 'KEY-1', warnings: ['w1'] })
    const outcome = await db.run()
    expect(api.updateContent).toHaveBeenCalledWith('KEY-1', { name: 'New name', contentType: 'EMC', locale: 'en-US', contentModuleList: [{ m: 2 }] })
    await db.write(outcome)
    expect(local).toMatchObject({ version: 4, status: 'REJECTED' })
    expect(local.lastSyncedAt).toBeInstanceOf(Date)
    expect(db.runRow()).toMatchObject({ status: 'SUCCEEDED', resultJson: { contentReferenceKey: 'KEY-1' }, warningsJson: ['w1'] })
  })

  it('内容在亚马逊还没有引用键：APL_KEY_MISSING，不发请求', async () => {
    const db = setup()
    db.seed('UPDATE', { name: 'N', contentModuleList: [] }, { contentReferenceKey: null })
    await expect(db.run()).rejects.toBeInstanceOf(NonRetryableError)
    await expect(db.run()).rejects.toMatchObject({ code: 'APL_KEY_MISSING' })
    expect(api.updateContent).not.toHaveBeenCalled()
  })
})

describe('关联 ASIN', () => {
  it('回写：新增关联行（没有上线时间）、已有行更新时间，asinCount 按行数重算；重放不重复', async () => {
    const db = setup()
    const local = db.seed('ASSOCIATE', { asins: ['B0AAAAAAA1', 'B0AAAAAAA2'] }, { contentReferenceKey: 'KEY-1' })!
    const old = new Date('2026-01-01T00:00:00Z')
    db.relations.rows.push({ id: 'x', tenantId: 't1', contentId: local.id, asin: 'B0AAAAAAA1', publishedAt: new Date('2026-02-01T00:00:00Z'), lastSeenAt: old })
    db.relations.rows.push({ id: 'y', tenantId: 't1', contentId: local.id, asin: 'B0OTHER001', publishedAt: null, lastSeenAt: old })
    api.associateAsins.mockResolvedValue({ warnings: [] })
    const outcome = await db.run()
    expect(api.associateAsins).toHaveBeenCalledWith('KEY-1', ['B0AAAAAAA1', 'B0AAAAAAA2'])
    await db.write(outcome)
    await db.write(outcome)
    expect(db.relations.rows.map(row => row.asin).sort()).toEqual(['B0AAAAAAA1', 'B0AAAAAAA2', 'B0OTHER001'])
    expect(db.relations.rows.find(row => row.asin === 'B0AAAAAAA1')?.publishedAt).toEqual(new Date('2026-02-01T00:00:00Z'))
    expect(db.relations.rows.find(row => row.asin === 'B0AAAAAAA2')?.publishedAt).toBeUndefined()
    expect(local.asinCount).toBe(3)
    expect(db.runRow().resultJson).toEqual({ contentReferenceKey: 'KEY-1', associated: 2 })
  })

  it('没有引用键：APL_KEY_MISSING', async () => {
    const db = setup()
    db.seed('ASSOCIATE', { asins: ['B0AAAAAAA1'] }, { contentReferenceKey: null })
    await expect(db.run()).rejects.toMatchObject({ code: 'APL_KEY_MISSING' })
  })
})

describe('提交审核', () => {
  it('回写：状态改为已提交，写一条本地来源的审核事件（时间取调用完成时间）；重放不会写出第二条', async () => {
    const db = setup()
    const local = db.seed('SUBMIT', {}, { contentReferenceKey: 'KEY-1', status: 'DRAFT' })!
    api.submitForApproval.mockResolvedValue(null) // 没有响应体也算受理
    const outcome = await db.run()
    expect(api.submitForApproval).toHaveBeenCalledWith('KEY-1')
    await db.write(outcome)
    db.runRow().status = 'RUNNING' // 模拟“事务提交了、但流程记录没来得及保存”的重放
    await db.write(outcome)
    expect(local.status).toBe('SUBMITTED')
    expect(db.events.rows).toHaveLength(1)
    expect(db.events.rows[0]).toMatchObject({ contentId: local.id, status: 'SUBMITTED', source: 'LOCAL', message: null, occurredAt: new Date(String(outcome.at)) })
  })
})

describe('上传图片', () => {
  it('从对象存储读出文件，调用上传接口；结果里是上传编号；没有内容编号', async () => {
    const db = setup()
    const key = newKey()
    files.set(key, Buffer.from('png bytes'))
    db.seed('UPLOAD', { storeId: 'sa1', objectKey: key, fileName: 'a.png', contentType: 'image/png', sizeBytes: 9, width: 600, height: 450 })
    api.uploadImage.mockResolvedValue({ uploadDestinationId: 'sc/a.png' })
    const outcome = await db.run()
    expect(api.uploadImage).toHaveBeenCalledWith(Buffer.from('png bytes'), 'image/png')
    expect(await db.write(outcome)).toMatchObject({ uploadDestinationId: 'sc/a.png' })
    expect(db.runRow()).toMatchObject({ status: 'SUCCEEDED', resultJson: { uploadDestinationId: 'sc/a.png' } })
  })

  it('文件不在存储里（或路径不属于本企业）：APL_FILE_MISSING，不调用亚马逊', async () => {
    const db = setup()
    db.seed('UPLOAD', { objectKey: newKey('gone.png'), contentType: 'image/png' })
    await expect(db.run()).rejects.toMatchObject({ code: 'APL_FILE_MISSING' })
    expect(api.uploadImage).not.toHaveBeenCalled()
    const other = setup()
    other.seed('UPLOAD', { objectKey: 'tenants/t2/aplus-uploads/2026/10/25/x-a.png', contentType: 'image/png' })
    await expect(other.run()).rejects.toMatchObject({ code: 'APL_FILE_MISSING' })
  })

  it('没有配置对象存储：STORAGE_NOT_CONFIGURED；文件超过大小上限：APL_REQUEST_INVALID', async () => {
    const none = setup({ storage: undefined })
    none.seed('UPLOAD', { objectKey: newKey(), contentType: 'image/png' })
    await expect(none.run()).rejects.toMatchObject({ code: 'STORAGE_NOT_CONFIGURED' })
    const big = setup()
    const key = newKey('big.png')
    files.set(key, Buffer.alloc(5 * 1024 * 1024 + 1))
    big.seed('UPLOAD', { objectKey: key, contentType: 'image/png' })
    await expect(big.run()).rejects.toMatchObject({ code: 'APL_REQUEST_INVALID' })
    expect(api.uploadImage).not.toHaveBeenCalled()
  })

  it('上传失败（APL_UPLOAD_FAILED）原样抛出', async () => {
    const db = setup()
    const key = newKey()
    files.set(key, Buffer.from('x'))
    db.seed('UPLOAD', { objectKey: key, contentType: 'image/png' })
    api.uploadImage.mockRejectedValue(new NonRetryableError('APL_UPLOAD_FAILED', 'x'))
    await expect(db.run()).rejects.toMatchObject({ code: 'APL_UPLOAD_FAILED' })
  })
})

describe('不发请求的情形与失败', () => {
  it('写入开关已关闭：APL_SWITCH_OFF，不发请求（受理之后开关可能被关）', async () => {
    const db = setup({ switchOn: false })
    db.seed('SUBMIT', {}, { contentReferenceKey: 'KEY-1' })
    await expect(db.run()).rejects.toMatchObject({ code: 'APL_SWITCH_OFF' })
    expect(api.submitForApproval).not.toHaveBeenCalled()
  })

  it('请求内容不完整：APL_REQUEST_INVALID，不发请求；写入记录不存在：APL_RUN_NOT_FOUND', async () => {
    const db = setup()
    db.seed('ASSOCIATE', { asins: [] }, { contentReferenceKey: 'KEY-1' })
    await expect(db.run()).rejects.toMatchObject({ code: 'APL_REQUEST_INVALID' })
    expect(api.associateAsins).not.toHaveBeenCalled()
    await expect(setup().run()).rejects.toMatchObject({ code: 'APL_RUN_NOT_FOUND' })
  })

  it('亚马逊返回的错误原样抛出（带状态码），由引擎分类：429 可重试，403 授权失效', async () => {
    const db = setup()
    db.seed('SUBMIT', {}, { contentReferenceKey: 'KEY-1' })
    api.submitForApproval.mockRejectedValue(new UpstreamHttpError('SP_API_403_x', 403, undefined, 'api'))
    await expect(db.run()).rejects.toMatchObject({ status: 403, source: 'api' })
    expect(db.runRow().status).toBe('RUNNING') // 失败的收尾由监听器的 markAplusFailed 完成
  })
})

describe('回写幂等', () => {
  it('写入记录已经成功：重放回写什么也不改', async () => {
    const db = setup()
    const local = db.seed('SUBMIT', {}, { contentReferenceKey: 'KEY-1', status: 'APPROVED' })!
    db.runRow().status = 'SUCCEEDED'
    await db.write({ contentReferenceKey: 'KEY-1', warnings: [], uploadDestinationId: null, at: NOW.toISOString() })
    expect(local.status).toBe('APPROVED')
    expect(db.events.rows).toHaveLength(0)
  })
})

describe('创建的对账', () => {
  const reconcile = (db: ReturnType<typeof setup>) => db.call.reconcile!(db.ctx([], { requestedAt: NOW.toISOString() }))
  const body = { name: 'Summer', contentType: 'EBC', locale: 'en-US', contentModuleList: [] }
  const listed = (...items: Array<[string, string, string]>) => ({
    contentMetadataRecords: items.map(([key, name, time]) => ({ contentReferenceKey: key, contentMetadata: { name, status: 'DRAFT', updateTime: time } })),
  })

  it('本地行已经有引用键：直接沿用，不去亚马逊查', async () => {
    const db = setup()
    db.seed('CREATE', body, { contentReferenceKey: 'KEY-1' })
    expect(await reconcile(db)).toMatchObject({ found: true, response: { contentReferenceKey: 'KEY-1' } })
    expect(api.listContents).not.toHaveBeenCalled()
  })

  it('同名、本次请求之后更新、本地还没有使用的内容：认作这次创建的结果', async () => {
    const db = setup()
    db.seed('CREATE', body, { contentReferenceKey: null })
    db.seedContent({ id: 'c2', contentReferenceKey: 'KEY-USED' })
    api.listContents.mockResolvedValue(
      listed(
        ['KEY-OLD', 'Summer', '2026-10-01T00:00:00Z'],
        ['KEY-USED', 'Summer', '2026-10-25T00:00:30Z'],
        ['KEY-NEW', 'Summer', '2026-10-25T00:00:30Z'],
        ['KEY-OTHER', 'Other', '2026-10-25T00:00:30Z'],
      ),
    )
    expect(await reconcile(db)).toMatchObject({ found: true, response: { contentReferenceKey: 'KEY-NEW' } })
  })

  it('查不到匹配的内容：没有创建成功，可以重新创建；别的类型的操作重复调用结果相同，不对账', async () => {
    const db = setup()
    db.seed('CREATE', body, { contentReferenceKey: null })
    api.listContents.mockResolvedValue(listed(['KEY-OLD', 'Summer', '2026-10-01T00:00:00Z']))
    expect(await reconcile(db)).toEqual({ found: false })
    const submit = setup()
    submit.seed('SUBMIT', {}, { contentReferenceKey: 'KEY-1' })
    expect(await reconcile(submit)).toEqual({ found: false })
  })
})

describe('流程定义', () => {
  it('两个步骤：先调用亚马逊，再回写本地；类型是 aplus.write', () => {
    const { flow } = setup()
    expect(flow.kind).toBe('aplus.write')
    expect(flow.steps.map(step => step.name)).toEqual(['向亚马逊提交 A+ 写入', '回写 A+ 写入结果'])
  })

  it('意图只记内部编号与类型、请求时间', async () => {
    const db = setup()
    db.seed('SUBMIT', {}, { contentReferenceKey: 'KEY-1' })
    const request = await db.call.buildRequest!(db.ctx() as never)
    expect(request).toMatchObject({ aplusRunId: 'run1', kind: 'SUBMIT' })
    expect(Object.keys(request as object).sort()).toEqual(['aplusRunId', 'kind', 'requestedAt'])
  })
})
