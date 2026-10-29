import { MemoryKeyStore, type KeyStore } from '@nova/crypto'
import { SecretBoxService } from '../platform/security/secret-box.service'

// 测试用：数据密钥放在内存里（真实的数据库存取由 crypto.db.test.ts 覆盖），主密钥仍读环境变量，行为与生产一致。
export class MemorySecretBox extends SecretBoxService {
  readonly memory = new MemoryKeyStore()

  constructor() {
    super(null as never)
  }

  protected override keyStore(): KeyStore {
    return this.memory
  }
}
