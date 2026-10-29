import { Injectable } from '@nestjs/common'
import {
  ESTIMATED_FEE_ACTIONS,
  ESTIMATED_FEE_CURRENCY,
  ESTIMATED_FEE_LIMITS,
  ESTIMATED_FEE_RECOMPUTE_NOTE,
  ESTIMATED_FEE_WRITE,
  EstimatedFeeImportBodySchema,
  dayRangesOverlap,
  parseEstimatedFeeFile,
  type EstimatedFeeImportResponse,
  type EstimatedFeeItemOption,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { assertUnrestricted, ContextService } from '../auth'
import { dayDate, dayOf, loadCostItems } from './estimated-fees-common'

const norm = (text: string) => text.replace(/\s+/g, '').toLowerCase()

/** 费用项按名称或“上级 / 项目”路径对应；同名多个时要求写路径。 */
function resolveItem(items: readonly EstimatedFeeItemOption[], text: string): { id: string } | string {
  const key = norm(text)
  const byPath = items.filter(item => norm(item.path) === key)
  if (byPath.length === 1) return byPath[0]!
  const byName = items.filter(item => norm(item.name) === key)
  if (byName.length === 1) return byName[0]!
  if (byName.length > 1) return `费用项“${text}”有多个同名项目，请写成“上级 / 项目”`
  return `费用项“${text}”不存在或不能挂预估费用`
}

/** 预估费用规则的文件导入（P6-20）：整份校验，任何一行有错整份不导入；文件内的区间也不能互相重叠。 */
@Injectable()
export class EstimatedFeesImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async importFile(req: RequestWithContext, rawBody: unknown, now = new Date()): Promise<EstimatedFeeImportResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, ESTIMATED_FEE_WRITE, {})
    assertUnrestricted(scope)
    const body = EstimatedFeeImportBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const parsed = parseEstimatedFeeFile(body.content)
    const problems = parsed.errors.map(error => ({ line: error.line, message: error.message }))
    const resolved: Array<{ itemId: string; scopeId: string; row: (typeof parsed.rows)[number] }> = []
    if (problems.length === 0) {
      const [items, stores, existing] = await Promise.all([
        loadCostItems(this.prisma, tenantId, context.userId, now),
        this.prisma.sellerAccount.findMany({ where: { tenantId }, select: { id: true, displayName: true }, take: 500 }),
        this.prisma.estimatedFee.findMany({ where: { tenantId }, select: { itemId: true, scopeType: true, scopeId: true, from: true, to: true, status: true }, take: ESTIMATED_FEE_LIMITS.tenantMax }),
      ])
      const skus = [...new Set(parsed.rows.filter(row => row.scopeType === 'SKU').map(row => row.scopeId))]
      const categories = [...new Set(parsed.rows.filter(row => row.scopeType === 'CATEGORY').map(row => row.scopeId))]
      const [skuHits, categoryHits] = await Promise.all([
        skus.length ? this.prisma.fbaProduct.findMany({ where: { tenantId, sellerSku: { in: skus } }, select: { sellerSku: true }, distinct: ['sellerSku'], take: skus.length }) : [],
        categories.length
          ? this.prisma.fbaProduct.findMany({
              where: { tenantId, OR: [{ productType: { in: categories } }, { categoryPath: { in: categories } }] },
              select: { productType: true, categoryPath: true },
              take: 5000,
            })
          : [],
      ])
      const knownSkus = new Set(skuHits.map(hit => hit.sellerSku))
      const knownCategories = new Set(categoryHits.flatMap(hit => [hit.productType, hit.categoryPath].filter((value): value is string => Boolean(value))))
      const storeId = (text: string) => stores.find(store => store.id === text || store.displayName === text)?.id
      const seen = new Map<string, Array<{ from: string; to: string | null }>>()
      for (const row of existing) {
        if (row.status !== 'ACTIVE') continue
        const key = `${row.itemId}|${row.scopeType}|${row.scopeId}`
        seen.set(key, [...(seen.get(key) ?? []), { from: dayOf(row.from), to: row.to ? dayOf(row.to) : null }])
      }
      if (existing.length + parsed.rows.length > ESTIMATED_FEE_LIMITS.tenantMax)
        problems.push({ line: 0, message: `预估费用规则最多 ${ESTIMATED_FEE_LIMITS.tenantMax} 条，现有 ${existing.length} 条，再导入 ${parsed.rows.length} 条会超过上限` })
      for (const row of parsed.rows) {
        if (problems.length >= ESTIMATED_FEE_LIMITS.problemMax) break
        const item = resolveItem(items, row.itemName)
        if (typeof item === 'string') {
          problems.push({ line: row.line, message: item })
          continue
        }
        let scopeId = row.scopeId
        if (row.scopeType === 'STORE') {
          const id = storeId(row.scopeId)
          if (!id) {
            problems.push({ line: row.line, message: `店铺“${row.scopeId}”不存在` })
            continue
          }
          scopeId = id
        } else if (row.scopeType === 'SKU' && !knownSkus.has(row.scopeId)) {
          problems.push({ line: row.line, message: `商品目录里没有 SKU ${row.scopeId}` })
          continue
        } else if (row.scopeType === 'CATEGORY' && !knownCategories.has(row.scopeId)) {
          problems.push({ line: row.line, message: `商品目录里没有品类 ${row.scopeId}` })
          continue
        }
        if (row.status === 'ACTIVE') {
          const key = `${item.id}|${row.scopeType}|${scopeId}`
          const others = seen.get(key) ?? []
          if (others.some(other => dayRangesOverlap(row, other))) {
            problems.push({ line: row.line, message: '生效区间与已有规则（或文件里前面的行）重叠' })
            continue
          }
          seen.set(key, [...others, { from: row.from, to: row.to }])
        }
        resolved.push({ itemId: item.id, scopeId, row })
      }
    }
    if (problems.length > 0) {
      const lines = problems.map(problem => (problem.line > 0 ? `第 ${problem.line} 行：${problem.message}` : problem.message))
      throw appError('VALIDATION_FAILED', '文件内容有误，没有导入任何数据', { fieldErrors: { content: lines } })
    }
    await this.prisma.$transaction(async tx => {
      await tx.estimatedFee.createMany({
        data: resolved.map(({ itemId, scopeId, row }) => ({
          tenantId,
          itemId,
          scopeType: row.scopeType,
          scopeId,
          mode: row.mode,
          value: row.value,
          currency: ESTIMATED_FEE_CURRENCY,
          period: row.mode === 'PERCENT_OF_SALES' ? 'DAILY' : row.period,
          from: dayDate(row.from),
          to: row.to ? dayDate(row.to) : null,
          status: row.status,
          note: row.note,
          createdBy: context.userId,
        })),
      })
      await this.audit.record(req, { action: ESTIMATED_FEE_ACTIONS.imported, resourceType: 'EstimatedFee', detail: { fileName: body.fileName, rows: resolved.length } }, { client: tx })
    })
    return { total: resolved.length, created: resolved.length, recomputeNote: ESTIMATED_FEE_RECOMPUTE_NOTE }
  }
}
