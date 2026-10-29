import { randomBytes } from 'node:crypto'
import { StorageError } from './errors.js'
import { LocalDiskStorage } from './local.js'
import { deriveSigningKey } from './local-token.js'
import { DEFAULT_PART_SIZE, OssStorage } from './oss.js'
import type { ObjectStorage } from './types.js'

// 存储配置（环境变量）：
//   STORAGE_DRIVER=local|oss            默认 local
// local：STORAGE_LOCAL_DIR（默认 ./storage-data）、STORAGE_PUBLIC_BASE_URL（签名链接前缀，默认 http://127.0.0.1:4000/api/v1/storage/local）、
//        STORAGE_SIGNING_KEY（至少 32 个字符；生产环境必须显式设置，其他环境缺省时由 JWT_SECRET 派生）
// oss：OSS_ENDPOINT（如 oss-cn-hongkong.aliyuncs.com）、OSS_BUCKET、OSS_ACCESS_KEY_ID、OSS_ACCESS_KEY_SECRET、OSS_PART_SIZE_MB（默认 8）

type Env = Record<string, string | undefined>

export function storageDriverFrom(env: Env): 'local' | 'oss' {
  const value = (env.STORAGE_DRIVER ?? 'local').trim().toLowerCase()
  if (value !== 'local' && value !== 'oss') throw new StorageError('STORAGE_CONFIG_INVALID', 'STORAGE_DRIVER 只能是 local 或 oss')
  return value
}

export interface CreateStorageOptions {
  /**
   * 本进程是否需要签发或校验链接。接口服务需要（默认）；后台任务进程只写入文件，不需要签名密钥，
   * 传 false 时缺少密钥也能创建（本进程内随机一把，签出的链接别的进程无法验证，也就不会被误用）。
   */
  signs?: boolean
}

export function createObjectStorage(env: Env = process.env, options: CreateStorageOptions = {}): ObjectStorage {
  const driver = storageDriverFrom(env)
  if (driver === 'oss') {
    const missing = ['OSS_ENDPOINT', 'OSS_BUCKET', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET'].filter(name => !env[name]?.trim())
    if (missing.length > 0) throw new StorageError('STORAGE_CONFIG_INVALID', `对象存储配置缺少：${missing.join('、')}`)
    const partMb = Number(env.OSS_PART_SIZE_MB)
    return new OssStorage({
      endpoint: env.OSS_ENDPOINT!.trim(),
      bucket: env.OSS_BUCKET!.trim(),
      accessKeyId: env.OSS_ACCESS_KEY_ID!.trim(),
      accessKeySecret: env.OSS_ACCESS_KEY_SECRET!.trim(),
      partSizeBytes: partMb > 0 ? Math.floor(partMb * 1024 * 1024) : DEFAULT_PART_SIZE,
    })
  }
  const production = env.APP_MODE === 'production'
  const secret = env.STORAGE_SIGNING_KEY?.trim() || (production ? '' : (env.JWT_SECRET?.trim() ?? ''))
  if (secret.length < 32 && options.signs === false) {
    return new LocalDiskStorage({ rootDir: env.STORAGE_LOCAL_DIR?.trim() || './storage-data', signingKey: randomBytes(32), publicBaseUrl: 'http://invalid.local' })
  }
  if (secret.length < 32)
    throw new StorageError(
      'STORAGE_CONFIG_INVALID',
      production ? '本地存储在生产环境必须设置至少 32 个字符的 STORAGE_SIGNING_KEY' : '请设置 STORAGE_SIGNING_KEY（至少 32 个字符），或提供 JWT_SECRET 以便派生',
    )
  return new LocalDiskStorage({
    rootDir: env.STORAGE_LOCAL_DIR?.trim() || './storage-data',
    signingKey: deriveSigningKey(secret),
    publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL?.trim() || 'http://127.0.0.1:4000/api/v1/storage/local',
  })
}
