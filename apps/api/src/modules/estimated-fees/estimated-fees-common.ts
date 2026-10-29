import {
  ESTIMATED_FEE_CURRENCY,
  ESTIMATED_FEE_LIMITS,
  dayRangesOverlap,
  effectiveTargetOf,
  isEstimatedFeeTarget,
  scopeText,
  type EstimatedFeeItemOption,
  type EstimatedFeeRow,
  type EstimatedMode,
  type EstimatedPeriod,
  type EstimatedScopeType,
  type EstimatedStatus,
} from '@nova/api-contracts'
import { appError } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ensureProfitDictionary } from '../profit-items'

// 预估与自定义费用的公共读取与校验（P6-20）：可选费用项、范围对象存在性、生效区间重叠、行的展示形状。

export interface EstimatedFeeRecord {
  id: string
  itemId: string
  scopeType: string
  scopeId: string
  mode: string
  value: { toString(): string }
  currency: string
  period: string
  from: Date
  to: Date | null
  status: string
  note: string | null
  version: number
  createdBy: string | null
  updatedAt: Date
}

export const dayOf = (value: Date): string => value.toISOString().slice(0, 10)
export const dayDate = (text: string): Date => new Date(`${text}T00:00:00Z`)
export const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === 'P2002'

/**
 * 可以挂预估费用的费用项：利润项目字典里归到“花费类”利润桥项目的项目（收入、赔付、代收代缴税、广告、采购成本等不接收）。
 * 第一次读取会生成第一版字典；返回项目的完整路径（“物流费用 / 仓储费”）。
 */
export async function loadCostItems(prisma: PrismaService, tenantId: string, userId: string | null, now: Date): Promise<EstimatedFeeItemOption[]> {
  await ensureProfitDictionary(prisma, tenantId, userId, now)
  const items = await prisma.profitItem.findMany({
    where: { tenantId },
    select: { id: true, parentId: true, name: true, group: true, systemKey: true, sort: true, level: true },
    orderBy: [{ level: 'asc' }, { sort: 'asc' }],
    take: 1000,
  })
  const byId = new Map(items.map(item => [item.id, item]))
  const nodes = new Map(items.map(item => [item.id, { id: item.id, parentId: item.parentId, group: item.group, systemKey: item.systemKey }]))
  const pathOf = (id: string): string => {
    const names: string[] = []
    let current = byId.get(id)
    for (let depth = 0; current && depth < 4; depth += 1) {
      names.unshift(current.name)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    return names.join(' / ')
  }
  const options: EstimatedFeeItemOption[] = []
  for (const item of items) {
    if (isEstimatedFeeTarget(effectiveTargetOf(nodes.get(item.id) as { id: string; parentId: string | null; group: string; systemKey: string | null }, nodes)))
      options.push({ id: item.id, name: item.name, path: pathOf(item.id) })
  }
  return options.sort((a, b) => a.path.localeCompare(b.path))
}

export async function requireCostItem(prisma: PrismaService, tenantId: string, userId: string | null, itemId: string, now: Date): Promise<EstimatedFeeItemOption> {
  const hit = (await loadCostItems(prisma, tenantId, userId, now)).find(item => item.id === itemId)
  if (!hit) throw appError('VALIDATION_FAILED', '这个费用项不存在或不能挂预估费用（收入、赔付、代收代缴税、广告、采购成本不是预估费用）', { fieldErrors: { itemId: ['请选择可以预估的费用项'] } })
  return hit
}

/** 范围对象必须真实存在：店铺是本企业的店铺，SKU 在商品目录里，品类是目录里的商品类型或类目路径。 */
export async function assertScopeExists(prisma: PrismaService, tenantId: string, scopeType: EstimatedScopeType, scopeId: string): Promise<void> {
  let found: boolean
  if (scopeType === 'STORE') found = (await prisma.sellerAccount.findFirst({ where: { id: scopeId, tenantId }, select: { id: true } })) !== null
  else if (scopeType === 'SKU') found = (await prisma.fbaProduct.findFirst({ where: { tenantId, sellerSku: scopeId }, select: { id: true } })) !== null
  else found = (await prisma.fbaProduct.findFirst({ where: { tenantId, OR: [{ productType: scopeId }, { categoryPath: scopeId }] }, select: { id: true } })) !== null
  if (found) return
  const message = scopeType === 'STORE' ? '店铺不存在' : scopeType === 'SKU' ? `商品目录里没有 SKU ${scopeId}` : `商品目录里没有品类 ${scopeId}（填商品类型或类目路径）`
  throw appError('VALIDATION_FAILED', message, { fieldErrors: { scopeId: [message] } })
}

/** 同一费用项、同一范围，处于生效状态的规则区间不能重叠；返回与之冲突的那一条，没有返回 null。 */
export async function findOverlap(
  prisma: Pick<PrismaService, 'estimatedFee'>,
  tenantId: string,
  candidate: { itemId: string; scopeType: string; scopeId: string; from: string; to?: string | null; status: string },
  exceptId: string | null,
): Promise<{ id: string; from: string; to: string | null } | null> {
  if (candidate.status !== 'ACTIVE') return null
  const others = await prisma.estimatedFee.findMany({
    where: { tenantId, itemId: candidate.itemId, scopeType: candidate.scopeType, scopeId: candidate.scopeId, status: 'ACTIVE', ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, from: true, to: true },
    take: ESTIMATED_FEE_LIMITS.tenantMax,
  })
  for (const other of others) {
    const range = { from: dayOf(other.from), to: other.to ? dayOf(other.to) : null }
    if (dayRangesOverlap({ from: candidate.from, to: candidate.to ?? null }, range)) return { id: other.id, ...range }
  }
  return null
}

export const overlapMessage = (hit: { from: string; to: string | null }) => `同一费用项、同一范围已经有生效区间重叠的规则（${hit.from} 至 ${hit.to ?? '长期'}）；请调整区间，或先停用那一条`

export function feeRow(record: EstimatedFeeRecord, item: { name: string; path: string } | undefined, storeNames: ReadonlyMap<string, string>): EstimatedFeeRow {
  const scopeType = record.scopeType as EstimatedScopeType
  const name = scopeType === 'STORE' ? (storeNames.get(record.scopeId) ?? '（已删除的店铺）') : record.scopeId
  return {
    id: record.id,
    itemId: record.itemId,
    itemName: item?.name ?? '（已删除的费用项）',
    itemPath: item?.path ?? '',
    scopeType,
    scopeId: record.scopeId,
    scopeName: name,
    mode: record.mode as EstimatedMode,
    value: Number(record.value.toString()),
    currency: record.currency || ESTIMATED_FEE_CURRENCY,
    period: record.period as EstimatedPeriod,
    from: dayOf(record.from),
    to: record.to ? dayOf(record.to) : null,
    status: record.status as EstimatedStatus,
    note: record.note,
    version: record.version,
    createdBy: record.createdBy,
    updatedAt: record.updatedAt.toISOString(),
  }
}

/** 审计里记规则本身（没有敏感字段）。 */
export const feeAudit = (
  record: Pick<EstimatedFeeRecord, 'itemId' | 'scopeType' | 'scopeId' | 'mode' | 'period' | 'status' | 'version'> & { value: { toString(): string }; from: Date; to: Date | null },
) => ({
  itemId: record.itemId,
  scope: scopeText(record.scopeType as EstimatedScopeType, record.scopeId),
  mode: record.mode,
  value: Number(record.value.toString()),
  period: record.period,
  from: dayOf(record.from),
  to: record.to ? dayOf(record.to) : null,
  status: record.status,
  version: record.version,
})
