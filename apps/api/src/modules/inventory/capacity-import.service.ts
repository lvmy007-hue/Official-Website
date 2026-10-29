import { Injectable } from '@nestjs/common'
import { StorageLimitImportBodySchema, storageTypeLabel, type StorageLimitImportResponse } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { assertStoreInScope, ContextService } from '../auth'
import { parseStorageLimits } from './capacity-import'
import { InventoryPolicyService } from './inventory-policy.service'

const PERMISSION = 'data.import'
const asDate = (date: string) => new Date(`${date}T00:00:00Z`)

// 仓储限额文件导入（06 章 6.6、importers.md F-02）：全部校验通过才写入；每行标注来源（文件名）、采集日期、导入人。
// 同一店铺同一采集日期同一存储类型再次导入会覆盖上一次的导入；与亚马逊月度报告重合的记录不覆盖（要换一个采集日期）。
@Injectable()
export class CapacityImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly policies: InventoryPolicyService,
  ) {}

  async importLimits(req: RequestWithContext, rawBody: unknown): Promise<StorageLimitImportResponse> {
    // 权限检查先于参数校验：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, PERMISSION, {})
    const body = StorageLimitImportBodySchema.parse(rawBody)
    assertStoreInScope(scope, body.sellerAccountId)
    const tenantId = context.tenantId
    const store = await this.prisma.sellerAccount.findFirst({ where: { id: body.sellerAccountId, tenantId }, select: { id: true } })
    if (!store) throw appError('RESOURCE_NOT_FOUND', '店铺不存在')
    const today = await this.policies.todayOf(tenantId)
    const parsed = parseStorageLimits(body.content, today)
    if (parsed.errors.length > 0) throw appError('VALIDATION_FAILED', '文件内容有误，没有导入任何数据', { fieldErrors: { content: parsed.errors } })
    const dates = [...new Set(parsed.rows.map(row => row.captureDate))].sort()
    const now = new Date()
    await this.prisma.$transaction(async tx => {
      const clash = await tx.storageCapacitySnapshot.findMany({
        where: { tenantId, sellerAccountId: store.id, snapshotDate: { in: dates.map(asDate) }, sourceKind: 'REPORT' },
        select: { snapshotDate: true, storageType: true },
        take: 500,
      })
      const conflicts = parsed.rows.filter(row => clash.some(item => item.storageType === row.storageType && item.snapshotDate.toISOString().slice(0, 10) === row.captureDate))
      if (conflicts.length > 0) {
        const lines = conflicts.slice(0, 10).map(row => `${row.captureDate} 的“${storageTypeLabel(row.storageType)}”已有亚马逊月度报告的记录，请换一个采集日期`)
        throw appError('VALIDATION_FAILED', '有记录与亚马逊月度报告重合，没有导入任何数据', { fieldErrors: { content: lines } })
      }
      for (const row of parsed.rows) {
        const data = {
          limitQty: row.limitQty,
          usedQty: row.usedQty,
          utilizationPct: row.usedQty !== null && row.limitQty > 0 ? Math.round((row.usedQty / row.limitQty) * 1_000_000) / 1_000_000 : null,
          sourceKind: 'FILE_IMPORT',
          sourceFileName: body.fileName,
          importedBy: context.userId,
          sourceUpdatedAt: now,
          syncedAt: now,
        }
        await tx.storageCapacitySnapshot.upsert({
          where: { tenantId_sellerAccountId_snapshotDate_storageType: { tenantId, sellerAccountId: store.id, snapshotDate: asDate(row.captureDate), storageType: row.storageType } },
          create: { ...data, tenantId, sellerAccountId: store.id, snapshotDate: asDate(row.captureDate), storageType: row.storageType },
          update: data,
        })
      }
      await this.audit.record(
        req,
        { action: 'STORAGE_LIMITS_IMPORTED', resourceType: 'StorageCapacitySnapshot', resourceId: store.id, after: { fileName: body.fileName, rows: parsed.rows.length, captureDates: dates } },
        { client: tx },
      )
    })
    return { imported: parsed.rows.length, captureDates: dates, sourceFileName: body.fileName }
  }
}
