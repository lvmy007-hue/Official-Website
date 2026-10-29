import type { RowOutcome } from '../../streaming/batch'
import type { ExtraRowHandler } from '../finance/fee-reports'
import { cells, int, num, parseTime, text } from '../inventory/columns'

// 入仓不合规报告（R-25 GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA）的第二处写入：货件接收页的“不合规问题”（P2a-13）。
// 与财务的费用事件在同一遍文件扫描里写（费用事件见 finance/fee-reports.ts）。
// 报告里的货件编号是亚马逊的 FBA 确认号，也可能是我方货件编号，所以只按报告给的编号存，读取时两个编号都匹配；能找到我方计划就记下计划编号。
// 报告没有“已解决”的列，不判断问题是否消除；报告没给数量时数量为空（页面写“未提供”，不写 0）。

const SHIPMENT = ['fba-shipment-id', 'shipment-id']
const SKU = ['sku', 'seller-sku', 'merchant-sku']

export function noncomplianceRowHandler(scope: { tenantId: string; sellerAccountId: string; now?: Date }): ExtraRowHandler {
  const { tenantId, sellerAccountId } = scope
  const plans = new Map<string, string | null>()
  return async ({ prisma }, row): Promise<RowOutcome> => {
    const c = cells(row)
    const shipmentRef = text(c, SHIPMENT)
    const sku = text(c, SKU)
    if (!shipmentRef || !sku) return 'ignored'
    const reportedAt = parseTime(text(c, ['issue-reported-date', 'shipment-creation-date']))
    if (!reportedAt) return 'skipped'
    const now = scope.now ?? new Date()
    const problemType = text(c, ['problem-type'])
    const problemKey = (problemType ?? '').slice(0, 120)
    if (!plans.has(shipmentRef)) {
      const found = await prisma.fbaInboundShipment.findFirst({
        where: { OR: [{ shipmentId: shipmentRef }, { shipmentConfirmationId: shipmentRef }], plan: { tenantId, sellerAccountId } },
        select: { planId: true },
      })
      plans.set(shipmentRef, found?.planId ?? null)
    }
    const data = {
      planId: plans.get(shipmentRef) ?? null,
      qty: int(c, ['quantity', 'units', 'unit-count', 'affected-units']) ?? null,
      problemType: problemType ?? null,
      amount: num(c, ['fee-total']) ?? null,
      currency: text(c, ['currency']) ?? null,
      lastSeenAt: now,
    }
    await prisma.receivingDiscrepancy.upsert({
      where: { tenantId_sellerAccountId_shipmentRef_sku_kind_problemKey: { tenantId, sellerAccountId, shipmentRef, sku, kind: 'NONCOMPLIANCE', problemKey } },
      create: { tenantId, sellerAccountId, shipmentRef, sku, kind: 'NONCOMPLIANCE', problemKey, source: 'REPORT', firstSeenAt: reportedAt, ...data },
      update: data,
    })
    return 'imported'
  }
}
