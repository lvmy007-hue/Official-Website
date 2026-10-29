import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ObjectStorageService } from '../../platform/storage'
import { createTestApp } from '../../testing/harness'

// 本地存储驱动的签名链接（P1-23）：令牌是唯一凭证，绑定文件、动作、内容类型与大小上限。
const root = mkdtempSync(join(tmpdir(), 'nova-storage-http-'))
const saved = { ...process.env }

beforeAll(() => {
  process.env.STORAGE_DRIVER = 'local'
  process.env.STORAGE_LOCAL_DIR = root
  process.env.STORAGE_SIGNING_KEY = 'x'.repeat(48)
})
afterAll(() => {
  process.env = saved
  rmSync(root, { recursive: true, force: true })
})

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)

async function setup() {
  harness = await createTestApp({})
  const objects = harness.app.get(ObjectStorageService)
  const base = (await harness.app.getUrl()).replace('[::1]', '127.0.0.1')
  const raw = (method: string, token: string, init: { body?: string; type?: string } = {}) =>
    fetch(`${base}/api/v1/storage/local/${token}`, { method, headers: init.type ? { 'content-type': init.type } : {}, body: init.body })
  return { objects, raw }
}

describe('本地存储签名链接', () => {
  it('直传后可凭下载链接取回；下载一律当作附件、禁止缓存与类型嗅探', async () => {
    const { objects, raw } = await setup()
    const store = objects.forTenant('tenant-a')
    const ticket = await store.signUpload({ domain: 'attachments', name: 'note.txt' }, { contentType: 'text/plain', maxBytes: 1024 })
    const put = await raw('PUT', tokenOf(ticket.url), { body: 'hello', type: 'text/plain' })
    expect(put.status).toBe(200)
    expect((await put.json()).data).toEqual({ sizeBytes: 5 })
    expect((await store.confirmUpload(ticket.key, 1024)).sizeBytes).toBe(5)

    const down = await store.signDownload(ticket.key)
    const res = await raw('GET', tokenOf(down.url))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(res.headers.get('content-disposition')).toBe('attachment')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('令牌被篡改：拒绝（STORAGE_LINK_INVALID）', async () => {
    const { objects, raw } = await setup()
    const store = objects.forTenant('tenant-a')
    const stored = await store.put({ domain: 'attachments', name: 'b.txt' }, Buffer.from('secret'))
    const token = tokenOf((await store.signDownload(stored.key)).url)
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa')
    const res = await raw('GET', tampered)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('STORAGE_LINK_INVALID')
    expect((await raw('GET', 'not-a-token')).status).toBe(403)
  })

  it('链接过期：410（STORAGE_LINK_EXPIRED）', async () => {
    const { objects, raw } = await setup()
    const store = objects.forTenant('tenant-a')
    const stored = await store.put({ domain: 'attachments', name: 'c.txt' }, Buffer.from('x'))
    const token = tokenOf((await store.signDownload(stored.key, 60)).url)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 3600_000)
      const res = await raw('GET', token)
      expect(res.status).toBe(410)
      expect((await res.json()).error.code).toBe('STORAGE_LINK_EXPIRED')
    } finally {
      vi.useRealTimers()
    }
  })

  it('换动作不行：下载链接不能用来上传，上传链接不能用来下载', async () => {
    const { objects, raw } = await setup()
    const store = objects.forTenant('tenant-a')
    const stored = await store.put({ domain: 'attachments', name: 'd.txt' }, Buffer.from('original'))
    const downloadToken = tokenOf((await store.signDownload(stored.key)).url)
    const put = await raw('PUT', downloadToken, { body: 'overwrite', type: 'text/plain' })
    expect(put.status).toBe(403)
    const uploadTicket = await store.signUpload({ domain: 'attachments', name: 'e.txt' }, { contentType: 'text/plain' })
    expect((await raw('GET', tokenOf(uploadTicket.url))).status).toBe(403)
    // 原文件没有被覆盖
    const check = await raw('GET', downloadToken)
    expect(await check.text()).toBe('original')
  })

  it('上传：类型与凭证不符 415，超过大小上限 413 且不留文件', async () => {
    const { objects, raw } = await setup()
    const store = objects.forTenant('tenant-a')
    const ticket = await store.signUpload({ domain: 'attachments', name: 'f.csv' }, { contentType: 'text/csv', maxBytes: 10 })
    const wrongType = await raw('PUT', tokenOf(ticket.url), { body: 'a,b', type: 'application/zip' })
    expect(wrongType.status).toBe(415)
    expect((await wrongType.json()).error.code).toBe('FILE_TYPE_NOT_ALLOWED')

    const tooLarge = await raw('PUT', tokenOf(ticket.url), { body: 'x'.repeat(1000), type: 'text/csv' })
    expect(tooLarge.status).toBe(413)
    expect((await tooLarge.json()).error.code).toBe('FILE_TOO_LARGE')
    expect(await store.stat(ticket.key)).toBeNull()
  })

  it('跨租户：别的租户拿不到文件，也不能为它签发链接；不存在与不属于自己表现一致', async () => {
    const { objects } = await setup()
    const owner = objects.forTenant('tenant-a')
    const other = objects.forTenant('tenant-b')
    const stored = await owner.put({ domain: 'attachments', name: 'g.txt' }, Buffer.from('私有'))
    await expect(other.signDownload(stored.key)).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' })
    await expect(other.read(stored.key)).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' })
    expect(await other.stat(stored.key)).toBeNull()
    await other.remove(stored.key)
    expect(await owner.stat(stored.key)).not.toBeNull()
  })

  it('这两个接口无需登录态', async () => {
    const { raw } = await setup()
    expect((await raw('GET', 'abc')).status).toBe(403)
  })
})

describe('使用云存储时', () => {
  it('本地签名链接接口不存在', async () => {
    const previous = { ...process.env }
    process.env.STORAGE_DRIVER = 'oss'
    process.env.OSS_ENDPOINT = 'oss-cn-hongkong.aliyuncs.com'
    process.env.OSS_BUCKET = 'bucket'
    process.env.OSS_ACCESS_KEY_ID = 'id'
    process.env.OSS_ACCESS_KEY_SECRET = 'secret'
    try {
      harness = await createTestApp({})
      const base = (await harness.app.getUrl()).replace('[::1]', '127.0.0.1')
      const res = await fetch(`${base}/api/v1/storage/local/abc`)
      expect(res.status).toBe(404)
    } finally {
      process.env = previous
    }
  })

  it('存储配置不全时，文件功能给出明确错误而不是崩溃', async () => {
    const previous = { ...process.env }
    process.env.STORAGE_DRIVER = 'oss'
    delete process.env.OSS_BUCKET
    try {
      harness = await createTestApp({})
      const base = (await harness.app.getUrl()).replace('[::1]', '127.0.0.1')
      const res = await fetch(`${base}/api/v1/storage/local/abc`)
      expect(res.status).toBe(503)
      expect((await res.json()).error.code).toBe('STORAGE_NOT_CONFIGURED')
    } finally {
      process.env = previous
    }
  })
})
