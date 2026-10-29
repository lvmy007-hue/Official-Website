import {
  AWD_LABEL_STATUS_LABEL,
  AWD_ORDER_STATUS_LABEL,
  AWD_SHIPMENT_STATUS_LABEL,
  AWD_SWITCH_KEY,
  aggregateFreshness,
  freshnessSourceOfJobType,
  type AwdFreshness,
  type AwdOrderRow,
  type AwdOrderStatus,
  type AwdPendingAction,
  type AwdShipmentRow,
  type AwdWriteStatus,
} from '@nova/api-contracts'
import type { AwdInboundOrder, AwdInboundShipment } from '@prisma/client'
import type { ApiContext } from '../../platform/http'
import type { PrismaService } from '../../platform/prisma.service'
import type { ActionGuardService } from '../../platform/write'
import { storeWhere, type ResolvedScope } from '../auth'

export const AWD_READ = 'awd.read'
export const AWD_WRITE = 'awd.order.write'
export const AWD_FRESHNESS_KEY = 'awd.api'

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)
export const dateText = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null)

/** 范围内店铺的上游仓储同步新鲜度（最差的店铺为准）；范围内没有店铺时为 null。 */
export async function awdFreshness(prisma: PrismaService, tenantId: string, scope: ResolvedScope, now = new Date()): Promise<AwdFreshness | null> {
  const spec = freshnessSourceOfJobType('AWD_SYNC')
  if (!spec) return null
  const [stores, rows] = await Promise.all([
    prisma.sellerAccount.findMany({ where: { tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) }, select: { id: true }, take: 500 }),
    prisma.dataFreshness.findMany({
      where: { tenantId, sourceKey: AWD_FRESHNESS_KEY, ...storeWhere(scope) },
      select: { sellerAccountId: true, sourceKey: true, lastAttemptAt: true, lastSuccessAt: true, dataThrough: true, status: true, lastErrorCode: true },
      take: 5000,
    }),
  ])
  if (stores.length === 0) return null
  const view = aggregateFreshness(
    rows,
    stores.map(store => store.id),
    now,
    [spec],
  ).sources[0]
  return { status: view.status, statusLabel: view.statusLabel, lastSuccessAt: iso(view.lastSuccessAt), errorMessage: view.errorMessage }
}

/** 列表页的整体状态：没开通 / 尚未同步 / 暂无记录 / 有数据。不把“没有记录”说成 0。 */
export function viewState(freshness: AwdFreshness | null, hasRows: boolean): { state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED' | 'NOT_APPLICABLE'; note: string | null } {
  if (hasRows) return { state: 'OK', note: null }
  if (freshness?.status === 'NOT_APPLICABLE') return { state: 'NOT_APPLICABLE', note: '这些店铺没有开通亚马逊仓储分销（AWD），没有可显示的数据' }
  if (!freshness || freshness.status === 'NO_RECORD' || freshness.status === 'NOT_CONNECTED')
    return { state: 'NOT_CONNECTED', note: '亚马逊仓储分销（AWD）尚未同步；店铺授权完成后会每 2 小时同步一次' }
  if (freshness.status === 'NORMAL' || freshness.status === 'DELAYED') return { state: 'NO_DATA', note: '尚无记录' }
  return { state: 'NOT_CONNECTED', note: freshness.errorMessage ?? '上游仓储同步没有成功，暂时没有可显示的数据' }
}

/** 页面按钮状态：权限 → 连接 → 写入开关，服务端执行前用同一套规则再判断一次。 */
export async function writeStatus(guard: ActionGuardService, context: ApiContext, sellerAccountId?: string): Promise<AwdWriteStatus> {
  const decision = await guard.evaluate(context, {
    permission: AWD_WRITE,
    connection: { provider: 'AMAZON_SP_API', ...(sellerAccountId ? { sellerAccountId } : {}) },
    switchKey: AWD_SWITCH_KEY,
  })
  if (decision.allowed || !decision.blockedBy) return { allowed: true, step: null, reason: null, remedyPath: null }
  const block = decision.blockedBy
  const step = block.step === 'PERMISSION' || block.step === 'CONNECTION' || block.step === 'SWITCH' ? block.step : null
  return { allowed: false, step, reason: block.message, remedyPath: block.remedy?.path ?? null }
}

export const orderRowOf = (row: AwdInboundOrder, storeName: string): AwdOrderRow => ({
  id: row.id,
  sellerAccountId: row.sellerAccountId,
  storeName,
  orderId: row.orderId,
  externalReferenceId: row.externalReferenceId,
  status: row.status as AwdOrderStatus,
  statusLabel: AWD_ORDER_STATUS_LABEL[row.status as AwdOrderStatus] ?? row.status,
  pendingAction: row.pendingAction as AwdPendingAction | null,
  expectedUnits: row.expectedUnits,
  receivedUnits: row.receivedUnits,
  packageDeliveryMode: row.packageDeliveryMode,
  destinationRegion: row.destinationRegion,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  version: row.version,
  lastErrorMessage: row.lastErrorMessage,
})

export const shipmentRowOf = (row: AwdInboundShipment, extra: { orderRowId: string | null; expectedUnits: number | null; receivedUnits: number | null }): AwdShipmentRow => ({
  id: row.id,
  shipmentId: row.shipmentId,
  orderId: row.orderId,
  orderRowId: extra.orderRowId,
  status: row.status,
  statusLabel: AWD_SHIPMENT_STATUS_LABEL[row.status as keyof typeof AWD_SHIPMENT_STATUS_LABEL] ?? '未知状态',
  carrier: row.carrier,
  trackingNumber: row.trackingNumber,
  destination: row.destinationRegion,
  shipBy: iso(row.shipBy),
  createdAt: iso(row.amazonCreatedAt),
  updatedAt: iso(row.amazonUpdatedAt),
  labelStatus: row.labelStatus,
  expectedUnits: extra.expectedUnits,
  receivedUnits: extra.receivedUnits,
})

export const labelStatusLabel = (status: string | null) => (status ? (AWD_LABEL_STATUS_LABEL[status] ?? status) : '尚未获取')
