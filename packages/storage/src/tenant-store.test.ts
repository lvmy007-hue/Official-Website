import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createObjectStorage, storageDriverFrom } from './config.js'
import { LocalDiskStorage } from './local.js'
import { deriveSigningKey } from './local-token.js'
import { MAX_SIGNED_URL_TTL_SECONDS, TenantObjectStore } from './tenant-store.js'
import type { ObjectStorage } from './types.js'

async function text(stream: Readable) {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

// 租户隔离（P1-23 验收：无法跨租户访问或枚举文件）

describe('租户对象存储', () => {
  let root: string
  let storage: ObjectStorage
  let a: TenantObjectStore
  let b: TenantObjectStore
  const date = new Date('2026-09-03T08:00:00Z')

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'nova-tenant-store-'))
    storage = new LocalDiskStorage({ rootDir: root, signingKey: deriveSigningKey('k'.repeat(40)), publicBaseUrl: 'http://127.0.0.1:4000/api/v1/storage/local' })
    a = new TenantObjectStore(storage, 'tenant-a')
    b = new TenantObjectStore(storage, 'tenant-b')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('路径按“租户 / 数据域 / 日期 / 文件名”组织，文件名带随机编号（同名文件路径也不同，无法猜测）', async () => {
    const first = await a.put({ domain: 'reports', name: '订单报告.csv', date }, Buffer.from('1'))
    const second = await a.put({ domain: 'reports', name: '订单报告.csv', date }, Buffer.from('2'))
    expect(first.key).toMatch(/^tenants\/tenant-a\/reports\/2026\/09\/03\/[0-9a-f-]{36}-[A-Za-z0-9._-]+$/)
    expect(second.key).not.toBe(first.key)
  })

  it('租户乙拿到租户甲的路径：读取、查询、签名、删除、确认上传一律是“文件不存在”，与真正不存在的文件无法区分', async () => {
    const stored = await a.put({ domain: 'reports', name: 'secret.csv', date }, Buffer.from('甲的数据'))
    const missing = b.newKey({ domain: 'reports', name: 'secret.csv', date })
    const probes: Array<(key: string) => Promise<unknown>> = [key => b.read(key), key => b.stat(key), key => b.signDownload(key), key => b.remove(key), key => b.confirmUpload(key, 1000)]
    const outcome = (promise: Promise<unknown>) =>
      promise.then(
        value => ({ value }),
        (error: { code?: string; message?: string }) => ({ code: error.code, message: error.message }),
      )
    for (const probe of probes) {
      // 不属于自己的文件，与自己名下不存在的文件，表现必须完全一致（结果或错误都一样）
      expect(await outcome(probe(stored.key))).toEqual(await outcome(probe(missing)))
    }
    expect(await outcome(b.read(stored.key))).toEqual({ code: 'OBJECT_NOT_FOUND', message: '文件不存在' })
    expect(await b.stat(stored.key)).toBeNull()
    await b.remove(stored.key)
    // 甲的文件完好
    expect(await text(await a.read(stored.key))).toBe('甲的数据')
  })

  it('伪造路径：目录穿越、改租户段、绝对路径都拿不到别人的文件', async () => {
    const stored = await a.put({ domain: 'reports', name: 'secret.csv', date }, Buffer.from('甲的数据'))
    const tail = stored.key.replace('tenants/tenant-a/', '')
    const forged = [
      `tenants/tenant-b/${tail}`,
      `tenants/tenant-b/../tenant-a/${tail}`,
      `tenants/tenant-a/../tenant-a/${tail}`,
      `/${stored.key}`,
      `${stored.key}/../../..`,
      `tenants\\tenant-a\\${tail}`,
      `tenants/tenant-a-evil/${tail}`,
    ]
    for (const key of forged) {
      await expect(b.read(key)).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' })
      await expect(a.read(key)).rejects.toBeTruthy() // 即使甲自己也不能用不规范的路径
    }
  })

  it('不提供任何“列出文件”的能力（存储接口与租户接口都没有），所以无法枚举', () => {
    for (const target of [a as object, storage as object]) {
      const methods = new Set<string>()
      for (let proto = Object.getPrototypeOf(target); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) Object.getOwnPropertyNames(proto).forEach(name => methods.add(name))
      expect([...methods].filter(name => /^(list|scan|enumerate|readdir|glob|find)/i.test(name))).toEqual([])
    }
  })

  it('租户编号格式不合法时直接拒绝构造', () => {
    for (const id of ['', 'a/b', '../x', 'a b', 'x'.repeat(65)]) expect(() => new TenantObjectStore(storage, id)).toThrow()
  })

  it('下载链接：只给本租户已存在的文件签发；有效期默认 5 分钟、最长 15 分钟', async () => {
    const stored = await a.put({ domain: 'exports', name: 'e.csv', date }, Buffer.from('x'))
    const normal = await a.signDownload(stored.key)
    expect(normal.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000 + 1500)
    const capped = await a.signDownload(stored.key, 86_400)
    expect(capped.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(MAX_SIGNED_URL_TTL_SECONDS * 1000 + 1500)
    await expect(a.signDownload(a.newKey({ domain: 'exports', name: 'nope.csv', date }))).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' })
    await expect(a.signDownload(stored.key, 0)).rejects.toMatchObject({ code: 'STORAGE_CONFIG_INVALID' })
  })

  it('直传：路径由服务端生成；JSON、表单等类型被拒；凭证带类型与上限', async () => {
    const ticket = await a.signUpload({ domain: 'attachments', name: '合同 扫描.pdf', date }, { contentType: 'application/pdf', maxBytes: 5_000_000 })
    expect(ticket.key.startsWith('tenants/tenant-a/attachments/2026/09/03/')).toBe(true)
    expect(ticket).toMatchObject({ method: 'PUT', maxBytes: 5_000_000, headers: { 'Content-Type': 'application/pdf' } })
    for (const type of ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data', '']) {
      await expect(a.signUpload({ domain: 'attachments', name: 'x', date }, { contentType: type })).rejects.toMatchObject({ code: 'STORAGE_CONTENT_TYPE_NOT_ALLOWED' })
    }
  })

  it('确认直传：超过上限的文件被丢弃', async () => {
    const stored = await a.put({ domain: 'attachments', name: 'big.bin', date }, Buffer.alloc(2000))
    await expect(a.confirmUpload(stored.key, 1000)).rejects.toMatchObject({ code: 'STORAGE_OBJECT_TOO_LARGE' })
    expect(await a.stat(stored.key)).toBeNull()
    const ok = await a.put({ domain: 'attachments', name: 'small.bin', date }, Buffer.alloc(500))
    expect(await a.confirmUpload(ok.key, 1000)).toMatchObject({ sizeBytes: 500 })
  })
})

