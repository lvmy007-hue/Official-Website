import { Keyring, SECRET_PURPOSES, createMasterKeyProvider, prismaKeyStore } from '@nova/crypto'
import type { PrismaClient } from '@prisma/client'

// 后台任务进程的应用层加密入口（P1-24）。后台任务是唯一会解密亚马逊刷新令牌的地方（拿它向亚马逊换访问令牌），
// 也是唯一写入买家个人信息的地方；多因素认证密钥它既不加密也不解密。
// 底层是 @nova/crypto 密钥环，数据密钥存放在系统连接的 DataEncryptionKey 表。

/** 解密亚马逊刷新令牌的能力：连接器客户端只依赖这个最小接口，测试里用替身即可。 */
export interface TokenOpener {
  openAmazonToken(ciphertext: string): Promise<string>
}

export interface PiiSealer {
  sealBuyerPii(plaintext: string): Promise<string>
}

export class WorkerSecrets implements TokenOpener, PiiSealer {
  constructor(private readonly keyring: Keyring) {}

  openAmazonToken(ciphertext: string): Promise<string> {
    return this.keyring.open('amazon-token', ciphertext)
  }

  async sealBuyerPii(plaintext: string): Promise<string> {
    return (await this.keyring.seal('buyer-pii', plaintext)).ciphertext
  }

  /** 启动前调用：确保数据密钥齐全、主密钥配置正确；配置错误在启动阶段暴露。 */
  prepare(): Promise<void> {
    return this.keyring.prepare(SECRET_PURPOSES)
  }
}

/** 创建密钥环（systemPrisma 必须是系统连接）。主密钥来自环境变量，或随部署专项接入的云密钥管理。 */
export function createWorkerKeyring(systemPrisma: PrismaClient, env: Record<string, string | undefined> = process.env): Keyring {
  const { provider, legacyRoot } = createMasterKeyProvider(env)
  return new Keyring({ store: prismaKeyStore((systemPrisma as unknown as { dataEncryptionKey: unknown }).dataEncryptionKey), master: provider, legacyRoot })
}
