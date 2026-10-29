import { createHash, createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { OssStorage } from './oss.js'
import { canonicalizedOssHeaders, canonicalizedResource, signV1 } from './oss-signature.js'

const ID = 'test-access-key-id'
const SECRET = 'test-access-key-secret'
const BUCKET = 'nova-test'
const KEY = 'tenants/t1/reports/2026/09/01/abc-orders.txt'

describe('OSS V1 签名', () => {
  it('与官方文档示例一致（PUT /nelson）', () => {
    const signature = signV1('OtxrzxIsfpFjA7SwPzILwy8Bw21TLhquhboDYROV', {
      verb: 'PUT',
      contentMd5: 'ODBGOERFMDMzQTczRUY3NUE3NzA5QzdFNUYzMDQxNEM=',
      contentType: 'text/html',
      dateOrExpires: 'Thu, 17 Nov 2005 18:49:58 GMT',
      headers: { 'X-OSS-Magic': 'abracadabra', 'x-oss-meta-author': 'foo@bar.com', 'Content-Type': 'text/html' },
      resource: canonicalizedResource('oss-example', 'nelson'),
    })
    expect(signature).toBe('26NBxoKdsyly4EDv6inkoDft/yA=')
  })

  it('规范化头：只取 x-oss- 开头的，名称小写、按字典序、值去首尾空白；子资源按字典序且只含参与签名的', () => {
    expect(canonicalizedOssHeaders({ 'X-OSS-B': ' 2 ', 'x-oss-a': '1', Date: 'x', 'Content-Type': 'y' })).toBe('x-oss-a:1\nx-oss-b:2\n')
    expect(canonicalizedResource('b', 'k/v', { uploadId: 'U', partNumber: '3', OSSAccessKeyId: 'ignored' })).toBe('/b/k/v?partNumber=3&uploadId=U')
    expect(canonicalizedResource('b', 'k', { uploads: '' })).toBe('/b/k?uploads')
  })
})

// ---- 内存里的 OSS 替身：校验请求签名，支持 PutObject、分段上传、读取、查询、删除与 URL 签名访问 ----
interface FakeState {
  objects: Map<string, { body: Buffer; headers: Record<string, string> }>
  uploads: Map<string, { key: string; parts: Map<number, Buffer>; headers: Record<string, string> }>
  log: string[]
  failNext: number
  signatureFailures: number
}

function startFakeOss(state: FakeState) {
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const [, bucket, ...rest] = url.pathname.split('/')
    const key = rest.map(decodeURIComponent).join('/')
    const query = Object.fromEntries(url.searchParams.entries())
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    state.log.push(`${req.method} ${key}${url.search ? `?${[...url.searchParams.keys()].filter(name => ['uploads', 'uploadId', 'partNumber'].includes(name)).join('&')}` : ''}`)
    const reply = (status: number, text = '', headers: Record<string, string> = {}) => {
      res.writeHead(status, headers)
      res.end(text)
    }

    if (bucket !== BUCKET) return reply(404, '<Error><Code>NoSuchBucket</Code></Error>')
    if (state.failNext > 0) {
      state.failNext -= 1
      return reply(503, '<Error><Code>ServiceUnavailable</Code></Error>')
    }

    const resourceQuery: Record<string, string> = {}
    for (const name of ['uploads', 'uploadId', 'partNumber']) if (url.searchParams.has(name)) resourceQuery[name] = url.searchParams.get(name) ?? ''
    const presigned = url.searchParams.has('Signature')
    const contentType = String(req.headers['content-type'] ?? '')
    let expected: string
    let given: string
    if (presigned) {
      if (Number(query.Expires) * 1000 < Date.now()) return reply(403, '<Error><Code>AccessDenied</Code></Error>')
      expected = signV1(SECRET, { verb: req.method ?? 'GET', contentType, dateOrExpires: query.Expires, resource: canonicalizedResource(BUCKET, key, resourceQuery) })
      given = query.Signature
      if (query.OSSAccessKeyId !== ID) return reply(403, '<Error><Code>InvalidAccessKeyId</Code></Error>')
    } else {
      const headers = Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, String(value)]))
      expected = signV1(SECRET, { verb: req.method ?? 'GET', contentType, dateOrExpires: headers.date ?? '', headers, resource: canonicalizedResource(BUCKET, key, resourceQuery) })
      const [, credential] = /^OSS ([^:]+):(.+)$/.exec(headers.authorization ?? '') ?? []
      given = /^OSS [^:]+:(.+)$/.exec(headers.authorization ?? '')?.[1] ?? ''
      if (credential !== ID) return reply(403, '<Error><Code>InvalidAccessKeyId</Code></Error>')
    }
    if (given !== expected) {
      state.signatureFailures += 1
      return reply(403, '<Error><Code>SignatureDoesNotMatch</Code></Error>')
    }

    const meta = (): Record<string, string> => ({
      ...(contentType ? { 'content-type': contentType } : {}),
      ...(req.headers['content-disposition'] ? { 'content-disposition': String(req.headers['content-disposition']) } : {}),
    })
    if (req.method === 'POST' && 'uploads' in query) {
      const uploadId = `U${state.uploads.size + 1}`
      state.uploads.set(uploadId, { key, parts: new Map(), headers: meta() })
      return reply(200, `<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`)
    }
    if (req.method === 'PUT' && query.uploadId) {
      const upload = state.uploads.get(query.uploadId)
      if (!upload) return reply(404, '<Error><Code>NoSuchUpload</Code></Error>')
      upload.parts.set(Number(query.partNumber), body)
      return reply(200, '', { etag: `"${createHash('md5').update(body).digest('hex')}"` })
    }
    if (req.method === 'POST' && query.uploadId) {
      const upload = state.uploads.get(query.uploadId)
      if (!upload) return reply(404, '<Error><Code>NoSuchUpload</Code></Error>')
      const numbers = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(match => Number(match[1]))
      state.objects.set(upload.key, { body: Buffer.concat(numbers.map(number => upload.parts.get(number)!)), headers: upload.headers })
      state.uploads.delete(query.uploadId)
      return reply(200, '<CompleteMultipartUploadResult/>')
    }
    if (req.method === 'DELETE' && query.uploadId) {
      state.uploads.delete(query.uploadId)
      return reply(204)
    }
    if (req.method === 'PUT') {
      state.objects.set(key, { body, headers: meta() })
      return reply(200)
    }
    const object = state.objects.get(key)
    if (req.method === 'DELETE') {
      state.objects.delete(key)
      return reply(204)
    }
    if (!object) return reply(404, '<Error><Code>NoSuchKey</Code></Error>')
    const headers = {
      'content-length': String(object.body.length),
      'last-modified': new Date('2026-09-01T00:00:00Z').toUTCString(),
      ...(object.headers['content-type'] ? { 'content-type': object.headers['content-type'] } : {}),
    }
    if (req.method === 'HEAD') return reply(200, '', headers)
    res.writeHead(200, headers)
    res.end(object.body)
  })
  return new Promise<{ server: Server; endpoint: string }>(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })))
}