describe('存储配置', () => {
  it('默认本地驱动；驱动名不合法报错', () => {
    expect(storageDriverFrom({})).toBe('local')
    expect(() => storageDriverFrom({ STORAGE_DRIVER: 's3' })).toThrow()
  })

  it('本地驱动：生产环境必须显式设置签名密钥；其他环境可由 JWT_SECRET 派生', () => {
    expect(() => createObjectStorage({ APP_MODE: 'production', JWT_SECRET: 'j'.repeat(40) })).toThrowError(expect.objectContaining({ code: 'STORAGE_CONFIG_INVALID' }))
    expect(createObjectStorage({ APP_MODE: 'production', STORAGE_SIGNING_KEY: 'k'.repeat(40), STORAGE_LOCAL_DIR: os.tmpdir() }).driver).toBe('local')
    expect(createObjectStorage({ JWT_SECRET: 'j'.repeat(40), STORAGE_LOCAL_DIR: os.tmpdir() }).driver).toBe('local')
    expect(() => createObjectStorage({ STORAGE_SIGNING_KEY: 'short' })).toThrow()
  })

  it('云存储：缺少配置项时逐项指出；齐全则创建', () => {
    expect(() => createObjectStorage({ STORAGE_DRIVER: 'oss' })).toThrowError(/OSS_ENDPOINT.*OSS_BUCKET.*OSS_ACCESS_KEY_ID.*OSS_ACCESS_KEY_SECRET/)
    expect(createObjectStorage({ STORAGE_DRIVER: 'oss', OSS_ENDPOINT: 'oss-cn-hongkong.aliyuncs.com', OSS_BUCKET: 'b', OSS_ACCESS_KEY_ID: 'i', OSS_ACCESS_KEY_SECRET: 's' }).driver).toBe('oss')
  })
})
