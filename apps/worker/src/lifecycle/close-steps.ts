import type { PrismaClient } from '@prisma/client'
import { TenantObjectStore, type ObjectStorage } from '@nova/storage'
import { countRows, deleteBatch, isForeignKeyViolation, tenantTables } from './close-sql'

export const DELETE_BATCH_SIZE = 5000
/** 注销后仍然保留的表：审计（合规，保留 730 天后由定时任务清理）、生命周期事件（含删除证明）、配额（约定记录）。 */
export const KEPT_TABLES = new Set(['AuditEvent', 'TenantLifecycleEvent', 'TenantQuota'])

export interface CloseDeps {
  db: PrismaClient
  storage: ObjectStorage
  logger: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void }
  now?: () => Date
}

/** 撤销授权：本地把连接标记为已撤销。亚马逊侧的授权需要卖家在亚马逊后台自行撤销，这里如实记录，不假装已经撤销。 */
export async function revokeAuthorizations(deps: CloseDeps, tenantId: string) {
  const result = await deps.db.platformConnection.updateMany({ where: { tenantId, state: { not: 'REVOKED' } }, data: { state: 'REVOKED' } })
  return { revokedLocally: result.count, amazonSide: '亚马逊侧授权需卖家在亚马逊卖家平台与广告控制台自行撤销' }
}

/** 删除令牌：连接上的加密刷新令牌清空；同时让企业成员的登录会话失效。 */
export async function deleteTokens(deps: CloseDeps, tenantId: string) {
  const tokens = await deps.db.platformConnection.updateMany({ where: { tenantId }, data: { encryptedRefreshToken: null, refreshTokenUpdatedAt: null } })
  const members = await deps.db.membership.findMany({ where: { tenantId }, select: { userId: true } })
  const sessions = await deps.db.session.updateMany({ where: { userId: { in: members.map(member => member.userId) }, revokedAt: null }, data: { revokedAt: (deps.now ?? (() => new Date()))() } })
  return { connectionsCleared: tokens.count, sessionsRevoked: sessions.count }
}

/** 删除买家个人信息：订单上的加密个人信息与到期时间置空（订单本身的经营数据在“删除业务数据”步骤按保留策略处理）。 */
export async function deleteBuyerInformation(deps: CloseDeps, tenantId: string) {
  const result = await deps.db.order.updateMany({ where: { tenantId, OR: [{ piiCiphertext: { not: null } }, { piiExpiresAt: { not: null } }] }, data: { piiCiphertext: null, piiExpiresAt: null } })
  // 退货买家备注（P6-14）：密文、保留期、类别一并清空；升级前遗留的明文列也清空
  const comments = await deps.db.fbaReturnCase.updateMany({
    where: { tenantId, OR: [{ customerCommentsCipher: { not: null } }, { customerCommentsExpiresAt: { not: null } }, { customerComments: { not: null } }] },
    data: { customerCommentsCipher: null, customerCommentsExpiresAt: null, customerCommentsKinds: null, customerComments: null },
  })
  return { ordersCleared: result.count, returnCommentsCleared: comments.count }
}

/** 删除原始报告文件：按留存记录逐个删除对象存储里的文件。 */
async function deleteFiles(deps: CloseDeps, tenantId: string): Promise<number> {
  const store = new TenantObjectStore(deps.storage, tenantId)
  let files = 0
  for (;;) {
    const batch = await deps.db.rawReportFile.findMany({ where: { tenantId }, select: { id: true, objectKey: true }, orderBy: { id: 'asc' }, take: 500 })
    if (!batch.length) return files
    for (const file of batch) await store.remove(file.objectKey)
    files += batch.length
    await deps.db.rawReportFile.deleteMany({ where: { id: { in: batch.map(file => file.id) }, tenantId } })
  }
}

export interface DeleteDataResult {
  tables: Record<string, number>
  files: number
  usersRemoved: number
  userIds: string[]
}

/**
 * 删除业务数据与文件：先删文件，再逐表分批删除（外键约束阻止时先放过、下一轮再删，直到全部删完），最后校验每张表确实为空。
 * 成员账号在不属于其他企业时一并删除。保留的表见 KEPT_TABLES。步骤幂等：重复执行只会处理剩余的数据。
 */
export async function deleteBusinessData(deps: CloseDeps, tenantId: string, previous?: { tables?: Record<string, number>; userIds?: string[] }): Promise<DeleteDataResult> {
  const files = await deleteFiles(deps, tenantId)
  const tables = (await tenantTables(deps.db)).filter(name => !KEPT_TABLES.has(name))
  const counts: Record<string, number> = { ...(previous?.tables ?? {}) }
  // 记录首次执行时各表的行数（重试时沿用，证明里的数字是“删除前的行数”）
  const userIds = previous?.userIds ?? (await deps.db.membership.findMany({ where: { tenantId }, select: { userId: true } })).map(member => member.userId)
  for (const table of tables) if (!(table in counts)) counts[table] = await countRows(deps.db, table, tenantId)

  let pending = [...tables]
  while (pending.length) {
    const blocked: string[] = []
    let progressed = false
    for (const table of pending) {
      try {
        for (;;) {
          const deleted = await deleteBatch(deps.db, table, tenantId, DELETE_BATCH_SIZE)
          if (deleted > 0) progressed = true
          if (deleted === 0) break
        }
      } catch (error) {
        if (!isForeignKeyViolation(error)) throw error
        blocked.push(table)
      }
    }
    if (blocked.length && !progressed) throw new Error(`外键约束无法解除，剩余的表：${blocked.join('、')}`)
    pending = blocked
  }

  const leftovers: string[] = []
  for (const table of tables) if ((await countRows(deps.db, table, tenantId)) > 0) leftovers.push(table)
  if (leftovers.length) throw new Error(`删除后仍有数据：${leftovers.join('、')}`)

  // 只属于本企业的成员账号一并删除（账号级的登录会话、多因素因子随账号级联删除）
  const removed = userIds.length ? await deps.db.user.deleteMany({ where: { id: { in: userIds }, memberships: { none: {} } } }) : { count: 0 }
  return { tables: counts, files, usersRemoved: removed.count, userIds }
}
