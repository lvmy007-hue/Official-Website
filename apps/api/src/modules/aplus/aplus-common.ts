import {
  APLUS_CONTENT_TYPE_LABEL,
  APLUS_RUN_KIND_LABEL,
  APLUS_STATUS_LABEL,
  APLUS_WRITE,
  APLUS_SWITCH_KEY,
  type AplusContentType,
  type AplusPendingRun,
  type AplusRow,
  type AplusRunKind,
  type AplusStatus,
  type AplusStoreRef,
  type AplusWriteStatus,
} from '@nova/api-contracts'
import type { AplusContent } from '@prisma/client'
import type { ApiContext } from '../../platform/http'
import type { PrismaService } from '../../platform/prisma.service'
import type { ActionGuardService } from '../../platform/write'
import { storeWhere, type ResolvedScope } from '../auth'

// A+ 内容模块的公共部分（P4-14）：可见店铺、列表行、进行中的写入、写入状态、商品标题。模块之间只能经 index 引用，所以这里留各自的小实现。

export const BUSY_STATUSES = ['QUEUED', 'RUNNING'] as const
export const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null)
export const chunk = <T>(items: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))
export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** 成员范围内的店铺（按名称排序）；店铺不多，上限 500。 */
export async function storesOf(prisma: PrismaService, tenantId: string, scope: ResolvedScope): Promise<AplusStoreRef[]> {
  const rows = await prisma.sellerAccount.findMany({
    where: { tenantId, ...storeWhere(scope, 'id') },
    select: { id: true, displayName: true },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    take: 500,
  })
  return rows.map(row => ({ id: row.id, name: row.displayName }))
}

/** 内容的亚马逊文档（草稿 JSON 里的 contentModuleList）；没有就是空数组。 */
export function modulesOf(draftJson: unknown): unknown[] {
  return isRecord(draftJson) && Array.isArray(draftJson.contentModuleList) ? draftJson.contentModuleList : []
}

export function rowOf(content: AplusContent, storeName: string, pendingRun: AplusPendingRun | null): AplusRow {
  const status = content.status as AplusStatus
  const contentType = content.contentType as AplusContentType
  return {
    id: content.id,
    storeId: content.sellerAccountId,
    storeName,
    name: content.name,
    contentType,
    contentTypeLabel: APLUS_CONTENT_TYPE_LABEL[contentType] ?? content.contentType,
    locale: content.locale,
    status,
    statusLabel: APLUS_STATUS_LABEL[status] ?? content.status,
    asinCount: content.asinCount,
    contentReferenceKey: content.contentReferenceKey,
    updatedAt: content.updatedAt.toISOString(),
    rejectionReason: content.rejectionReason,
    publishedAt: iso(content.publishedAt),
    pendingRun,
  }
}

const pendingOf = (run: { kind: string; status: string }): AplusPendingRun => ({
  kind: run.kind as AplusRunKind,
  kindLabel: APLUS_RUN_KIND_LABEL[run.kind as AplusRunKind] ?? run.kind,
  status: run.status === 'RUNNING' ? 'RUNNING' : 'QUEUED',
})

/** 一批内容各自正在排队或处理的写入（同一内容最多一个；万一有多个取最早的那个）。 */
export async function pendingRunsOf(prisma: PrismaService, tenantId: string, contentIds: readonly string[]): Promise<Map<string, AplusPendingRun>> {
  const out = new Map<string, AplusPendingRun>()
  if (contentIds.length === 0) return out
  const rows = await prisma.aplusWriteRun.findMany({
    where: { tenantId, contentId: { in: [...contentIds] }, status: { in: [...BUSY_STATUSES] } },
    select: { contentId: true, kind: true, status: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: contentIds.length * 3,
  })
  for (const row of rows) if (row.contentId && !out.has(row.contentId)) out.set(row.contentId, pendingOf(row))
  return out
}

/** 一份内容当前的写入状态：有没有进行中的写入、没有亚马逊编号的内容最近一次创建是否失败（失败的允许再保存一次重新创建）。 */
export async function runStateOf(prisma: PrismaService, tenantId: string, contentId: string): Promise<{ pending: AplusPendingRun | null; createFailed: boolean }> {
  const [busy, lastCreate] = await Promise.all([
    prisma.aplusWriteRun.findFirst({ where: { tenantId, contentId, status: { in: [...BUSY_STATUSES] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { kind: true, status: true } }),
    prisma.aplusWriteRun.findFirst({ where: { tenantId, contentId, kind: 'CREATE' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { status: true } }),
  ])
  return { pending: busy ? pendingOf(busy) : null, createFailed: lastCreate?.status === 'FAILED' }
}

/** 写入状态（权限 → 卖家连接 → 开关）；连接按“范围内任意一家店铺已授权”判断，具体店铺在提交时再校验。 */
export async function writeStatusOf(guard: ActionGuardService, context: ApiContext): Promise<AplusWriteStatus> {
  const decision = await guard.evaluate(context, { permission: APLUS_WRITE, connection: { provider: 'AMAZON_SP_API' }, switchKey: APLUS_SWITCH_KEY })
  if (decision.allowed || !decision.blockedBy) return { allowed: true, step: null, reason: null, remedyPath: null }
  const block = decision.blockedBy
  const step = block.step === 'PERMISSION' || block.step === 'CONNECTION' || block.step === 'SWITCH' ? block.step : null
  return { allowed: false, step, reason: block.message, remedyPath: block.remedy?.path ?? null }
}

/** 商品标题（同店铺同 ASIN 取排在最前的 SKU）；目录里没有的 ASIN 不在结果里（页面显示“没有标题”，不编造）。 */
export async function titlesOf(prisma: PrismaService, tenantId: string, storeId: string, asins: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const part of chunk([...new Set(asins)], 500)) {
    const rows = await prisma.fbaProduct.findMany({
      where: { tenantId, sellerAccountId: storeId, asin: { in: part } },
      select: { asin: true, title: true },
      orderBy: [{ asin: 'asc' }, { sellerSku: 'asc' }, { id: 'asc' }],
      take: 19_999,
    })
    for (const row of rows) if (!out.has(row.asin) && row.title) out.set(row.asin, row.title)
  }
  return out
}
