import { useCallback, useMemo, useState } from 'react'
import { Alert, Button, Space, Tooltip } from 'antd'
import { ADS_ASIN_STOCK_LABEL, ADS_ASIN_STOCKS, type AdsAsinListResponse, type AdsAsinRow } from '@nova/api-contracts'
import type { FilterField, SearchMode } from '../../components'
import { ASIN_DEFAULT_SORT, ASIN_SORTABLE, asinColumns } from './ads-products-columns'
import { moneyCell, numberCell } from './ads-campaigns-ui'
import { AdsLevelGrid } from './ads-level-grid'

// 广告商品（P3-09，08 章 8.6；P6-23 迁到广告层级统一骨架 AdsLevelGrid）：按“店铺 × ASIN”汇总全部广告，同时看全部销售额、广告销售占比、自然销售额、光环销售额、库存与在投广告数；断货仍在花钱的标红。
// 筛选、区间、分类计数、排序、汇总都在服务端；汇总行取响应的 level 字段（它的 summary 是商品数与断货统计，另有含义）。
// 按 ASIN 暂停或启用全部相关广告、复制到其他广告组没有批量写入口，批量栏置灰并说明原因。广告商品没有对象级趋势接口，末列“分析”置灰并写明原因。

const MODES: SearchMode[] = [{ id: 'contains', label: '商品包含', key: 'q', placeholder: '搜索 ASIN 或商品名称' }]
const FIELDS: FilterField[] = [{ key: 'stock', label: '库存状态', kind: 'select', width: 140, options: ADS_ASIN_STOCKS.map(value => ({ value, label: ADS_ASIN_STOCK_LABEL[value] })) }]
const TREND_REASON = '广告商品是“店铺 × ASIN”的合计，没有对象级趋势接口；请到广告活动或广告组查看趋势'

export default function AdsProductsPage() {
  const [halo, setHalo] = useState<AdsAsinListResponse['halo']>({ state: 'OK', note: null })
  const [profit, setProfit] = useState<AdsAsinListResponse['profit']>({ state: 'NOT_CONNECTED', note: '' })
  const [writeNote, setWriteNote] = useState<string>()
  const columns = useMemo(() => asinColumns(halo, profit), [halo, profit])
  const onFirstPage = useCallback((response: AdsAsinListResponse) => {
    setHalo(response.halo)
    setProfit(response.profit)
    setWriteNote(response.write.note)
  }, [])
  const fieldsOf = useCallback(() => FIELDS, [])

  return (
    <AdsLevelGrid<AdsAsinRow, AdsAsinListResponse>
      level="products"
      testId="ads-products-page"
      title="广告商品"
      description="按 ASIN 汇总全部广告：花费、广告销售额、广告销售占比、自然销售额、光环销售额与库存。指标是所选日期范围内的合计（美元账户）；按 ASIN 批量暂停、启用与复制广告的入口暂未提供，请到广告活动或广告组页面操作。"
      gridId="ads.products"
      path="/ads/products"
      fieldsOf={fieldsOf}
      modes={MODES}
      columns={columns}
      sortableFields={ASIN_SORTABLE}
      defaultSort={ASIN_DEFAULT_SORT}
      getRowId={row => row.key}
      summaryOf={response => response.level}
      emptyDomain="广告商品"
      emptyNote="还没有同步到被推广商品的报表；连接广告账户并同步报表后显示。"
      trendDisabledReason={TREND_REASON}
      onFirstPage={onFirstPage}
      notes={response => <ProductNotes response={response} />}
      renderBulkActions={rows => (
        <Tooltip title={writeNote ?? '按 ASIN 的批量写入暂未提供'}>
          <span>
            <Space>
              <Button size="small" disabled>
                暂停全部相关广告
              </Button>
              <Button size="small" disabled>
                启用全部相关广告
              </Button>
              <Button size="small" disabled>
                复制到其他广告组
              </Button>
              <span style={{ color: 'rgba(0,0,0,0.45)' }}>已选 {rows.length} 个</span>
            </Space>
          </span>
        </Tooltip>
      )}
    />
  )
}

function ProductNotes({ response }: { response: AdsAsinListResponse | null }) {
  if (!response) return null
  const summary = response.summary
  return (
    <>
      {response.metricsTruncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="报表分组超过读取上限，花费较低的商品可能缺失" /> : null}
      {response.halo.state === 'NOT_CONNECTED' && response.state === 'OK' ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={`光环销售额：${response.halo.note}`} /> : null}
      {summary.products > 0 ? (
        <Space size={24} wrap style={{ marginBottom: 8 }} data-testid="ads-products-summary">
          <span>
            商品 <strong>{numberCell(summary.products)}</strong> 个
          </span>
          <span>
            花费 <strong>{moneyCell(summary.spend)}</strong>
          </span>
          <span>
            广告销售额 <strong>{moneyCell(summary.sales)}</strong>
          </span>
          <span style={summary.outOfStock.products > 0 ? { color: '#cf1322' } : undefined}>
            断货商品 {summary.outOfStock.products} 个{summary.outOfStock.products > 0 ? <>，仍花费 {moneyCell(summary.outOfStock.spend)}</> : null}
          </span>
        </Space>
      ) : null}
      <div style={{ marginBottom: 8, color: 'rgba(0,0,0,0.45)', fontSize: 12 }} data-testid="ads-products-basis">
        {response.organicBasis}；花费为空的报表行（来源没有给花费）没有计入。
      </div>
    </>
  )
}
