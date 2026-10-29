import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { StorageError, objectNotFound } from './errors.js'
import { assertStorageKey } from './key.js'
import { authorizationHeader, canonicalizedResource, signV1 } from './oss-signature.js'
import type { ObjectMeta, ObjectStorage, ObjectWriter, SignDownloadOptions, SignUploadOptions, SignedUrl, StoredObject, WriteOptions } from './types.js'
import { createObjectWriter, type ByteSink } from './writer.js'

// 阿里云对象存储适配器：直接用 OSS 的 HTTP 接口（V1 签名），不引入 SDK。
// - 小文件一次 PutObject；大文件分段上传（每段 8MB，内存里同时只有一段），所以下载流水线可以一边下载一边写入，常驻内存与文件大小无关；
// - 浏览器直传与下载走服务端签发的短时 URL 签名链接；
// - 没有“列出文件”的能力。

export interface OssStorageOptions {
  /** 例如 oss-cn-hongkong.aliyuncs.com（内网地址加 -internal）；也可以带协议，如 http://127.0.0.1:9000（仅测试）。 */
  endpoint: string
  bucket: string
  accessKeyId: string
  accessKeySecret: string
  /** virtual-host：`https://桶.endpoint/路径`（OSS 的实际方式）；path：`endpoint/桶/路径`（仅用于测试替身）。 */
  addressing?: 'virtual-host' | 'path'
  /** 分段大小（字节），OSS 要求除最后一段外不小于 100KB。 */
  partSizeBytes?: number
  /** 单次请求失败（网络、5xx、429）的最大尝试次数。 */
  attempts?: number
  retryBaseMs?: number
  fetchImpl?: typeof fetch
  now?: () => Date
}

export const DEFAULT_PART_SIZE = 8 * 1024 * 1024
const MAX_PARTS = 10_000

interface RequestInput {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD'
  key: string
  query?: Record<string, string>
  headers?: Record<string, string>
  body?: Buffer
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const retryableStatus = (status: number) => status === 429 || status >= 500

export class OssStorage implements ObjectStorage {
  readonly driver = 'oss' as const
  private readonly doFetch: typeof fetch
  private readonly now: () => Date
  private readonly partSize: number
  private readonly attempts: number
  private readonly retryBaseMs: number
  private readonly origin: { scheme: string; host: string }

  constructor(private readonly options: OssStorageOptions) {
    if (!options.bucket || !options.endpoint || !options.accessKeyId || !options.accessKeySecret) throw new StorageError('STORAGE_CONFIG_INVALID', '对象存储配置不完整')
    const hasScheme = /^https?:\/\//i.test(options.endpoint)
    const parsed = new URL(hasScheme ? options.endpoint : `https://${options.endpoint}`)
    this.origin = { scheme: parsed.protocol.replace(':', ''), host: parsed.host }
    this.doFetch = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
    this.partSize = Math.max(100 * 1024, options.partSizeBytes ?? DEFAULT_PART_SIZE)
    this.attempts = Math.max(1, options.attempts ?? 3)
    this.retryBaseMs = options.retryBaseMs ?? 200
  }

  // ---- 地址与签名 ----

  private baseUrl(key: string, query: Record<string, string>): string {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/')
    const search = Object.entries(query)
      .map(([name, value]) => (value === '' ? encodeURIComponent(name) : `${encodeURIComponent(name)}=${encodeURIComponent(value)}`))
      .join('&')
    const { scheme, host } = this.origin
    const base = (this.options.addressing ?? 'virtual-host') === 'path' ? `${scheme}://${host}/${this.options.bucket}/${encodedKey}` : `${scheme}://${this.options.bucket}.${host}/${encodedKey}`
    return search ? `${base}?${search}` : base
  }

