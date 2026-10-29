export type StorageErrorCode =
  | 'OBJECT_NOT_FOUND'
  | 'STORAGE_KEY_INVALID'
  | 'STORAGE_TOKEN_INVALID'
  | 'STORAGE_TOKEN_EXPIRED'
  | 'STORAGE_OBJECT_TOO_LARGE'
  | 'STORAGE_CONTENT_TYPE_NOT_ALLOWED'
  | 'STORAGE_CONFIG_INVALID'
  | 'STORAGE_UNAVAILABLE'

/** 存储层的统一错误：调用方按 code 区分处理；不属于当前租户的对象一律是 OBJECT_NOT_FOUND，不得区分“不存在”与“无权访问”。 */
export class StorageError extends Error {
  constructor(
    public readonly code: StorageErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'StorageError'
  }
}

export const objectNotFound = () => new StorageError('OBJECT_NOT_FOUND', '文件不存在')
