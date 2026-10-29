import { Readable } from 'node:stream'
import { APLUS_WRITE_JOB } from '@nova/api-contracts'
import { StorageError } from '@nova/storage'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ObjectStorageService } from '../../platform/storage'
import { closeAplus, openAplus, OTHER_SCOPE, READ, WRITE } from '../../testing/aplus-kit'

// A+ 图片上传（P4-14）：申请签名直传票据（不改库）、确认上传（服务端核对大小、类型、真实图片头与宽高，再登记上传任务）。
afterEach(closeAplus)

const TICKET = { storeId: 's1', fileName: 'logo.png', contentType: 'image/png', sizeBytes: 2048 }
const CONFIRM = { storeId: 's1', objectKey: 'tenants/tenant-1/aplus/abc/logo.png', fileName: 'logo.png', contentType: 'image/png' }
const NO_CONNECTION = { platformConnection: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) } }
const SWITCH_OFF = { integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) } }

// 图片样例：PNG 读 IHDR，JPEG 扫帧头段（解析本身的用例在 aplus-image.test.ts）
const u32 = (value: number) => Buffer.from([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255])
const u16 = (value: number) => Buffer.from([(value >>> 8) & 255, value & 255])
const png = (width: number, height: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from('IHDR'), u32(width), u32(height), Buffer.alloc(9)])
const jpeg = (width: number, height: number) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xc0]),
    u16(17),
    Buffer.from([8]),
    u16(height),
    u16(width),
    Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9]),
  ])

/** 对象存储的替身：用 spy 换掉 forTenant，调用到没写的方法直接报错。 */
function fakeStore(bytes: Buffer, over: Record<string, unknown> = {}, contentType = 'image/png') {
  return {
    signUpload: vi.fn().mockResolvedValue({
      url: 'https://storage.example/put?sig=abc',
      headers: { 'content-type': 'image/png' },
      key: 'tenants/tenant-1/aplus/abc/logo.png',
      expiresAt: new Date('2026-10-25T01:00:00.000Z'),
    }),
    confirmUpload: vi.fn().mockResolvedValue({ key: CONFIRM.objectKey, sizeBytes: bytes.length, contentType }),
    read: vi.fn(async () => Readable.from([bytes])),
    remove: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}
async function open(permissions: string[], store = fakeStore(png(970, 600)), extra: Record<string, unknown> = {}) {
  const opened = await openAplus(permissions, extra)
  const forTenant = vi.spyOn(opened.app.app.get(ObjectStorageService), 'forTenant').mockReturnValue(store as never)
  return { ...opened, store, forTenant }
}

describe('A+ 上传票据（POST /aplus/uploads）', () => {
  it('没有 aplus.write 是 403（先于参数校验）；未登录 401', async () => {
    const { app, forTenant } = await open([READ])
    expect((await app.call('POST', '/aplus/uploads', { body: {} })).status).toBe(403)
    expect((await app.call('POST', '/aplus/uploads', { body: TICKET, auth: false })).status).toBe(401)
    expect(forTenant).not.toHaveBeenCalled()
  })

  it('参数不合格 422（不是 JPG/PNG、大小为 0、超过 5MB、缺文件名、未知字段），在店铺与连接检查之前', async () => {
    const { app, stubs } = await open([WRITE])
    const bodies = [
      { ...TICKET, contentType: 'image/gif' },
      { ...TICKET, sizeBytes: 0 },
      { ...TICKET, sizeBytes: 5 * 1024 * 1024 + 1 },
      { ...TICKET, fileName: ' ' },
      { ...TICKET, extra: 1 },
    ]
    for (const body of bodies) expect((await app.call('POST', '/aplus/uploads', { body })).status).toBe(422)
    expect(stubs.sellerAccount.findFirst).not.toHaveBeenCalled()
  })

  it('店铺不在范围内 403；没有授权连接 409（先于开关）；开关关闭 409；都不签发票据', async () => {
    const scoped = await open([WRITE], undefined, OTHER_SCOPE)
    expect((await scoped.app.call('POST', '/aplus/uploads', { body: TICKET })).status).toBe(403)
    const noConnection = await open([WRITE], undefined, { ...NO_CONNECTION, ...SWITCH_OFF })
    const first = await noConnection.app.call('POST', '/aplus/uploads', { body: TICKET })
    expect(first.status).toBe(409)
    expect(first.json.error.details.step).toBe('CONNECTION')
    const off = await open([WRITE], undefined, SWITCH_OFF)
    expect((await off.app.call('POST', '/aplus/uploads', { body: TICKET })).json.error.details.step).toBe('SWITCH')
    for (const item of [scoped, noConnection, off]) expect(item.store.signUpload).not.toHaveBeenCalled()
  })

  it('成功 201：返回直传地址、方法、头、对象键、过期时间与大小上限；不改库、不登记写入、不入队', async () => {
    const { app, stubs, store, forTenant } = await open([WRITE])
    const res = await app.call('POST', '/aplus/uploads', { body: TICKET })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.data).toEqual({
      uploadUrl: 'https://storage.example/put?sig=abc',
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      objectKey: 'tenants/tenant-1/aplus/abc/logo.png',
      expiresAt: '2026-10-25T01:00:00.000Z',
      maxBytes: 5 * 1024 * 1024,
    })
    expect(forTenant).toHaveBeenCalledWith('tenant-1')
    expect(store.signUpload).toHaveBeenCalledWith({ domain: 'aplus', name: 'logo.png' }, { contentType: 'image/png', maxBytes: 5 * 1024 * 1024 })
    expect(stubs.$transaction).not.toHaveBeenCalled()
    expect(stubs.aplusWriteRun.create).not.toHaveBeenCalled()
    expect(app.queue.add).not.toHaveBeenCalled()
  })
})

