import { SS_METRIC_LABEL, ssColumnId, type BrGranularity, type SsMetric, type SsRow } from '@nova/api-contracts'
import { headerHint, numberColumn, productColumn, type ErpColDef } from '../../components'

// 销量统计的列（P6-25，16 章第 2.2 节）：商品信息、可用库存、周转天数固定在左；每个日期一列；最后一列小计固定在右。
// 没有记录的日期显示“—”，不是 0；周与月的桶以起始日命名，范围边缘的桶只含范围内的天；
// SKU 维度下多个 SKU 共用的 ASIN 没有数值，小计格的提示里写明原因。

/** 行加上“日期列 → 值”的平铺字段：列标识就是字段名，汇总行与排序都按它取值。 */
export type SalesStatRow = SsRow & Record<string, unknown>

export const SS_SORTABLE: Readonly<Record<string, string>> = { product: 'title', total: 'total', availableStock: 'availableStock', turnoverDays: 'turnoverDays' }

export function flatten(row: SsRow, buckets: readonly string[]): SalesStatRow {
  const flat: SalesStatRow = { ...row }
  buckets.forEach((bucket, index) => {
    flat[ssColumnId(bucket)] = row.values[index] ?? null
  })
  return flat
}

export const bucketLabel = (bucket: string, granularity: BrGranularity): string => {
  if (granularity === 'MONTH') return bucket.slice(0, 7)
  return granularity === 'WEEK' ? `${bucket.slice(5)} 起` : bucket.slice(5)
}

export function salesStatColumns(buckets: readonly string[], granularity: BrGranularity, metric: SsMetric, inventoryBasis: string): ErpColDef<SalesStatRow>[] {
  const digits = metric === 'sales' ? 2 : 0
  const columns: ErpColDef<SalesStatRow>[] = [
    productColumn<SalesStatRow>('商品', row => ({ title: row.title, asin: row.asin, sku: row.sku, storeName: row.storeName, imageUrl: row.imageUrl }), { group: '商品信息' }),
    numberColumn<SalesStatRow>('可用库存', 'availableStock', {
      digits: 0,
      pin: 'left',
      width: 110,
      group: '库存',
      ...headerHint(`可用库存口径：${inventoryBasis}（来自库存接口，不随日期范围变化）`),
    }),
    numberColumn<SalesStatRow>('周转天数', 'turnoverDays', {
      digits: 1,
      pin: 'left',
      width: 110,
      group: '库存',
      ...headerHint('周转天数 = 可用库存 ÷（范围内销量 ÷ 范围天数）；范围内没有销量时没有值'),
    }),
  ]
  for (const bucket of buckets) {
    columns.push(
      numberColumn<SalesStatRow>(bucketLabel(bucket, granularity), ssColumnId(bucket) as never, {
        digits,
        minWidth: 84,
        width: 92,
        group: SS_METRIC_LABEL[metric],
        ...headerHint(granularity === 'DAY' ? bucket : `${bucket} 起${granularity === 'WEEK' ? '的一周' : '的一个月'}（范围边缘只含范围内的天）`),
      }),
    )
  }
  columns.push(
    numberColumn<SalesStatRow>('小计', 'total', {
      digits,
      pin: 'right',
      width: 110,
      group: '小计',
      ...headerHint('这一行所有日期列相加（只加有记录的日期）'),
      tooltipValueGetter: params => (params.data?.gap as string | null | undefined) ?? undefined,
    }),
  )
  return columns
}
