export type CryptoErrorCode =
  | 'KEY_NOT_CONFIGURED' // 主密钥或云密钥管理未配置、格式不对
  | 'KEY_NOT_FOUND' // 密文引用的数据密钥版本或主密钥不存在
  | 'CIPHERTEXT_INVALID' // 密文格式不对
  | 'DECRYPT_FAILED' // 解密失败（密钥不对、用途不对或密文被改动）
  | 'KEY_STORE_CONFLICT' // 数据密钥版本已存在（并发创建）
  | 'KMS_UNAVAILABLE' // 云密钥管理服务调用失败

/** 加密层的统一错误。错误信息里永远不包含明文、密文与密钥内容。 */
export class CryptoError extends Error {
  constructor(
    public readonly code: CryptoErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'CryptoError'
  }
}
