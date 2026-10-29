import { Injectable } from '@nestjs/common'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { appError } from '../../platform/http'
import { ObjectStorageService, storageAppError } from '../../platform/storage/object-storage.service'

// 本地磁盘驱动的签名链接兑现（P1-23）：服务端签发的短时令牌就是凭证，不需要登录态；
// 令牌绑定了“哪个文件、读还是写、何时失效、上传的类型与大小上限”，不能用于别的文件或别的动作。
// 阿里云对象存储的链接由对象存储自己兑现，不经过这里。

export interface LocalDownload {
  stream: Readable
  headers: Record<string, string>
}

const baseType = (value: string | undefined) => (value ?? '').split(';')[0].trim().toLowerCase()

@Injectable()
export class StorageService {
  constructor(private readonly objects: ObjectStorageService) {}

  /** 当前驱动不是本地磁盘时，这组接口不存在（对外就是“接口不存在”）。 */
  private local() {
    const local = this.objects.local()
    if (!local) throw appError('ROUTE_NOT_FOUND', '请求的接口不存在')
    return local
  }

  async download(token: string): Promise<LocalDownload> {
    const local = this.local()
    try {
      const payload = local.verifyToken(token)
      if (payload.op !== 'GET') throw appError('STORAGE_LINK_INVALID', '文件链接无效')
      const meta = await local.stat(payload.k)
      if (!meta) throw appError('RESOURCE_NOT_FOUND', '文件不存在')
      const sidecar = await local.readSidecar(payload.k)
      const stream = await local.openRead(payload.k)
      return {
        stream,
        headers: {
          'Content-Type': sidecar.contentType ?? 'application/octet-stream',
          'Content-Length': String(meta.sizeBytes),
          // 文件来自用户或亚马逊，一律当作下载，不让浏览器在我们的域名下直接渲染
          'Content-Disposition': sidecar.contentDisposition ?? 'attachment',
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      }
    } catch (error) {
      throw storageAppError(error)
    }
  }

  /** 直传：内容类型必须与令牌里签进去的一致，大小受令牌里的上限约束（边接收边计数，超限立即中止并丢弃）。 */
  async upload(token: string, body: Readable, headers: { contentType?: string; contentLength?: string }): Promise<{ sizeBytes: number }> {
    const local = this.local()
    try {
      const payload = local.verifyToken(token)
      if (payload.op !== 'PUT' || !payload.ct || !payload.max) throw appError('STORAGE_LINK_INVALID', '文件链接无效')
      if (baseType(headers.contentType) !== baseType(payload.ct)) throw appError('FILE_TYPE_NOT_ALLOWED', '文件类型与上传凭证不符')
      const declared = Number(headers.contentLength)
      if (Number.isFinite(declared) && declared > payload.max) throw appError('FILE_TOO_LARGE', '文件超过大小上限')
      const writer = local.openWriter(payload.k, { contentType: payload.ct, maxBytes: payload.max })
      try {
        await pipeline(body, writer.stream)
        const stored = await writer.done
        return { sizeBytes: stored.sizeBytes }
      } catch (error) {
        await writer.abort()
        throw error
      }
    } catch (error) {
      throw storageAppError(error)
    }
  }
}
