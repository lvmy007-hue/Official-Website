import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import { objectKeyBelongsToTenant, tenantObjectKey } from '@nova/tenancy'
import { StorageError, objectNotFound } from './errors.js'
import { safeFileName } from './key.js'
import type { ObjectMeta, ObjectStorage, ObjectWriter, SignedUrl, StoredObject, WriteOptions } from './types.js'

// 租户视角的对象存储（12.8 第 6 条）：
// - 路径由本类生成：tenants/<租户>/<数据域>/<年>/<月>/<日>/<随机编号>-<净化后的文件名>，文件名里带随机编号，别人无法猜出；
// - 凡是用路径访问（读取、签名、删除、确认上传），先校验路径属于本租户；不属于一律按“不存在”处理，不区分原因；
// - 不提供列出文件的方法，也就无法枚举。

/** 直传不接受的内容类型：会被接口自己的 JSON 解析器截获，且没有“文件”的意义。 */
const FORBIDDEN_UPLOAD_TYPES = /^(application\/json|application\/x-www-form-urlencoded|multipart\/)/i
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 300
export const MAX_SIGNED_URL_TTL_SECONDS = 900
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024

export interface FilePlacement {
  /** 数据域，如 reports、exports、raw-files、attachments。 */
  domain: string
  /** 原始文件名（会被净化；中文等非 ASCII 字符会被替换，原名应另存数据库）。 */
  name: string
  /** 业务日期，默认当前时间；决定年/月/日目录。 */
  date?: Date
}

export interface SignedUploadTicket extends SignedUrl {
  /** 服务端生成的完整路径：上传完成后用它确认并登记。 */
  key: string
  maxBytes: number
}

export class TenantObjectStore {
  constructor(
    private readonly storage: ObjectStorage,
    readonly tenantId: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    // 租户编号格式不合法时，这里就会抛错
    tenantObjectKey({ tenantId, domain: 'check', date: new Date(0), name: 'check' })
  }

  /** 生成一个新的、不可猜测的路径。 */
  newKey(placement: FilePlacement): string {
    const name = `${randomUUID()}-${safeFileName(placement.name)}`
    return tenantObjectKey({ tenantId: this.tenantId, domain: placement.domain, date: placement.date ?? this.now(), name })
  }

  private owns(key: string): boolean {
    try {
      return objectKeyBelongsToTenant(key, this.tenantId)
    } catch {
      return false
    }
  }

  /** 校验路径属于本租户；不属于抛“不存在”。 */
  private own(key: string): string {
    if (!this.owns(key)) throw objectNotFound()
    return key
  }

  openWriter(placement: FilePlacement, options?: WriteOptions): { key: string; writer: ObjectWriter } {
    const key = this.newKey(placement)
    return { key, writer: this.storage.openWriter(key, options) }
  }

  async put(placement: FilePlacement, body: Buffer | Readable, options?: WriteOptions): Promise<StoredObject> {
    return this.storage.put(this.newKey(placement), body, options)
  }

  async read(key: string): Promise<Readable> {
    return this.storage.openRead(this.own(key))
  }

  /** 查询文件信息；不存在与不属于本租户的表现完全一致（都返回 null）。 */
  async stat(key: string): Promise<ObjectMeta | null> {
    return this.owns(key) ? this.storage.stat(key) : null
  }

  /** 删除；不存在与不属于本租户的表现完全一致（都静默返回），别人的文件不会被动。 */
  async remove(key: string): Promise<void> {
    if (this.owns(key)) await this.storage.delete(key)
  }

  private ttl(seconds: number | undefined): number {
    const value = seconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS
    if (!Number.isFinite(value) || value <= 0) throw new StorageError('STORAGE_CONFIG_INVALID', '链接有效期必须大于 0')
    return Math.min(Math.floor(value), MAX_SIGNED_URL_TTL_SECONDS)
  }

  /** 下载链接：仅对本租户已存在的文件签发，有效期默认 5 分钟、最长 15 分钟。 */
  async signDownload(key: string, ttlSeconds?: number): Promise<SignedUrl> {
    this.own(key)
    if (!(await this.storage.stat(key))) throw objectNotFound()
    return this.storage.signDownload(key, { ttlSeconds: this.ttl(ttlSeconds) })
  }

  /** 直传凭证：路径由服务端生成；链接只对指定的内容类型有效。 */
  async signUpload(placement: FilePlacement, options: { contentType: string; maxBytes?: number; ttlSeconds?: number }): Promise<SignedUploadTicket> {
    if (!options.contentType || FORBIDDEN_UPLOAD_TYPES.test(options.contentType)) throw new StorageError('STORAGE_CONTENT_TYPE_NOT_ALLOWED', '不支持的文件类型')
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES
    if (!(maxBytes > 0)) throw new StorageError('STORAGE_CONFIG_INVALID', '上传大小上限必须大于 0')
    const key = this.newKey(placement)
    const signed = await this.storage.signUpload(key, { ttlSeconds: this.ttl(options.ttlSeconds), contentType: options.contentType, maxBytes })
    return { ...signed, key, maxBytes }
  }

  /**
   * 确认直传完成：核对文件存在且不超过上限；超限的立即删除并报错。
   * （云存储的签名链接无法在接收时限制大小，所以在这里复核；未确认的上传由存储桶生命周期规则清理。）
   */
  async confirmUpload(key: string, maxBytes: number): Promise<ObjectMeta> {
    this.own(key)
    const meta = await this.storage.stat(key)
    if (!meta) throw objectNotFound()
    if (meta.sizeBytes > maxBytes) {
      await this.storage.delete(key)
      throw new StorageError('STORAGE_OBJECT_TOO_LARGE', `文件超过 ${maxBytes} 字节上限，已丢弃`)
    }
    return meta
  }
}
