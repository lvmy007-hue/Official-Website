import { Injectable } from '@nestjs/common'
import { DEFAULT_MAX_UPLOAD_BYTES, LocalDiskStorage, StorageError, TenantObjectStore, createObjectStorage, type ObjectStorage } from '@nova/storage'
import { appError } from '../http'

// 对象存储的接入点（P1-23）：接口服务里所有文件相关的代码都从这里拿“租户视角”的存储，
// 不直接使用底层适配器；底层适配器按环境变量选择本地磁盘或阿里云对象存储（见 @nova/storage 的 config）。

/** 存储层错误 → 统一错误码。不属于当前租户的文件与不存在的文件对外是同一个错误，不区分原因。 */
export function storageAppError(error: unknown): unknown {
  if (!(error instanceof StorageError)) return error
  switch (error.code) {
    case 'OBJECT_NOT_FOUND':
    case 'STORAGE_KEY_INVALID':
      return appError('RESOURCE_NOT_FOUND', '文件不存在')
    case 'STORAGE_TOKEN_INVALID':
      return appError('STORAGE_LINK_INVALID', '文件链接无效')
    case 'STORAGE_TOKEN_EXPIRED':
      return appError('STORAGE_LINK_EXPIRED', '文件链接已过期，请重新获取')
    case 'STORAGE_OBJECT_TOO_LARGE':
      return appError('FILE_TOO_LARGE', '文件超过大小上限')
    case 'STORAGE_CONTENT_TYPE_NOT_ALLOWED':
      return appError('FILE_TYPE_NOT_ALLOWED', '不支持的文件类型')
    case 'STORAGE_CONFIG_INVALID':
      return appError('STORAGE_NOT_CONFIGURED', '文件存储尚未配置')
    default:
      return appError('STORAGE_UNAVAILABLE', '文件存储暂时不可用，请稍后重试')
  }
}

@Injectable()
export class ObjectStorageService {
  private cached: ObjectStorage | undefined

  /** 底层适配器（懒创建：没配置存储的环境，只有真正用到文件功能时才报错）。业务代码不要直接用，用 forTenant。 */
  get storage(): ObjectStorage {
    try {
      this.cached ??= createObjectStorage(process.env)
      return this.cached
    } catch (error) {
      throw storageAppError(error)
    }
  }

  /** 某个租户的文件视角：路径由它生成，所有按路径的访问先校验归属。 */
  forTenant(tenantId: string): TenantObjectStore {
    return new TenantObjectStore(this.storage, tenantId)
  }

  /** 当前驱动是本地磁盘时返回它（本地驱动的签名链接由接口服务自己兑现）；否则 null。 */
  local(): LocalDiskStorage | null {
    const storage = this.storage
    return storage instanceof LocalDiskStorage ? storage : null
  }

  /** 单个直传文件的大小上限（STORAGE_MAX_UPLOAD_MB，默认 50MB）。 */
  maxUploadBytes(env: Record<string, string | undefined> = process.env): number {
    const megabytes = Number(env.STORAGE_MAX_UPLOAD_MB)
    return megabytes > 0 ? Math.floor(megabytes * 1024 * 1024) : DEFAULT_MAX_UPLOAD_BYTES
  }

  /** 启动时调用：尽早发现存储配置错误（生产环境缺少配置时直接拒绝启动）。 */
  validate(): void {
    void this.storage
  }
}
