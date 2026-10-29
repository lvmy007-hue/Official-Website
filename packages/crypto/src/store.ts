import { CryptoError } from './errors.js'
import type { DataKeyRecord, KeyStore, NewDataKey } from './types.js'

// 数据库实现：传入 Prisma 客户端的 dataEncryptionKey 委托（必须是系统连接——该表不属于任何租户，租户连接无权访问）。
// 刻意用结构类型，避免本包依赖 Prisma。
interface KeyDelegate {
  findMany(args: { orderBy: Array<Record<string, 'asc' | 'desc'>> }): Promise<DataKeyRecord[]>
  create(args: { data: NewDataKey & { status: 'ACTIVE' } }): Promise<DataKeyRecord>
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>
}

export function prismaKeyStore(delegate: unknown): KeyStore {
  const keys = delegate as KeyDelegate
  return {
    list: () => keys.findMany({ orderBy: [{ purpose: 'asc' }, { version: 'asc' }] }),
    async insert(key) {
      try {
        return await keys.create({ data: { ...key, status: 'ACTIVE' } })
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') throw new CryptoError('KEY_STORE_CONFLICT', `数据密钥版本已存在：${key.purpose} v${key.version}`, { cause: error })
        throw error
      }
    },
    async retireBefore(purpose, keepVersion) {
      await keys.updateMany({ where: { purpose, status: 'ACTIVE', version: { lt: keepVersion } }, data: { status: 'RETIRED', retiredAt: new Date() } })
    },
    async updateWrap(id, wrappedKey, masterKeyId) {
      await keys.update({ where: { id }, data: { wrappedKey, masterKeyId } })
    },
  }
}

/** 内存实现：仅用于测试与演练。 */
export class MemoryKeyStore implements KeyStore {
  private rows: DataKeyRecord[] = []
  private sequence = 0

  async list() {
    return this.rows.map(row => ({ ...row })).sort((a, b) => a.purpose.localeCompare(b.purpose) || a.version - b.version)
  }

  async insert(key: NewDataKey) {
    if (this.rows.some(row => row.purpose === key.purpose && row.version === key.version)) throw new CryptoError('KEY_STORE_CONFLICT', `数据密钥版本已存在：${key.purpose} v${key.version}`)
    const row: DataKeyRecord = { ...key, id: `key-${++this.sequence}`, status: 'ACTIVE', createdAt: new Date(), retiredAt: null }
    this.rows.push(row)
    return { ...row }
  }

  async retireBefore(purpose: string, keepVersion: number) {
    for (const row of this.rows)
      if (row.purpose === purpose && row.status === 'ACTIVE' && row.version < keepVersion) {
        row.status = 'RETIRED'
        row.retiredAt = new Date()
      }
  }

  async updateWrap(id: string, wrappedKey: string, masterKeyId: string) {
    const row = this.rows.find(item => item.id === id)
    if (row) {
      row.wrappedKey = wrappedKey
      row.masterKeyId = masterKeyId
    }
  }
}
