import { REFRESH_SETTING_KEY, RETENTION_SETTING_KEY, refreshPolicyOf, retentionPolicyOf, type RefreshPolicy, type RetentionPolicy } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'

// 企业设置里的数据保留与刷新策略（P5-10）：worker 在写入文件、写入订单、排定时同步时按企业读取。
// 没有记录（或存的值不合格式）一律按系统默认处理，不让坏数据影响清理与同步。

type Db = Pick<PrismaClient, 'tenantSetting'>

const rowOf = (db: Db, tenantId: string, key: string) => db.tenantSetting.findFirst({ where: { tenantId, sellerAccountId: null, key }, select: { valueJson: true } })

/** 数据保留策略；没有设置过返回 null（调用方沿用部署默认，例如 RAW_FILE_RETENTION_DAYS）。 */
export async function loadRetentionPolicy(db: Db, tenantId: string): Promise<RetentionPolicy | null> {
  const row = await rowOf(db, tenantId, RETENTION_SETTING_KEY)
  return row ? retentionPolicyOf(row.valueJson) : null
}

export async function loadRefreshPolicy(db: Db, tenantId: string): Promise<RefreshPolicy> {
  return refreshPolicyOf((await rowOf(db, tenantId, REFRESH_SETTING_KEY))?.valueJson)
}
