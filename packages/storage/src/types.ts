import type { Readable, Writable } from 'node:stream'

// 对象存储适配器接口（P1-23）。刻意不提供“列出目录/按前缀枚举”：调用方只能凭服务端生成的、带随机成分的完整路径访问，
// 业务代码不应直接使用本接口，而应通过 TenantObjectStore（按租户收口，所有访问先校验路径归属）。

export type StorageDriver = 'local' | 'oss'

/** 已落盘对象的摘要：大小与内容摘要在写入过程中边写边算，不需要二次读取。 */
export interface StoredObject {
  key: string
  sizeBytes: number
  /** 内容的 SHA-256（十六进制），用于去重与完整性核对。 */
  sha256: string
}

export interface ObjectMeta {
  key: string
  sizeBytes: number
  contentType?: string
  lastModified: Date
}

export interface WriteOptions {
  contentType?: string
  /** 下载时浏览器看到的文件名等信息（Content-Disposition 头），写入时设定。 */
  contentDisposition?: string
  /** 写入的字节上限；超过即中止并丢弃（不留半个文件）。 */
  maxBytes?: number
}

/** 流式写入句柄：把字节写进 stream，结束（end）后 done 才会完成；出错或 abort 则丢弃已写部分。 */
export interface ObjectWriter {
  stream: Writable
  done: Promise<StoredObject>
  abort(): Promise<void>
}

export interface SignedUrl {
  url: string
  method: 'GET' | 'PUT'
  /** 使用该链接时必须带上的请求头（例如直传时的内容类型）。 */
  headers: Record<string, string>
  expiresAt: Date
}

export interface SignDownloadOptions {
  ttlSeconds: number
}

export interface SignUploadOptions {
  ttlSeconds: number
  /** 直传时必须使用的内容类型；链接只对这个类型有效。 */
  contentType: string
  /** 上传大小上限。本地驱动在接收时强制；云存储在“确认上传”时复核并丢弃超限对象。 */
  maxBytes: number
}

export interface ObjectStorage {
  readonly driver: StorageDriver
  openWriter(key: string, options?: WriteOptions): ObjectWriter
  put(key: string, body: Buffer | Readable, options?: WriteOptions): Promise<StoredObject>
  /** 读取对象内容的流；不存在抛 StorageError('OBJECT_NOT_FOUND')。 */
  openRead(key: string): Promise<Readable>
  stat(key: string): Promise<ObjectMeta | null>
  delete(key: string): Promise<void>
  signDownload(key: string, options: SignDownloadOptions): Promise<SignedUrl>
  signUpload(key: string, options: SignUploadOptions): Promise<SignedUrl>
}
