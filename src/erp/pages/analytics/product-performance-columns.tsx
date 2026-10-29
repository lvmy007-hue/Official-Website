import { PP_FAST_KEYS, PP_GROUP_LABEL, PP_METRICS, PP_SLOW_KEYS, type PpMetricInfo, type PpMetricKey, type PpRow } from '@nova/api-contracts'
import { dualRowColumn, miniTrendColumn, moneyColumn, numberColumn, percentColumn, productColumn, type AsyncColumnSpec, type ErpColDef } from '../../components'
import type { DualFormat } from '../../components/table/cell-types'

// 商品表现宽表的列（P6-22，16 章第 2.1 节）：商品信息固定在左；快指标是“本期、上期、涨跌”的双行单元格；
// 迷你趋势与慢指标（库存、售后）是异步列，主数据返回后只对可见行批量请求。列头问号（metric）从指标字典取口径。

export type PpCaps = { profit: boolean; cost: boolean; ads: boolean; inventory: boolean }

export const allowedBy = (caps: PpCaps, require: PpMetricInfo['require']) => require === null || caps[require]
const info = (key: PpMetricKey): PpMetricInfo => PP_METRICS[key]

const formatOf = (item: PpMetricInfo): DualFormat => {
  if (item.format === 'money') return { kind: 'money' }
  if (item.format === 'percent') return { kind: 'percent', digits: 1 }
  return { kind: 'number', digits: item.format === 'decimal' ? 1 : 0 }
}

/** 白名单：列标识 → 服务端排序字段。商品列按名称，快指标按本期值，没有来源的指标不可排序。 */
export const PP_SORTABLE: Readonly<Record<string, string>> = {
  product: 'title',
  ...Object.fromEntries(PP_FAST_KEYS.filter(key => !('gap' in info(key))).map(key => [key, key])),
}

export type PpAsyncFetchers = { slow: AsyncColumnSpec['fetch']; trend: AsyncColumnSpec['fetch'] }

export function productPerformanceColumns(caps: PpCaps, fetchers: PpAsyncFetchers): ErpColDef<PpRow>[] {
  const columns: ErpColDef<PpRow>[] = [
    productColumn<PpRow>('商品', row => ({ title: row.title, asin: row.asin, sku: row.sku, storeName: row.storeName, imageUrl: row.imageUrl }), { group: '商品信息' }),
  ]
  for (const key of PP_FAST_KEYS) {
    const item = info(key)
    if (!allowedBy(caps, item.require)) continue
    columns.push(
      dualRowColumn<PpRow>(item.label, {
        colId: key,
        group: PP_GROUP_LABEL[item.group],
        metric: item.metric,
        current: row => row.metrics[key]?.value ?? null,
        previous: row => row.metrics[key]?.previous ?? null,
        change: row => row.metrics[key]?.change ?? null,
        format: formatOf(item),
        goodWhen: item.goodWhen,
      }),
    )
  }
  {
    columns.push(
      miniTrendColumn<PpRow>('销售额趋势', () => undefined, {
        colId: 'trend',
        field: 'trend',
        group: PP_GROUP_LABEL.sales,
        async: { key: 'trend', fetch: fetchers.trend },
      } as unknown as ErpColDef<PpRow>),
    )
  }
  for (const key of PP_SLOW_KEYS) {
    const item = info(key)
    if (!allowedBy(caps, item.require)) continue
    const extra = { colId: key, field: key, group: PP_GROUP_LABEL[item.group], metric: item.metric, async: { key: 'slow', fetch: fetchers.slow } } as unknown as ErpColDef<PpRow>
    columns.push(
      item.format === 'percent'
        ? percentColumn<PpRow>(item.label, key as never, { digits: 1, ...extra })
        : item.format === 'money'
          ? moneyColumn<PpRow>(item.label, key as never, extra)
          : numberColumn<PpRow>(item.label, key as never, { digits: item.format === 'decimal' ? 1 : 0, ...extra }),
    )
  }
  return columns
}
