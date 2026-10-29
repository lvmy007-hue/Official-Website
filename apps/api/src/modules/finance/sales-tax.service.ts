import { Injectable } from '@nestjs/common'
import {
  SALES_TAX_CURRENCY,
  SALES_TAX_DEFAULT_DAYS,
  SALES_TAX_FRESHNESS_KEYS,
  SALES_TAX_READ,
  SALES_TAX_RECON_LABEL,
  SALES_TAX_SOURCE_LABEL,
  SALES_TAX_TOLERANCE_ABS,
  SALES_TAX_TOLERANCE_RATIO,
  ScopeSearchSchema,
  addDaysText,
  reconcileTax,
  roundCash,
  taxWindowsOf,
  type SalesTaxReconRow,
  type SalesTaxResponse,
  type SalesTaxSourceView,
  type SalesTaxTrendPoint,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { sourceFreshness } from '../inventory'
import { todayIn, validZone } from '../overview'
import { loadStores } from './cashflow-load'
import { loadOrdersMonthly, loadReportMonthly, loadReportStates, loadStoreStatuses } from './sales-tax-load'

const NO_DATA_NOTE = '尚无销售税数据：需要先在卖家后台“税务文档库”生成销售税报告（并获批受限角色“税务汇缴”），同步任务每天检索一次；订单接口的税额同步到后显示在对账里'
const BASIS = [
  '税务文档库报告按报告里的日期、订单接口按下单时间，都以 UTC 日历日分月；',
  '订单接口不含收货州（收货地址属于买家个人信息，不用于汇总），所以只能按月对总额，不能分州。',
  `目前只有美国站，金额为${SALES_TAX_CURRENCY}。`,
  `报告与订单合计相差不超过 max(${SALES_TAX_TOLERANCE_ABS}, ${SALES_TAX_TOLERANCE_RATIO * 100}%×较大者) 算一致（这个容差是我们自己定的，不是亚马逊公布的）；`,
  '订单状态（如已取消）不单独剔除。',
].join('')
const sumOf = (values: Iterable<number>) => roundCash([...values].reduce((total, value) => total + value, 0))

// 销售税（P2b-12，07 章 7.11）：按州汇总平台代收代缴税额（来自税务文档库报告）、与订单接口的税额按月对账、月度趋势。
// 没有报告、没有授权、没有数据都如实标出原因，不显示成 0。
@Injectable()
export class SalesTaxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async read(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<SalesTaxResponse> {
    // 先做权限检查再解析参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, SALES_TAX_READ, rawQuery)
    const query = ScopeSearchSchema.parse(rawQuery)
    const tenantId = context.tenantId
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    const today = todayIn(validZone(tenant?.timezone), now)
    const defaulted = !query.from || !query.to
    const requestedFrom = defaulted ? addDaysText(today, 1 - SALES_TAX_DEFAULT_DAYS) : query.from!
    const requestedTo = defaulted ? today : query.to!
    const { windows, clamped } = taxWindowsOf(requestedFrom, requestedTo)
    const from = windows[0]?.from ?? requestedFrom
    const to = windows[windows.length - 1]?.to ?? requestedTo

    const stores = await loadStores(this.prisma, tenantId, scope)
    const [report, reportMonthly, ordersMonthly, statuses, freshness] = await Promise.all([
      loadReportStates(this.prisma, tenantId, scope, from, to),
      loadReportMonthly(this.prisma, tenantId, scope, windows),
      loadOrdersMonthly(this.prisma, tenantId, scope, windows),
      loadStoreStatuses(this.prisma, tenantId, scope, stores),
      sourceFreshness(this.prisma, tenantId, scope, SALES_TAX_FRESHNESS_KEYS, now),
    ])

    const trend = windows.map<SalesTaxTrendPoint>(window => {
      const pick = (map: Map<string, number>) => {
        const values = stores.flatMap(store => (map.has(`${store.id}|${window.month}`) ? [map.get(`${store.id}|${window.month}`)!] : []))
        return values.length === 0 ? null : sumOf(values)
      }
      return { month: window.month, from: window.from, to: window.to, reportTax: pick(reportMonthly), ordersTax: pick(ordersMonthly) }
    })
    const reconciliation = windows.flatMap(window =>
      stores.flatMap<SalesTaxReconRow>(store => {
        const key = `${store.id}|${window.month}`
        const reportTax = reportMonthly.get(key) ?? null
        const ordersTax = ordersMonthly.get(key) ?? null
        const result = reconcileTax(reportTax, ordersTax)
        return result
          ? [
              {
                sellerAccountId: store.id,
                storeName: store.name,
                month: window.month,
                from: window.from,
                to: window.to,
                reportTax,
                ordersTax,
                diff: result.diff,
                state: result.state,
                stateLabel: SALES_TAX_RECON_LABEL[result.state],
              },
            ]
          : []
      }),
    )
    const ordersTotal = ordersMonthly.size === 0 ? null : sumOf(ordersMonthly.values())
    const hasData = report.states.length > 0 || ordersTotal !== null
    return {
      state: hasData ? 'OK' : 'NO_DATA',
      note: hasData ? null : NO_DATA_NOTE,
      range: { from, to, defaulted, clamped },
      currency: SALES_TAX_CURRENCY,
      stores: statuses,
      sources: this.sources(report.taxCollected, ordersTotal, statuses.filter(item => item.state === 'AVAILABLE').length),
      totals: { taxCollected: report.taxCollected, taxableSales: report.taxableSales, ordersTax: ordersTotal },
      states: report.states,
      jurisdictionsTruncated: report.truncated,
      trend,
      reconciliation,
      basis: BASIS,
      freshness,
    }
  }

  private sources(reportTotal: number | null, ordersTotal: number | null, availableStores: number): SalesTaxSourceView[] {
    return [
      {
        source: 'TAX_LIBRARY',
        label: SALES_TAX_SOURCE_LABEL.TAX_LIBRARY,
        state: reportTotal === null ? 'NO_DATA' : 'OK',
        note: reportTotal === null ? '所选日期范围内没有报告数据（报告没生成、没授权，或报告里没有这段时间）' : `按州、辖区与税种汇总的代收代缴税额；${availableStores} 家店铺已取得报告`,
        total: reportTotal,
      },
      {
        source: 'ORDER_API',
        label: SALES_TAX_SOURCE_LABEL.ORDER_API,
        state: ordersTotal === null ? 'NO_DATA' : 'OK',
        note: ordersTotal === null ? '所选日期范围内订单接口没有税额记录' : '订单上的税额，按下单时间汇总；没有收货州，只用于和报告对账',
        total: ordersTotal,
      },
      {
        source: 'SHIPMENT_REPORT',
        label: SALES_TAX_SOURCE_LABEL.SHIPMENT_REPORT,
        state: 'NOT_CONNECTED',
        note: '尚未接入：亚马逊物流发货报告里的税额需要另行接入，本页暂不使用',
        total: null,
      },
    ]
  }
}
