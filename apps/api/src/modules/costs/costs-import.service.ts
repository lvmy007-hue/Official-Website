import { randomBytes } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { CostImportBodySchema, type CostImportResult } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { CostsAccessService } from './costs-access.service'
import { asDay, futureLimit, isUniqueViolation, tenantToday } from './costs-common'
import { parseCostFile } from './costs-import'

const SKU_BATCH = 500

// 商品成本文件导入（06 章“批量录入”、importers.md F-04）：浏览器读出 CSV 文本后提交，一行有错整份拒绝；
// 全部通过后每一行写成一个“导入草稿”（来源 FILE_IMPORT、来源单据 = 批次号:行号），不会直接生效——到列表里确认后才参与利润计价。
@Injectable()
export class CostsImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CostsAccessService,
    private readonly audit: AuditWriter,
  ) {}

  async importFile(req: RequestWithContext, rawBody: unknown, now: Date = new Date()): Promise<CostImportResult> {
    const access = await this.access.write(req)
    const body = CostImportBodySchema.parse(rawBody)
    const { tenantId, context } = access
    const today = await tenantToday(this.prisma, tenantId, now)
    const parsed = parseCostFile(body.content, futureLimit(today))
    if (parsed.errors.length > 0) throw appError('VALIDATION_FAILED', '文件内容有误，没有导入任何数据', { fieldErrors: { content: parsed.errors } })
    const skus = [...new Set(parsed.rows.map(row => row.sku))].sort()
    const known = new Set<string>()
    for (let start = 0; start < skus.length; start += SKU_BATCH) {
      const part = skus.slice(start, start + SKU_BATCH)
      const [products, versions] = await Promise.all([
        this.prisma.fbaProduct.groupBy({ by: ['sellerSku'], where: { tenantId, sellerSku: { in: part } }, orderBy: { sellerSku: 'asc' }, take: SKU_BATCH }),
        this.prisma.costVersion.groupBy({ by: ['sku'], where: { tenantId, sku: { in: part } }, orderBy: { sku: 'asc' }, take: SKU_BATCH }),
      ])
      for (const item of products) known.add(item.sellerSku)
      for (const item of versions) known.add(item.sku)
    }
    const unknown = parsed.rows.filter(row => !known.has(row.sku))
    if (unknown.length > 0) {
      const lines = unknown.slice(0, 10).map(row => `第 ${row.line} 行：SKU“${row.sku}”不存在，请先同步商品或检查拼写`)
      throw appError('VALIDATION_FAILED', '有 SKU 不存在，没有导入任何数据', { fieldErrors: { content: lines } })
    }
    const batchId = `IMP${randomBytes(4).toString('hex')}`
    await this.prisma
      .$transaction(async tx => {
        const latest = new Map<string, number>()
        for (let start = 0; start < skus.length; start += SKU_BATCH) {
          const groups = await tx.costVersion.groupBy({
            by: ['sku'],
            where: { tenantId, sku: { in: skus.slice(start, start + SKU_BATCH) } },
            _max: { versionNo: true },
            orderBy: { sku: 'asc' },
            take: SKU_BATCH,
          })
          for (const group of groups) latest.set(group.sku, group._max.versionNo ?? 0)
        }
        await tx.costVersion.createMany({
          data: [...parsed.rows]
            .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : a.effectiveFrom < b.effectiveFrom ? -1 : 1))
            .map(row => {
              const versionNo = (latest.get(row.sku) ?? 0) + 1
              latest.set(row.sku, versionNo)
              return {
                tenantId,
                sku: row.sku,
                versionNo,
                effectiveFrom: asDay(row.effectiveFrom),
                currency: row.currency,
                unitProductCost: row.amounts.product,
                unitFirstMileCost: row.amounts.firstMile,
                unitDutyCost: row.amounts.duty,
                unitOtherCost: row.amounts.other,
                source: 'FILE_IMPORT',
                status: 'DRAFT',
                sourceDocId: `${batchId}:${row.line}`,
                note: row.note,
                createdBy: context.userId,
              }
            }),
        })
        await this.audit.record(
          req,
          { action: 'COST_VERSIONS_IMPORTED', resourceType: 'CostVersion', resourceId: batchId, after: { fileName: body.fileName, batchId, rows: parsed.rows.length, skus: skus.length } },
          { client: tx },
        )
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw appError('CONFLICT', '导入的同时有人新建了版本，请重新导入')
        throw error
      })
    return {
      batchId,
      imported: parsed.rows.length,
      skus: skus.length,
      fileName: body.fileName,
      message: `已导入 ${parsed.rows.length} 个草稿（${skus.length} 个 SKU），请到列表里确认后生效；批次号 ${batchId}`,
    }
  }
}