describe('A+ 确认上传（POST /aplus/uploads/confirm）：检查顺序', () => {
  it('没有权限 403；参数不合格 422；店铺不在范围 403；没有连接 409；开关关闭 409；都不碰对象存储', async () => {
    const denied = await open([READ])
    expect((await denied.app.call('POST', '/aplus/uploads/confirm', { body: {} })).status).toBe(403)
    const bad = await open([WRITE])
    for (const body of [{}, { ...CONFIRM, objectKey: '' }, { ...CONFIRM, contentType: 'image/webp' }, { ...CONFIRM, extra: 1 }])
      expect((await bad.app.call('POST', '/aplus/uploads/confirm', { body })).status).toBe(422)
    const scoped = await open([WRITE], undefined, OTHER_SCOPE)
    expect((await scoped.app.call('POST', '/aplus/uploads/confirm', { body: CONFIRM })).status).toBe(403)
    const noConnection = await open([WRITE], undefined, { ...NO_CONNECTION, ...SWITCH_OFF })
    expect((await noConnection.app.call('POST', '/aplus/uploads/confirm', { body: CONFIRM })).json.error.details.step).toBe('CONNECTION')
    const off = await open([WRITE], undefined, SWITCH_OFF)
    expect((await off.app.call('POST', '/aplus/uploads/confirm', { body: CONFIRM })).json.error.details.step).toBe('SWITCH')
    for (const item of [denied, bad, scoped, noConnection, off]) expect(item.store.confirmUpload).not.toHaveBeenCalled()
  })

  it('同一个对象已经登记过上传 409，不再核对文件', async () => {
    const { app, store } = await open([WRITE], undefined, { aplusWriteRun: { findFirst: vi.fn().mockResolvedValue({ id: 'r-old' }) } })
    const res = await app.call('POST', '/aplus/uploads/confirm', { body: CONFIRM })
    expect(res.status).toBe(409)
    expect(store.confirmUpload).not.toHaveBeenCalled()
  })
})

