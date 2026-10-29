import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { StorageError, objectNotFound } from './errors.js'
import { assertStorageKey } from './key.js'
import { signLocalToken, verifyLocalToken, type LocalTokenPayload } from './local-token.js'
import type { ObjectMeta, ObjectStorage, ObjectWriter, SignDownloadOptions, SignUploadOptions, SignedUrl, StoredObject, WriteOptions } from './types.js'
import { createObjectWriter, type ByteSink } from './writer.js'

// 本地磁盘适配器（开发与单机部署）：文件放在根目录下，路径与云存储一致（tenants/租户/数据域/日期/文件名）。
// 临时文件放在 .tmp，附带信息（内容类型、下载文件名）放在 .meta——两个目录名以点开头，业务路径不可能以点开头，不会冲突。
// 签名链接指向 API 的 /storage/local/<令牌>，由 API 校验令牌后读写文件。

interface SidecarMeta {
  contentType?: string
  contentDisposition?: string
}

export interface LocalStorageOptions {
  rootDir: string
  /** 签名密钥（见 deriveSigningKey）。 */
  signingKey: Buffer
  /** 签名链接的前缀，例如 http://127.0.0.1:4000/api/v1/storage/local ；令牌拼在其后。 */
  publicBaseUrl: string
  now?: () => Date
}

export class LocalDiskStorage implements ObjectStorage {
  readonly driver = 'local' as const
  private readonly root: string
  private readonly now: () => Date

  constructor(private readonly options: LocalStorageOptions) {
    this.root = path.resolve(options.rootDir)
    this.now = options.now ?? (() => new Date())
  }

  /** 路径 → 磁盘文件；解析后必须仍在根目录之内（双保险，路径校验之外再查一次）。 */
  private pathOf(key: string): string {
    assertStorageKey(key)
    const resolved = path.resolve(this.root, ...key.split('/'))
    if (!resolved.startsWith(this.root + path.sep)) throw new StorageError('STORAGE_KEY_INVALID', '文件路径不合法')
    return resolved
  }

  private metaPathOf(key: string): string {
    assertStorageKey(key)
    return path.resolve(this.root, '.meta', ...key.split('/')) + '.json'
  }

  openWriter(key: string, options: WriteOptions = {}): ObjectWriter {
    const finalPath = this.pathOf(key)
    const tempPath = path.join(this.root, '.tmp', randomUUID())
    let file: WriteStream | undefined
    const opened = mkdir(path.dirname(tempPath), { recursive: true }).then(() => {
      file = createWriteStream(tempPath, { flags: 'wx' })
      return new Promise<WriteStream>((resolve, reject) => {
        file!.once('open', () => resolve(file!))
        file!.once('error', reject)
      })
    })
    opened.catch(() => undefined)
    const sink: ByteSink = {
      write: async chunk => {
        const stream = await opened
        await new Promise<void>((resolve, reject) => stream.write(chunk, error => (error ? reject(error) : resolve())))
      },
      finish: async () => {
        const stream = await opened
        await new Promise<void>((resolve, reject) => {
          stream.once('error', reject)
          stream.end(resolve)
        })
        await mkdir(path.dirname(finalPath), { recursive: true })
        await rename(tempPath, finalPath)
        const meta: SidecarMeta = { contentType: options.contentType, contentDisposition: options.contentDisposition }
        const metaPath = this.metaPathOf(key)
        await mkdir(path.dirname(metaPath), { recursive: true })
        await writeFile(metaPath, JSON.stringify(meta))
      },
      abort: async () => {
        try {
          ;(await opened).destroy()
        } catch {
          /* 临时文件都没建成，无需清理 */
        }
        await unlink(tempPath).catch(() => undefined)
      },
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

  async openRead(key: string): Promise<Readable> {
    const file = this.pathOf(key)
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) throw objectNotFound()
    return createReadStream(file)
  }

  async stat(key: string): Promise<ObjectMeta | null> {
    const info = await stat(this.pathOf(key)).catch(() => null)
    if (!info?.isFile()) return null
    const meta = await this.readSidecar(key)
    return { key, sizeBytes: info.size, contentType: meta.contentType, lastModified: info.mtime }
  }

  /** 下载时要带的头（内容类型、下载文件名）；给 API 的本地下载接口用。 */
  async readSidecar(key: string): Promise<SidecarMeta> {
    try {
      return JSON.parse(await readFile(this.metaPathOf(key), 'utf8')) as SidecarMeta
    } catch {
      return {}
    }
  }

  async delete(key: string): Promise<void> {
    await unlink(this.pathOf(key)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    await unlink(this.metaPathOf(key)).catch(() => undefined)
  }

  private url(payload: LocalTokenPayload): string {
    return `${this.options.publicBaseUrl.replace(/\/+$/, '')}/${signLocalToken(this.options.signingKey, payload)}`
  }

  async signDownload(key: string, options: SignDownloadOptions): Promise<SignedUrl> {
    assertStorageKey(key)
    const exp = Math.floor(this.now().getTime() / 1000) + options.ttlSeconds
    return { url: this.url({ k: key, op: 'GET', exp }), method: 'GET', headers: {}, expiresAt: new Date(exp * 1000) }
  }

  async signUpload(key: string, options: SignUploadOptions): Promise<SignedUrl> {
    assertStorageKey(key)
    const exp = Math.floor(this.now().getTime() / 1000) + options.ttlSeconds
    return {
      url: this.url({ k: key, op: 'PUT', exp, ct: options.contentType, max: options.maxBytes }),
      method: 'PUT',
      headers: { 'Content-Type': options.contentType },
      expiresAt: new Date(exp * 1000),
    }
  }

  /** 校验链接令牌（API 的本地读写接口使用）。 */
  verifyToken(token: string): LocalTokenPayload {
    return verifyLocalToken(this.options.signingKey, token, this.now())
  }
}
