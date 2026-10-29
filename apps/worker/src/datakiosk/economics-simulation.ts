import { ECONOMICS_DATASET_SIMULATION, ECONOMICS_SIM_ACTIONS, ECONOMICS_SIM_MAX_PRICE, ECONOMICS_SIM_MAX_QUANTITY } from '@nova/api-contracts'
import { Prisma } from '@prisma/client'
import type { RowOutcome } from '../streaming/batch'
import type { Row } from '../streaming/rows'
import type { ImportContext } from '../types'
import { count, DATE_PATTERN, get, money, quote, round, unwrapRecord } from './json'
import { registerDataKioskDataset, type DataKioskDataset, type KioskScope } from './registry'

// 数据中心“经济模拟”数据集（importers.md D-06，P2a-07；P2b-11 起支持原包装发货与自定义单价）：补货页的“上游仓储（AWD）模拟”与官方经济数据对账页的“情景模拟”共用。
// 字段与参数于 2026 年 10 月对照官方 schema 复核（selling-partner-api-models/schemas/data-kiosk/analytics_economics_2024_03_15.graphql）：
//   analytics_economics_2024_03_15 { economicsSimulation(actionTypes, marketplaceId, startDate, endDate, products) { ... } }
//   开始日期不得早于今天，结束日期不得晚于今天后 90 天；一次最多 100 个商品；商品用 MSKU（卖家自己的 SKU）标识；
//   动作类型只有 AWD（上游仓储）与 SIPP（原包装发货）；inputContext.sendToAWDQuantity 是“发往上游仓储的数量”，itemPrice 是自定义单价（不给用商品当前价格）；
//   “只会返回有资格使用该服务的商品”，所以结果行数为 0 表示该 SKU 没有资格（界面如实显示，不当作错误）。
// 结果是估算值（官方模拟），不是实际发生的账单。需要“卖家洞察”角色。

export const ECONOMICS_DATASET = ECONOMICS_DATASET_SIMULATION
const MARKETPLACE_ID = 'ATVPDKIKX0DER'

type Entry = { sales: number; fees: number; netProceeds: number; units: number | null; currency: string | null }
type Stored = { currency: string | null; sales: number | null; fees: number | null; netProceeds: number | null; units: number | null; rows: number; entries: Record<string, Entry> }

/** 参数由接口层校验后写进任务上下文；这里再校验一遍格式，防止拼进查询的内容越界。 */
export function buildEconomicsQuery(params: Record<string, string>): string {
  const sku = params.sku
  const action = params.actionType ?? 'AWD' // 旧任务（P2a-07 的补货页）没有这个参数，一律是上游仓储
  if (!(ECONOMICS_SIM_ACTIONS as readonly string[]).includes(action)) throw new Error('ECONOMICS_SIMULATION_ACTION_INVALID')
  if (!sku || sku.length > 200) throw new Error('ECONOMICS_SIMULATION_SKU_INVALID')
  if (!DATE_PATTERN.test(params.startDate ?? '') || !DATE_PATTERN.test(params.endDate ?? '')) throw new Error('ECONOMICS_SIMULATION_DATE_INVALID')
  const context: string[] = []
  if (action === 'AWD') {
    const quantity = Number(params.quantity)
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > ECONOMICS_SIM_MAX_QUANTITY) throw new Error('ECONOMICS_SIMULATION_QUANTITY_INVALID')
    context.push(`sendToAWDQuantity: ${quantity}`)
  }
  if (params.price !== undefined && params.price !== '') {
    const price = Number(params.price)
    if (!/^\d+(\.\d{1,2})?$/.test(params.price) || !(price > 0) || price > ECONOMICS_SIM_MAX_PRICE) throw new Error('ECONOMICS_SIMULATION_PRICE_INVALID')
    context.push(`itemPrice: { amount: ${price}, currencyCode: "USD" }`)
  }
  const amount = '{ amount currencyCode }'
  const inputContext = context.length > 0 ? `, inputContext: { ${context.join(', ')} }` : ''
  return `{ analytics_economics_2024_03_15 { economicsSimulation(
    actionTypes: [${action}], marketplaceId: ${quote(MARKETPLACE_ID)}, startDate: ${quote(params.startDate)}, endDate: ${quote(params.endDate)},
    products: [{ identifier: { type: MSKU, value: ${quote(sku)} }${inputContext} }]
  ) { msku startDate endDate
      sales { netProductSales ${amount} netUnitsSold }
      fees { feeTypeName charges { aggregatedDetail { totalAmount ${amount} } } }
      netProceeds { total ${amount} }
  } } }`
}