describe('A+ 确认上传：文件核对与登记', () => {
  it('PNG 成功 201：读出真实宽高；事务里登记上传记录（没有内容）、后台任务与审计；提交后入队', async () => {
    const { app, stubs, store } = await open([WRITE])
    const res = await app.call('POST', '/aplus/uploads/confirm', { body: CONFIRM })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.data).toMatchObject({ contentId: null, version: null, status: 'QUEUED', queued: true, width: 970, height: 600 })
    expect(store.confirmUpload).toHaveBeenCalledWith(CONFIRM.objectKey, 5 * 1024 * 1024)
    const run = stubs.aplusWriteRun.create.mock.calls[0]![0].data
    expect(run).toMatchObject({ id: res.json.data.runId, tenantId: 'tenant-1', sellerAccountId: 's1', contentId: null, kind: 'UPLOAD', status: 'QUEUED', requestedBy: 'user-1' })
    expect(run.requestJson).toEqual({ storeId: 's1', objectKey: CONFIRM.objectKey, fileName: 'logo.png', contentType: 'image/png', sizeBytes: png(970, 600).length, width: 970, height: 600 })
    expect(stubs.syncJob.create.mock.calls[0]![0].data).toMatchObject({ id: run.syncJobId, type: APLUS_WRITE_JOB, context: { aplusRunId: run.id, storeId: 's1' } })
    expect(stubs.auditEvent.create.mock.calls.map((call: Array<{ data: { action: string } }>) => call[0]!.data.action)).toContain('APLUS_IMAGE_UPLOADED')
    expect(stubs.aplusContent.create).not.toHaveBeenCalled()
    expect(app.queue.add).toHaveBeenCalledTimes(1)
    expect(store.remove).not.toHaveBeenCalled()
  })

  it('JPEG 成功：读帧头里的宽高', async () => {
    const { app, stubs } = await open([WRITE], fakeStore(jpeg(300, 200), {}, 'image/jpeg'))
    const res = await app.call('POST', '/aplus/uploads/confirm', { body: { ...CONFIRM, fileName: 'a.jpg', contentType: 'image/jpeg' } })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.data).toMatchObject({ width: 300, height: 200 })
    expect(stubs.aplusWriteRun.create.mock.calls[0]![0].data.requestJson).toMatchObject({ contentType: 'image/jpeg', width: 300, height: 200 })
  })

  it('声明与真实内容不符、不是图片、图片损坏：422 并写明原因，已上传的文件被删除，不登记任何记录', async () => {
    const mismatch = await open([WRITE], fakeStore(png(970, 600), {}, 'image/jpeg'))
    const first = await mismatch.app.call('POST', '/aplus/uploads/confirm', { body: { ...CONFIRM, contentType: 'image/jpeg' } })
    expect(first.status).toBe(422)
    expect(first.json.error.message).toContain('PNG')
    const garbage = await open([WRITE], fakeStore(Buffer.from('this is not an image at all')))
    const second = await garbage.app.call('POST', '/aplus/uploads/confirm', { body: CONFIRM })
    expect(second.status).toBe(422)
    expect(second.json.error.message).toContain('不是 JPG 或 PNG')
    const corrupt = await open([WRITE], fakeStore(png(0, 600)))
    const third = await corrupt.app.call('POST', '/aplus/uploads/confirm', { body: CONFIRM })
    expect(third.status).toBe(422)
    expect(third.json.error.message).toContain('损坏')
    for (const item of [mismatch, garbage, corrupt]) {
      expect(item.store.remove).toHaveBeenCalledWith(CONFIRM.objectKey)
      expect(item.stubs.$transaction).not.toHaveBeenCalled()
      expect(item.app.queue.add).not.toHaveBeenCalled()
    }
  })

  it('存储里记录的类型与申请时约定的不一致：拒绝并删除文件', async () => {
    const { app, store, stubs } = await open([WRITE], fakeStore(png(970, 600), {}, 'image/jpeg'))
    const res = await app.call('POST', '/aplus/uploads/confirm', { body: CONFIRM })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.json.error.code).toBe('FILE_TYPE_NOT_ALLOWED')
    expect(store.remove).toHaveBeenCalledWith(CONFIRM.objectKey)
    expect(stubs.$transaction).not.toHaveBeenCalled()
  })

  it('文件还没传上来（或不属于本企业）404；超过大小上限 413 类错误；存储不可用不泄露细节', async () => {
    const missing = await open([WRITE], fakeStore(png(1, 1), { confirmUpload: vi.fn().mockRejectedValue(new StorageError('OBJECT_NOT_FOUND', '没有这个对象')) }))
    expect((await missing.app.call('POST', '/aplus/uploads/confirm', { body: CONFIRM })).status).toBe(404)
    const big = await open([WRITE], fakeStore(png(1, 1), { confirmUpload: vi.fn().mockRejectedValue(new StorageError('STORAGE_OBJECT_TOO_LARGE', 'x')) }))
    const res = await big.app.call('POST', '/aplus/uploads/confirm', { body: CONFIRM })
    expect(res.json.error.code).toBe('FILE_TOO_LARGE')
    const down = await open([WRITE], fakeStore(png(1, 1), { confirmUpload: vi.fn().mockRejectedValue(new StorageError('STORAGE_UNAVAILABLE', 'secret-endpoint-detail')) }))
    const third = await down.app.call('POST', '/aplus/uploads/confirm', { body: CONFIRM })
    expect(third.status).toBeGreaterThanOrEqual(500)
    expect(JSON.stringify(third.json)).not.toContain('secret-endpoint-detail')
    for (const item of [missing, big, down]) expect(item.stubs.$transaction).not.toHaveBeenCalled()
  })

  it('入队失败：仍然 201 但 queued 为 false，上传记录标为失败（QUEUE_UNAVAILABLE）', async () => {
    const { app, stubs } = await open([WRITE])
    app.queue.add.mockRejectedValueOnce(new Error('redis down'))
    const res = await app.call('POST', '/aplus/uploads/confirm', { body: CONFIRM })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.data).toMatchObject({ queued: false, width: 970, height: 600 })
    expect(stubs.aplusWriteRun.updateMany.mock.calls[0]![0]).toMatchObject({ where: { id: res.json.data.runId }, data: { status: 'FAILED', failureCode: 'QUEUE_UNAVAILABLE' } })
  })
})
