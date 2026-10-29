import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StorageError } from './errors.js'
import { safeFileName } from './key.js'
import { LocalDiskStorage } from './local.js'
import { deriveSigningKey, signLocalToken, verifyLocalToken } from './local-token.js'

const KEY = 'tenants/t1/reports/2026/09/01/abc-file.csv'
const signingKey = deriveSigningKey('x'.repeat(40))

async function collect(stream: Readable) {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}
async function* generate(megabytes: number) {
  const chunk = Buffer.alloc(1024 * 1024, 'a')
  for (let index = 0; index < megabytes; index += 1) yield chunk
}
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(entries.map(entry => (entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : Promise.resolve([path.join(dir, entry.name)]))))
  return nested.flat()
}

describe('本地磁盘存储', () => {
  let root: string
  let now = new Date('2026-09-01T00:00:00Z')
  let storage: LocalDiskStorage
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'nova-storage-'))
    now = new Date('2026-09-01T00:00:00Z')
    storage = new LocalDiskStorage({ rootDir: root, signingKey, publicBaseUrl: 'http://127.0.0.1:4000/api/v1/storage/local', now: () => now })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('写入、读取、查询、删除；大小与 SHA-256 在写入过程中算出', async () => {
    const body = Buffer.from('订单号\t金额\n111\t19.9\n')
    const stored = await storage.put(KEY, body, { contentType: 'text/csv', contentDisposition: 'attachment; filename="orders.csv"' })
    expect(stored).toEqual({ key: KEY, sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex') })
    expect((await collect(await storage.openRead(KEY))).equals(body)).toBe(true)
    expect(await storage.stat(KEY)).toMatchObject({ key: KEY, sizeBytes: body.length, contentType: 'text/csv' })
    expect(await storage.readSidecar(KEY)).toMatchObject({ contentDisposition: 'attachment; filename="orders.csv"' })
    await storage.delete(KEY)
    expect(await storage.stat(KEY)).toBeNull()
    await expect(storage.openRead(KEY)).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' })
    await storage.delete(KEY) // 重复删除不报错
  })

  it('流式写入：写入完成（end 的回调）时文件已经落稳；中途不会出现半个正式文件', async () => {
    const writer = storage.openWriter(KEY)
    await new Promise<void>((resolve, reject) => Readable.from(generate(8)).pipe(writer.stream).on('finish', resolve).on('error', reject))
    const stored = await writer.done
    expect(stored.sizeBytes).toBe(8 * 1024 * 1024)
    expect((await storage.stat(KEY))?.sizeBytes).toBe(8 * 1024 * 1024)
    expect((await filesUnder(path.join(root, '.tmp'))).length).toBe(0)
  })

  it('超过大小上限：中止并丢弃，不留正式文件也不留临时文件', async () => {
    await expect(storage.put(KEY, Readable.from(generate(3)), { maxBytes: 1024 * 1024 })).rejects.toMatchObject({ code: 'STORAGE_OBJECT_TOO_LARGE' })
    expect(await storage.stat(KEY)).toBeNull()
    expect(await filesUnder(root)).toEqual([])
  })

  it('写到一半被中止（abort）：丢弃已写部分', async () => {
    const writer = storage.openWriter(KEY)
    writer.stream.write(Buffer.alloc(1024, 1))
    await writer.abort()
    await expect(writer.done).rejects.toBeTruthy()
    expect(await storage.stat(KEY)).toBeNull()
    expect(await filesUnder(root)).toEqual([])
  })

  it('路径校验：目录穿越、绝对路径、反斜杠、隐藏目录、非租户路径一律拒绝', async () => {
    const bad = [
      '../etc/passwd',
      'tenants/t1/../t2/x',
      '/etc/passwd',
      'tenants\\t1\\x',
      'tenants/t1//x',
      '.tmp/x',
      '.meta/x',
      'other/t1/x',
      'tenants',
      '',
      'tenants/t1/./x',
      `tenants/t1/${'a'.repeat(300)}`,
    ]
    for (const key of bad) {
      await expect(storage.put(key, Buffer.from('x'))).rejects.toMatchObject({ code: 'STORAGE_KEY_INVALID' })
      await expect(storage.openRead(key)).rejects.toMatchObject({ code: 'STORAGE_KEY_INVALID' })
      await expect(storage.delete(key)).rejects.toMatchObject({ code: 'STORAGE_KEY_INVALID' })
    }
    expect(await filesUnder(root)).toEqual([])
  })

  it('文件名净化：只保留安全字符，不会以点开头，不含路径', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('订单 报告 (9月).csv')).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(safeFileName('.hidden')).toBe('hidden')
    expect(safeFileName('报告')).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(safeFileName('', 'fallback')).toBe('fallback')
    expect(safeFileName('a'.repeat(500)).length).toBeLessThanOrEqual(100)
  })

  it('签名链接：只对指定文件、指定动作、有效期内有效', async () => {
    await storage.put(KEY, Buffer.from('x'))
    const download = await storage.signDownload(KEY, { ttlSeconds: 300 })
    const token = download.url.split('/').pop()!
    expect(download.url.startsWith('http://127.0.0.1:4000/api/v1/storage/local/')).toBe(true)
    expect(download.expiresAt.getTime()).toBe(now.getTime() + 300_000)
    expect(storage.verifyToken(token)).toMatchObject({ k: KEY, op: 'GET' })

    now = new Date(now.getTime() + 301_000)
    expect(() => storage.verifyToken(token)).toThrowError(expect.objectContaining({ code: 'STORAGE_TOKEN_EXPIRED' }))
  })

  it('签名链接：篡改、换文件、换动作、伪造签名都无效', () => {
    const token = signLocalToken(signingKey, { k: KEY, op: 'GET', exp: Math.floor(Date.now() / 1000) + 300 })
    const [version, body, signature] = token.split('.')
    const forgedBody = Buffer.from(JSON.stringify({ k: 'tenants/t2/reports/2026/09/01/secret.csv', op: 'GET', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')
    const upgraded = Buffer.from(JSON.stringify({ k: KEY, op: 'PUT', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')
    for (const forged of [
      `${version}.${forgedBody}.${signature}`,
      `${version}.${upgraded}.${signature}`,
      `${version}.${body}.${signature.slice(0, -2)}AA`,
      `${version}.${body}`,
      'garbage',
      '',
      `v2.${body}.${signature}`,
    ]) {
      expect(() => verifyLocalToken(signingKey, forged)).toThrowError(expect.objectContaining({ code: 'STORAGE_TOKEN_INVALID' }))
    }
    // 用另一把密钥签的令牌无效
    const other = signLocalToken(deriveSigningKey('y'.repeat(40)), { k: KEY, op: 'GET', exp: Math.floor(Date.now() / 1000) + 300 })
    expect(() => verifyLocalToken(signingKey, other)).toThrowError(StorageError)
  })

  it('直传凭证：令牌里带内容类型与大小上限', async () => {
    const upload = await storage.signUpload(KEY, { ttlSeconds: 300, contentType: 'image/png', maxBytes: 1000 })
    expect(upload.method).toBe('PUT')
    expect(upload.headers).toEqual({ 'Content-Type': 'image/png' })
    expect(storage.verifyToken(upload.url.split('/').pop()!)).toMatchObject({ op: 'PUT', ct: 'image/png', max: 1000, k: KEY })
  })
})
