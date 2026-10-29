// 密钥分层（P1-24，03 章 3.1、11 章 11.2、12 章 12.9 第 10 条）：
//   主密钥（环境变量或云密钥管理服务，不进数据库）→ 加密“数据密钥”（按用途一把，带版本，密文存数据库）→ 加密具体机密。
// 轮换分两层：数据密钥轮换（新版本接手新写入，旧版本只用于解密，再由重加密任务把旧密文迁到新版本）；
// 主密钥轮换（只需要用新主密钥重新包裹数据密钥，不动任何业务密文）。

/** 机密的用途：不同用途用不同数据密钥，密文还绑定用途，拿 A 用途的密文去 B 用途解密一定失败。 */
export const SECRET_PURPOSES = ['amazon-token', 'buyer-pii', 'mfa'] as const
export type SecretPurpose = (typeof SECRET_PURPOSES)[number]

export type KeyStatus = 'ACTIVE' | 'RETIRED'

export interface DataKeyRecord {
  id: string
  purpose: string
  version: number
  /** 被主密钥包裹后的数据密钥（iv.tag.密文，或云密钥管理服务返回的密文）。 */
  wrappedKey: string
  /** 包裹它的主密钥编号，主密钥轮换后据此判断是否需要重新包裹。 */
  masterKeyId: string
  status: KeyStatus
  createdAt: Date
  retiredAt: Date | null
}

export interface NewDataKey {
  purpose: string
  version: number
  wrappedKey: string
  masterKeyId: string
}

/** 数据密钥的存放处。数据库实现见 store.ts；该表不属于任何租户，只允许系统连接访问。 */
export interface KeyStore {
  list(): Promise<DataKeyRecord[]>
  /** 新增一个 ACTIVE 版本；同一用途的同一版本已存在则抛 KEY_STORE_CONFLICT。 */
  insert(key: NewDataKey): Promise<DataKeyRecord>
  /** 把该用途下版本号小于 keepVersion 的 ACTIVE 记录标记为 RETIRED（仍可解密）。 */
  retireBefore(purpose: string, keepVersion: number): Promise<void>
  /** 主密钥轮换：更新包裹后的数据密钥与主密钥编号。 */
  updateWrap(id: string, wrappedKey: string, masterKeyId: string): Promise<void>
}

/** 主密钥提供者：环境变量实现与云密钥管理服务实现可互换。 */
export interface MasterKeyProvider {
  readonly name: 'env' | 'kms'
  /** 新包裹操作使用的主密钥编号。 */
  readonly activeId: string
  /** context 会参与认证（不同数据密钥的包裹不能互换）。 */
  wrap(dataKey: Buffer, context: string): Promise<{ wrapped: string; masterKeyId: string }>
  unwrap(wrapped: string, masterKeyId: string, context: string): Promise<Buffer>
}

/** 云密钥管理服务（阿里云 KMS 等）的最小接口；具体客户端随部署专项接入，这里只固定调用形状。 */
export interface KmsClient {
  encrypt(plaintext: Buffer, context: string): Promise<{ ciphertext: string; keyId: string }>
  decrypt(ciphertext: string, keyId: string, context: string): Promise<Buffer>
}