  private async request(input: RequestInput): Promise<Response> {
    assertStorageKey(input.key)
    const query = input.query ?? {}
    let lastError: unknown
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      const headers: Record<string, string> = { ...(input.headers ?? {}), Date: this.now().toUTCString() }
      const signature = signV1(this.options.accessKeySecret, {
        verb: input.method,
        contentType: headers['Content-Type'],
        dateOrExpires: headers.Date,
        headers,
        resource: canonicalizedResource(this.options.bucket, input.key, query),
      })
      headers.Authorization = authorizationHeader(this.options.accessKeyId, signature)
      try {
        const response = await this.doFetch(this.baseUrl(input.key, query), { method: input.method, headers, body: input.body as BodyInit | undefined })
        if (!retryableStatus(response.status) || attempt === this.attempts) return response
        await response.arrayBuffer().catch(() => undefined) // 丢弃响应体，释放连接
        lastError = new Error(`HTTP ${response.status}`)
      } catch (error) {
        lastError = error
        if (attempt === this.attempts) break
      }
      await sleep(this.retryBaseMs * 2 ** (attempt - 1))
    }
    throw new StorageError('STORAGE_UNAVAILABLE', '对象存储暂时不可用', { cause: lastError })
  }

  /** 非 2xx 一律转成存储错误；错误信息只带状态码与 OSS 的错误代码，不带请求头与密钥。 */
  private async fail(response: Response, action: string): Promise<never> {
    const text = await response.text().catch(() => '')
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1]
    throw new StorageError('STORAGE_UNAVAILABLE', `对象存储${action}失败（${response.status}${code ? ` ${code}` : ''}）`)
  }

  // ---- 写入 ----

  openWriter(key: string, options: WriteOptions = {}): ObjectWriter {
    assertStorageKey(key)
    const objectHeaders = (): Record<string, string> => ({
      ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
      ...(options.contentDisposition ? { 'Content-Disposition': options.contentDisposition } : {}),
    })
    let pending: Buffer[] = []
    let pendingBytes = 0
    let uploadId: string | undefined
    const etags: string[] = []
    // 正在进行的写入：中止时要等它结束，否则“开始分段上传”的响应可能在中止之后才回来，留下孤儿上传
    let current: Promise<unknown> = Promise.resolve()
    let aborting: Promise<void> | undefined

    const initiate = async () => {
      const response = await this.request({ method: 'POST', key, query: { uploads: '' }, headers: objectHeaders() })
      if (!response.ok) await this.fail(response, '开始分段上传')
      const id = /<UploadId>([^<]+)<\/UploadId>/.exec(await response.text())?.[1]
      if (!id) throw new StorageError('STORAGE_UNAVAILABLE', '对象存储没有返回分段上传编号')
      uploadId = id
    }
    const uploadPart = async (body: Buffer) => {
      if (!uploadId) await initiate()
      const partNumber = etags.length + 1
      if (partNumber > MAX_PARTS) throw new StorageError('STORAGE_OBJECT_TOO_LARGE', '文件超过分段上传的最大段数')
      const response = await this.request({ method: 'PUT', key, query: { partNumber: String(partNumber), uploadId: uploadId! }, body })
      if (!response.ok) await this.fail(response, `上传第 ${partNumber} 段`)
      const etag = response.headers.get('etag')
      if (!etag) throw new StorageError('STORAGE_UNAVAILABLE', '对象存储没有返回分段校验值')
      await response.arrayBuffer().catch(() => undefined)
      etags.push(etag)
    }
    const takePending = () => {
      const body = pending.length === 1 ? pending[0] : Buffer.concat(pending)
      pending = []
      pendingBytes = 0
      return body
    }

    const sink: ByteSink = {
      write: async chunk => {
        pending.push(chunk)
        pendingBytes += chunk.length
        if (pendingBytes < this.partSize) return
        const running = uploadPart(takePending())
        current = running.catch(() => undefined)
        await running
      },
      finish: async () => {
        if (!uploadId) {
          // 不足一段：一次 PutObject
          const response = await this.request({ method: 'PUT', key, headers: objectHeaders(), body: pending.length ? takePending() : Buffer.alloc(0) })
          if (!response.ok) await this.fail(response, '写入')
          await response.arrayBuffer().catch(() => undefined)
          return
        }
        if (pendingBytes > 0) await uploadPart(takePending())
        const xml = `<CompleteMultipartUpload>${etags.map((etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join('')}</CompleteMultipartUpload>`
        const response = await this.request({ method: 'POST', key, query: { uploadId }, headers: { 'Content-Type': 'application/xml' }, body: Buffer.from(xml) })
        // 完成请求即使返回 200，响应体里也可能是错误（OSS 的行为），所以要检查正文
        const text = await response.text().catch(() => '')
        if (!response.ok || /<Error>/.test(text)) throw new StorageError('STORAGE_UNAVAILABLE', `对象存储完成分段上传失败（${response.status}）`)
        uploadId = undefined // 已完成，之后的 abort 不应再去取消这个上传
      },
      // 幂等：多次调用得到同一个结果，且在对象存储确认取消之后才返回
      abort: () =>
        (aborting ??= (async () => {
          await current
          pending = []
          pendingBytes = 0
          if (!uploadId) return
          const id = uploadId
          uploadId = undefined
          await this.request({ method: 'DELETE', key, query: { uploadId: id } })
            .then(response => response.arrayBuffer())
            .catch(() => undefined)
        })()),
    }
    return createObjectWriter(key, sink, options.maxBytes)
  }

  async put(key: string, body: Buffer | Readable, options: WriteOptions = {}): Promise<StoredObject> {
    const writer = this.openWriter(key, options)
    try {
      await pipeline(Buffer.isBuffer(body) ? Readable.from([body]) : body, writer.stream)
      return await writer.done
    } catch (error) {
      await writer.abort()
      throw error
    }
  }

  // ---- 读取与删除 ----

  async openRead(key: string): Promise<Readable> {
    const response = await this.request({ method: 'GET', key })
    if (response.status === 404) throw objectNotFound()
    if (!response.ok || !response.body) await this.fail(response, '读取')
    return Readable.fromWeb(response.body as never)
  }

  async stat(key: string): Promise<ObjectMeta | null> {
    const response = await this.request({ method: 'HEAD', key })
    if (response.status === 404) return null
    if (!response.ok) await this.fail(response, '查询')
    return {
      key,
      sizeBytes: Number(response.headers.get('content-length') ?? 0),
      contentType: response.headers.get('content-type') ?? undefined,
      lastModified: new Date(response.headers.get('last-modified') ?? this.now()),
    }
  }

  async delete(key: string): Promise<void> {
    const response = await this.request({ method: 'DELETE', key })
    if (!response.ok && response.status !== 404) await this.fail(response, '删除')
    await response.arrayBuffer().catch(() => undefined)
  }

  // ---- 短时签名链接 ----

  private presign(verb: 'GET' | 'PUT', key: string, ttlSeconds: number, contentType?: string): SignedUrl {
    assertStorageKey(key)
    const expires = Math.floor(this.now().getTime() / 1000) + ttlSeconds
    const signature = signV1(this.options.accessKeySecret, { verb, contentType, dateOrExpires: String(expires), resource: canonicalizedResource(this.options.bucket, key) })
    const query = { OSSAccessKeyId: this.options.accessKeyId, Expires: String(expires), Signature: signature }
    return { url: this.baseUrl(key, query), method: verb, headers: contentType ? { 'Content-Type': contentType } : {}, expiresAt: new Date(expires * 1000) }
  }

  async signDownload(key: string, options: SignDownloadOptions): Promise<SignedUrl> {
    return this.presign('GET', key, options.ttlSeconds)
  }

  async signUpload(key: string, options: SignUploadOptions): Promise<SignedUrl> {
    return this.presign('PUT', key, options.ttlSeconds, options.contentType)
  }
}