/** 一行结果 → 本行的销售额、费用合计、净收入、净销量。费用把每个费用类型下所有 charge 的总额相加。 */
export function readEconomicsRow(row: Row): { key: string; entry: Entry } | null {
  const item = unwrapRecord(row, 'analytics_economics_2024_03_15', 'economicsSimulation')
  const sales = money(get(item, 'sales', 'netProductSales'))
  const net = money(get(item, 'netProceeds', 'total'))
  if (!sales && !net) return null
  const fees = Array.isArray(get(item, 'fees')) ? (get(item, 'fees') as unknown[]) : []
  let feeTotal = 0
  let currency = sales?.currency ?? net?.currency ?? null
  for (const fee of fees) {
    const charges = get(fee, 'charges')
    for (const charge of Array.isArray(charges) ? charges : []) {
      const total = money(get(charge, 'aggregatedDetail', 'totalAmount'))
      if (!total) continue
      feeTotal += total.amount
      currency = currency ?? total.currency
    }
  }
  const msku = String(get(item, 'msku') ?? '')
  const units = count(get(item, 'sales', 'netUnitsSold'))
  return {
    key: `${msku}|${String(get(item, 'startDate') ?? '')}|${String(get(item, 'endDate') ?? '')}`,
    entry: { sales: sales?.amount ?? 0, fees: feeTotal, netProceeds: net?.amount ?? 0, units, currency },
  }
}

async function handle(ctx: ImportContext, row: Row, scope: KioskScope, params: Record<string, string>): Promise<RowOutcome> {
  const parsed = readEconomicsRow(row)
  if (!parsed || !params.runId) return 'skipped'
  const run = await ctx.prisma.economicsSimulationRun.findFirst({
    where: { id: params.runId, tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId },
    select: { id: true, resultJson: true },
  })
  if (!run) return 'skipped'
  // 按行键覆盖再整体汇总：任务重试时同一行不会被重复累加
  const stored = (run.resultJson ?? { entries: {} }) as Partial<Stored>
  const entries = { ...(stored.entries ?? {}), [parsed.key]: parsed.entry }
  const all = Object.values(entries)
  const unitsKnown = all.every(entry => entry.units !== null && entry.units !== undefined)
  const next: Stored = {
    currency: all.find(entry => entry.currency)?.currency ?? null,
    sales: round(all.reduce((sum, entry) => sum + entry.sales, 0)),
    fees: round(all.reduce((sum, entry) => sum + entry.fees, 0)),
    netProceeds: round(all.reduce((sum, entry) => sum + entry.netProceeds, 0)),
    units: unitsKnown ? all.reduce((sum, entry) => sum + (entry.units ?? 0), 0) : null,
    rows: all.length,
    entries,
  }
  await ctx.prisma.economicsSimulationRun.update({ where: { id: run.id }, data: { resultJson: next as unknown as Prisma.InputJsonValue } })
  return 'imported'
}

export const economicsSimulationDataset: DataKioskDataset = { id: ECONOMICS_DATASET, buildQuery: buildEconomicsQuery, handle, reportType: 'DATA_KIOSK_ECONOMICS_SIMULATION' }

export function registerEconomicsSimulation() {
  registerDataKioskDataset(economicsSimulationDataset)
}
