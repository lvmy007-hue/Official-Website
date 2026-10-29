import { CryptoError } from './errors.js'
import type { KmsClient, MasterKeyProvider } from './types.js'

// 云密钥管理接入点（预留）：主密钥留在云端，本进程永远拿不到主密钥本身，只把数据密钥交给云端包裹/解开。
// 具体客户端（如阿里云 KMS）随部署专项提供，实现 KmsClient 即可，其余代码不变。
export class KmsMasterKeyProvider implements MasterKeyProvider {
  readonly name = 'kms' as const

  constructor(
    private readonly client: KmsClient,
    readonly activeId: string,
  ) {}

  async wrap(dataKey: Buffer, context: string): Promise<{ wrapped: string; masterKeyId: string }> {
    try {
      const { ciphertext, keyId } = await this.client.encrypt(dataKey, context)
      return { wrapped: ciphertext, masterKeyId: keyId || this.activeId }
    } catch (error) {
      throw new CryptoError('KMS_UNAVAILABLE', '云密钥管理服务调用失败（包裹数据密钥）', { cause: error })
    }
  }

  async unwrap(wrapped: string, masterKeyId: string, context: string): Promise<Buffer> {
    try {
      return await this.client.decrypt(wrapped, masterKeyId, context)
    } catch (error) {
      throw new CryptoError('KMS_UNAVAILABLE', '云密钥管理服务调用失败（解开数据密钥）', { cause: error })
    }
  }
}
