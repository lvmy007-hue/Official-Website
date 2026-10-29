import { Injectable } from '@nestjs/common'
import { CryptoError, Keyring, SECRET_PURPOSES, createMasterKeyProvider, prismaKeyStore, type KeyStore } from '@nova/crypto'
import { AppError, appError } from '../http'
import { SystemPrismaService } from '../prisma.service'

// 接口服务的应用层加密入口（P1-24）。底层是 @nova/crypto 的密钥环：主密钥包裹数据密钥、数据密钥加密机密，带版本与轮换。
//
// 接口服务的权限被刻意收窄：
//   - 亚马逊刷新令牌：只能“加密保存”，没有任何解密入口（解密只发生在后台任务进程里，发给亚马逊换访问令牌）；
//   - 买家个人信息：接口服务不加密（只有后台任务写入）；只在订单“查看买家信息”流程里解密（P2b-01，见 openBuyerPii），
//     那条流程要求 field.buyer 权限、填写理由并先写审计；
//   - 多因素认证密钥：可加密、可解密（校验验证码需要）。
// 所以即使接口服务被攻破，也拿不到亚马逊令牌与买家信息的明文。该约束由本类的方法集合与架构测试共同保证。
@Injectable()
export class SecretBoxService {
  private keyring: Keyring | undefined

  constructor(private readonly system: SystemPrismaService) {}

  /** 数据密钥的存放处：系统连接上的 DataEncryptionKey 表。测试里可替换为内存实现。 */
  protected keyStore(): KeyStore {
    return prismaKeyStore(this.system.dataEncryptionKey)
  }

  private ring(): Keyring {
    if (!this.keyring) {
      try {
        const { provider, legacyRoot } = createMasterKeyProvider(process.env)
        this.keyring = new Keyring({ store: this.keyStore(), master: provider, legacyRoot })
      } catch (error) {
        throw this.translate(error)
      }
    }
    return this.keyring
  }

  private translate(error: unknown): unknown {
    if (!(error instanceof CryptoError)) return error
    if (error.code === 'KEY_NOT_CONFIGURED') return new AppError(503, 'TOKEN_VAULT_NOT_CONFIGURED', error.message, false)
    if (error.code === 'KMS_UNAVAILABLE') return appError('KEY_SERVICE_UNAVAILABLE', '密钥服务暂时不可用，请稍后重试')
    return error
  }

  private async run<T>(work: (ring: Keyring) => Promise<T>): Promise<T> {
    try {
      return await work(this.ring())
    } catch (error) {
      throw this.translate(error)
    }
  }

  /** 加密亚马逊刷新令牌（只写不读）。 */
  async sealAmazonToken(plaintext: string): Promise<string> {
    return (await this.run(ring => ring.seal('amazon-token', plaintext))).ciphertext
  }

  async sealMfa(plaintext: string): Promise<{ ciphertext: string; keyVersion: number }> {
    return this.run(ring => ring.seal('mfa', plaintext))
  }

  async openMfa(ciphertext: string): Promise<string> {
    return this.run(ring => ring.open('mfa', ciphertext))
  }

  /**
   * 解密买家个人信息（P2b-01）：接口服务唯一的买家信息解密入口，只允许订单模块的“查看买家信息”流程调用
   * （填写理由、校验 field.buyer 权限、写审计之后）。明文只在本次响应里存在，不缓存、不写日志。
   * 亚马逊令牌仍然只能加密、不能解密；买家信息仍然只由后台任务加密写入。架构测试限制了调用方。
   */
  async openBuyerPii(ciphertext: string): Promise<string> {
    return this.run(ring => ring.open('buyer-pii', ciphertext))
  }

  /** 启动前调用：确保各用途都有数据密钥，并验证主密钥能解开已有数据密钥；配置错误在启动阶段暴露而不是等到第一次使用。 */
  async prepare(): Promise<void> {
    await this.run(ring => ring.prepare(SECRET_PURPOSES))
  }
}
