import { Injectable } from '@nestjs/common'
import {
  SKU_ALIAS_ACTIONS,
  SKU_ALIAS_EXPORT_MAX_ROWS,
  SKU_ALIAS_MANAGE,
  SKU_ALIAS_READ,
  SkuAliasImportBodySchema,
  parseSkuAliasFile,
  skuAliasExportCsv,
  type SkuAliasExportResponse,
  type SkuAliasImportResponse,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService } from '../auth'
import { SkuAliasService } from './sku-alias.service'

// 外部货号映射的文件导入与导出（P6-11）：导入整份校验，任何一行有错就整份不导入；导出的文件可以直接再导入。
@Injectable()
export class SkuAliasImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly aliases: SkuAliasService,
  ) {}

  async importFile(req: RequestWithContext, rawBody: unknown): Promise<SkuAliasImportResponse> {
    const { context } = await this.context.authorizeScoped(req, SKU_ALIAS_MANAGE, {})
    const body = SkuAliasImportBodySchema.parse(rawBody)
    const parsed = parseSkuAliasFile(body.content)
    const problems = parsed.errors.map(error => ({ line: error.line, message: error.message }))
    const rows = parsed.rows
    const supplierByCode = new Map<string, string>()
    if (problems.length === 0) {
      const codes = [...new Set(rows.flatMap(row => (row.supplierCode ? [row.supplierCode] : [])))]
      const [suppliers, titles] = await Promise.all([
        codes.length ? this.prisma.supplier.findMany({ where: { tenantId: context.tenantId, code: { in: codes } }, select: { id: true, code: true }, take: codes.length }) : [],
        this.aliases.catalogTitles(
          context.tenantId,
          rows.map(row => row.sku),
        ),
      ])
      for (const supplier of suppliers) supplierByCode.set(supplier.code, supplier.id)
      for (const row of rows) {
        if (row.supplierCode && !supplierByCode.has(row.supplierCode)) problems.push({ line: row.line, message: `供应商编码 ${row.supplierCode} 不存在` })
        if (!titles.has(row.sku)) problems.push({ line: row.line, message: `商品目录里没有 SKU ${row.sku}` })
        if (problems.length >= 50) break
      }
    }
    if (problems.length > 0) {
      const lines = problems.map(problem => (problem.line > 0 ? `第 ${problem.line} 行：${problem.message}` : problem.message))
      throw appError('VALIDATION_FAILED', '文件内容有误，没有导入任何数据', { fieldErrors: { content: lines } })
    }

    // 同一个供应商（含通用）分别一次写入；整份在一个事务里，要么全进要么全不进
    const groups = new Map<string | null, Array<{ externalCode: string; sku: string }>>()
    for (const row of rows) {
      const supplierId = row.supplierCode ? (supplierByCode.get(row.supplierCode) ?? null) : null
      groups.set(supplierId, [...(groups.get(supplierId) ?? []), { externalCode: row.externalCode, sku: row.sku }])
    }
    const result = await this.prisma.$transaction(async tx => {
      let created = 0
      let updated = 0
      for (const [supplierId, items] of groups) {
        const part = await this.aliases.remember(tx, context.tenantId, context.userId, supplierId, items, 'IMPORT')
        created += part.created
        updated += part.updated
      }
      await this.audit.record(req, { action: SKU_ALIAS_ACTIONS.imported, resourceType: 'SkuAlias', detail: { fileName: body.fileName, rows: rows.length, created, updated } }, { client: tx })
      return { total: rows.length, created, updated }
    })
    return result
  }

  async exportFile(req: RequestWithContext): Promise<SkuAliasExportResponse> {
    const { context } = await this.context.authorizeScoped(req, SKU_ALIAS_READ, {})
    const rows = await this.prisma.skuAlias.findMany({
      where: { tenantId: context.tenantId },
      orderBy: [{ externalCode: 'asc' }, { id: 'asc' }],
      take: SKU_ALIAS_EXPORT_MAX_ROWS + 1,
      select: { externalCode: true, sku: true, supplier: { select: { code: true } } },
    })
    const truncated = rows.length > SKU_ALIAS_EXPORT_MAX_ROWS
    const kept = rows.slice(0, SKU_ALIAS_EXPORT_MAX_ROWS)
    const stamp = new Date().toISOString().slice(0, 10)
    return {
      fileName: `外部货号映射-${stamp}.csv`,
      content: skuAliasExportCsv(kept.map(row => ({ supplierCode: row.supplier?.code ?? null, externalCode: row.externalCode, sku: row.sku }))),
      rows: kept.length,
      truncated,
    }
  }
}
