import type { PrismaClient } from '@prisma/client'
import { isRoleDenied, ORDERS_DATASETS, ORDERS_DATASETS_WITHOUT_PII, type SpApiV2 } from '../../connectors/sp-api-v2'
import type { PiiSealer } from '../../crypto/secrets'
import { loadRetentionPolicy } from '../../platform/tenant-policy'
import { BATCH_TX_TIMEOUT_MS } from '../../streaming/batch'
import type { ImportContext, JsonObject } from '../../types'
import { historyWindows } from '../shared'
import { parseOrder } from './v2026-parse'
import { digestOf, type OrderDigest } from './v2026-types'
import { writeOrder, type OrderScope } from './v2026-write'

// 订单新版接口同步（importers.md S2：接口分页，游标逐页，断点按时间窗）。
// 首次同步按下单时间分 90 天一段回补；之后按“最后更新时间”增量（订单状态变化也会被带回）；历史回补任务携带时间窗时只处理该时间窗。

export type OrdersSyncResult = {
  imported: number
  /** 来源版本比库里更旧而跳过的订单数。 */
  stale: number
  /** 因缺订单号、缺下单时间或非美国站而跳过的订单数。 */
  skipped: number
  pages: number
  /** 店铺没有“买家个人信息”权限：订单已写入，买家信息未取。 */
  piiRestricted: boolean
}

type OrdersApi = Pick<SpApiV2, 'searchOrders'>
const asRecord = (value: unknown): JsonObject | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null)

export async function syncOrdersV2026(
  ctx: ImportContext & { secrets: PiiSealer },
  api: OrdersApi,
  scope: OrderScope,
  options: { since?: Date | null; window?: { after: string; before: string }; onDigest?: (digest: OrderDigest) => void; now?: () => Date } = {},
): Promise<OrdersSyncResult> {
  const now = options.now ?? (() => new Date())
  const result: OrdersSyncResult = { imported: 0, stale: 0, skipped: 0, pages: 0, piiRestricted: false }
  // 买家信息保留天数取企业设置（P5-10）；没有设置过就按亚马逊要求的 30 天
  const customerInfoDays = (await loadRetentionPolicy(ctx.prisma, scope.tenantId))?.customerInfoDays
  let datasets: readonly string[] = ORDERS_DATASETS
  // 时间窗：显式窗口（历史回补）> 增量（上次成功时间前推 2 天兜底）> 首次回补（按下单时间分段）
  const windows: Array<{ createdAfter?: string; createdBefore?: string; lastUpdatedAfter?: string }> = options.window
    ? [{ createdAfter: options.window.after, createdBefore: options.window.before }]
    : options.since
      ? [{ lastUpdatedAfter: new Date(options.since.getTime() - 2 * 86_400_000).toISOString() }]
      : historyWindows(null, 90).map(range => ({ createdAfter: range.after, createdBefore: range.before }))

  for (const window of windows) {
    let token: string | undefined
    do {
      let response: JsonObject
      try {
        response = await api.searchOrders({ ...window, paginationToken: token, includedData: datasets })
      } catch (error) {
        if (!isRoleDenied(error) || datasets === ORDERS_DATASETS_WITHOUT_PII) throw error
        datasets = ORDERS_DATASETS_WITHOUT_PII
        result.piiRestricted = true
        response = await api.searchOrders({ ...window, paginationToken: token, includedData: datasets })
      }
      result.pages += 1
      const orders = Array.isArray(response.orders) ? response.orders.map(asRecord).filter((item): item is JsonObject => item !== null) : []
      const parsed = orders.map(parseOrder)
      await ctx.prisma.$transaction(
        async tx => {
          const inner = { ...ctx, prisma: tx as unknown as PrismaClient }
          for (const order of parsed) {
            if ('skipped' in order) {
              result.skipped += 1
              continue
            }
            options.onDigest?.(digestOf(order))
            if ((await writeOrder(inner, scope, order, now(), customerInfoDays)) === 'written') result.imported += 1
            else result.stale += 1
          }
        },
        { timeout: BATCH_TX_TIMEOUT_MS, maxWait: 10_000 },
      )
      const next = asRecord(response.pagination)?.nextToken
      token = typeof next === 'string' && next.length > 0 ? next : undefined
    } while (token)
  }
  if (result.skipped > 0) ctx.logger.warn({ skipped: result.skipped, ...scope }, 'orders skipped: missing order id, purchase date, or not US marketplace')
  return result
}