describe('OSS 适配器（内存替身，校验签名）', () => {
  const state: FakeState = { objects: new Map(), uploads: new Map(), log: [], failNext: 0, signatureFailures: 0 }
  let server: Server
  let storage: OssStorage
  let endpoint: string
  let now = new Date()

  beforeAll(async () => {
    ;({ server, endpoint } = await startFakeOss(state))
  })
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve))
  })
  beforeEach(() => {
    state.objects.clear()
    state.uploads.clear()
    state.log.length = 0
    state.failNext = 0
    state.signatureFailures = 0
    now = new Date()
    storage = new OssStorage({ endpoint, bucket: BUCKET, accessKeyId: ID, accessKeySecret: SECRET, addressing: 'path', partSizeBytes: 100 * 1024, retryBaseMs: 1, now: () => now })
  })

  it('小文件：一次 PutObject；读取、查询、删除', async () => {
    const body = Buffer.from('订单\t金额\n1\t2\n')
    const stored = await storage.put(KEY, body, { contentType: 'text/plain', contentDisposition: 'attachment; filename="a.txt"' })
    expect(stored.sha256).toBe(createHash('sha256').update(body).digest('hex'))
    expect(state.log).toEqual([`PUT ${KEY}`])
    expect(state.objects.get(KEY)?.headers['content-disposition']).toBe('attachment; filename="a.txt"')
    const chunks: Buffer[] = []
    for await (const chunk of await storage.openRead(KEY)) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).equals(body)).toBe(true)
    expect(await storage.stat(KEY)).toMatchObject({ sizeBytes: body.length, contentType: 'text/plain' })
    await storage.delete(KEY)
    expect(await storage.stat(KEY)).toBeNull()
    await expect(storage.openRead(KEY)).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' })
    expect(state.signatureFailures).toBe(0)
  })

  it('大文件：分段上传，内容拼接正确，大小与摘要与源一致', async () => {
    const source = Buffer.alloc(100 * 1024 * 5 + 777)
    for (let index = 0; index < source.length; index += 1) source[index] = (index * 31) % 251
    async function* slices() {
      for (let offset = 0; offset < source.length; offset += 40_000) yield source.subarray(offset, offset + 40_000)
    }
    const stored = await storage.put(KEY, Readable.from(slices()), { contentType: 'application/octet-stream' })
    expect(stored.sizeBytes).toBe(source.length)
    expect(stored.sha256).toBe(createHash('sha256').update(source).digest('hex'))
    expect(state.objects.get(KEY)?.body.equals(source)).toBe(true)
    expect(state.log.filter(line => line.startsWith('PUT') && line.includes('partNumber')).length).toBe(5)
    expect(state.log[0]).toBe(`POST ${KEY}?uploads`)
    expect(state.signatureFailures).toBe(0)
  })

  it('临时故障（503）自动重试后成功；一直失败则报“存储暂时不可用”', async () => {
    state.failNext = 2
    await storage.put(KEY, Buffer.from('x'))
    expect(state.objects.has(KEY)).toBe(true)
    state.failNext = 10
    await expect(storage.put(KEY, Buffer.from('y'))).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
  })

  it('写到一半失败：取消分段上传，不留半个对象', async () => {
    const writer = storage.openWriter(KEY)
    writer.stream.write(Buffer.alloc(150 * 1024, 1))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(state.uploads.size).toBe(1)
    await writer.abort()
    await writer.done.catch(() => undefined)
    expect(state.uploads.size).toBe(0)
    expect(state.objects.size).toBe(0)
  })

  it('超过大小上限：中止并取消分段上传', async () => {
    await expect(storage.put(KEY, Readable.from([Buffer.alloc(150 * 1024), Buffer.alloc(150 * 1024)]), { maxBytes: 200 * 1024 })).rejects.toMatchObject({ code: 'STORAGE_OBJECT_TOO_LARGE' })
    expect(state.objects.size).toBe(0)
    expect(state.uploads.size).toBe(0)
  })

  it('密钥不对：对象存储拒绝，错误里不含密钥', async () => {
    const wrong = new OssStorage({ endpoint, bucket: BUCKET, accessKeyId: ID, accessKeySecret: 'wrong-secret', addressing: 'path', retryBaseMs: 1 })
    const error = await wrong.put(KEY, Buffer.from('x')).catch((e: Error) => e)
    expect(error).toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    expect(String((error as Error).message)).not.toContain('wrong-secret')
    expect(String((error as Error).message)).toContain('SignatureDoesNotMatch')
  })

  it('下载签名链接：有效期内可读；过期被拒；改路径被拒', async () => {
    await storage.put(KEY, Buffer.from('hello'))
    const signed = await storage.signDownload(KEY, { ttlSeconds: 300 })
    expect(signed.expiresAt.getTime()).toBe(Math.floor(now.getTime() / 1000) * 1000 + 300_000)
    const ok = await fetch(signed.url)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('hello')
    // 同一签名换成另一个文件
    state.objects.set('tenants/t2/reports/2026/09/01/secret.txt', { body: Buffer.from('secret'), headers: {} })
    const swapped = signed.url.replace(encodeURIComponent('t1').replace('%2F', '/'), 't2').replace('abc-orders.txt', 'secret.txt')
    expect((await fetch(swapped)).status).toBe(403)
    const expired = await new OssStorage({ endpoint, bucket: BUCKET, accessKeyId: ID, accessKeySecret: SECRET, addressing: 'path', now: () => new Date(Date.now() - 3600_000) }).signDownload(KEY, {
      ttlSeconds: 60,
    })
    expect((await fetch(expired.url)).status).toBe(403)
  })

  it('直传签名链接：内容类型是签名的一部分，类型不符被拒', async () => {
    const ticket = await storage.signUpload(KEY, { ttlSeconds: 300, contentType: 'image/png', maxBytes: 1000 })
    expect(ticket.method).toBe('PUT')
    expect(ticket.headers).toEqual({ 'Content-Type': 'image/png' })
    const wrongType = await fetch(ticket.url, { method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: 'x' })
    expect(wrongType.status).toBe(403)
    const ok = await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: Buffer.from('png-bytes') })
    expect(ok.status).toBe(200)
    expect(state.objects.get(KEY)?.body.toString()).toBe('png-bytes')
    const asGet = await fetch(ticket.url.replace(/^/, ''), { method: 'GET' })
    expect(asGet.status).toBe(403) // 上传链接不能用来读取
  })

  it('配置不完整直接拒绝', () => {
    expect(() => new OssStorage({ endpoint: '', bucket: BUCKET, accessKeyId: ID, accessKeySecret: SECRET })).toThrowError(expect.objectContaining({ code: 'STORAGE_CONFIG_INVALID' }))
  })

  it('用 createHmac 独立复算：请求头签名格式为 OSS <id>:<base64(hmac-sha1)>', () => {
    const resource = canonicalizedResource(BUCKET, KEY)
    const expected = createHmac('sha1', SECRET).update(`GET\n\n\nThu, 01 Jan 1970 00:00:00 GMT\n${resource}`).digest('base64')
    expect(signV1(SECRET, { verb: 'GET', dateOrExpires: 'Thu, 01 Jan 1970 00:00:00 GMT', resource })).toBe(expected)
  })
})
