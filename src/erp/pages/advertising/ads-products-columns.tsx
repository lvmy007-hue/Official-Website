import { Image, Space, Tag, Tooltip } from 'antd'
import { ADS_ASIN_SORTS, ADS_ASIN_STOCK_LABEL, ADS_ASIN_UNBOUND_NOTE, type AdsAsinListResponse, type AdsAsinRow } from '@nova/api-contracts'
import { RIGHT_ALIGNED, renderColumn, type ErpColDef } from '../../components'
import type { SortSpec } from '../../components/table/cursor-datasource'
import { Muted } from '../inventory/inventory-ui'
import { moneyCell, NONE, numberCell, percentCell } from './ads-campaigns-ui'
import { SUMMARY_FORMAT, levelMetricColumns } from './ads-level-columns'

// 广告商品列表的列（08 章 8.6；P6-23 迁到统一骨架）：一行是一个“店铺 × ASIN”，指标是所选范围内全部广告的合计（美元）。
// 没有数据的列写“尚无记录”，没有来源的列写“尚未接入”并带原因，不是 0；断货仍在花钱的花费标红。

export const ASIN_SORTABLE = Object.fromEntries(ADS_ASIN_SORTS.map(field => [field, field])) as Readonly<Record<(typeof ADS_ASIN_SORTS)[number], string>>
export const ASIN_DEFAULT_SORT: SortSpec = { field: 'spend', direction: 'desc' }

const NOT_CONNECTED = (note: string, text = '尚未接入') => (
  <Tooltip title={note}>
    <span>
      <Muted>{text}</Muted>
    </span>
  </Tooltip>
)

function StockCell({ row }: { row: AdsAsinRow }) {
  if (row.stock === 'UNKNOWN')
    return (
      <Tooltip title={row.storeId ? '没有这个商品的库存快照' : ADS_ASIN_UNBOUND_NOTE}>
        <span>
          <Muted>{ADS_ASIN_STOCK_LABEL.UNKNOWN}</Muted>
        </span>
      </Tooltip>
    )
  return (
    <span>
      <Tag color={row.stock === 'OUT_OF_STOCK' ? 'error' : 'success'} bordered={false}>
        {ADS_ASIN_STOCK_LABEL[row.stock]}
      </Tag>
      {row.sellable === null ? null : <span className="erp-num">{row.sellable}</span>}
    </span>
  )
}

const right = { ...RIGHT_ALIGNED }

export function asinColumns(halo: AdsAsinListResponse['halo'], profit: AdsAsinListResponse['profit']): ErpColDef<AdsAsinRow>[] {
  // 通用指标列里的“花费”换成断货标红的写法；商品没有“展示、点击、点击率、单次点击成本、转化率”之外的特殊列，其余沿用
  const metrics = levelMetricColumns<AdsAsinRow>().map(column =>
    column.colId === 'spend'
      ? renderColumn<AdsAsinRow>(
          '花费',
          'spend',
          row => (row.stock === 'OUT_OF_STOCK' && (row.totals.spend ?? 0) > 0 ? <span style={{ color: '#cf1322' }}>{moneyCell(row.totals.spend)}</span> : moneyCell(row.totals.spend)),
          { group: '表现', width: 110, metric: 'M-007', ...SUMMARY_FORMAT.money, ...right },
        )
      : column,
  )
  return [
    renderColumn<AdsAsinRow>(
      '商品',
      'asin',
      row => (
        <Space align="start">
          {row.imageUrl ? <Image src={row.imageUrl} alt={row.asin} width={36} height={36} style={{ objectFit: 'contain' }} /> : null}
          <div>
            <div className="erp-num">{row.asin}</div>
            <div>{row.title ?? <Muted>商品资料尚未同步</Muted>}</div>
            <Muted>{row.storeName ?? '未绑定店铺'}</Muted>
          </div>
        </Space>
      ),
      { group: '商品', pin: 'left', width: 300 },
    ),
    renderColumn<AdsAsinRow>('库存', 'stock', row => <StockCell row={row} />, { group: '商品', width: 140, sortable: false }),
    ...metrics,
    renderColumn<AdsAsinRow>('全部销售额', 'totalSales', row => moneyCell(row.totalSales), { group: '销售占比', width: 120, ...right }),
    renderColumn<AdsAsinRow>('广告销售占比', 'adsShare', row => percentCell(row.adsShare), { group: '销售占比', width: 120, ...right }),
    renderColumn<AdsAsinRow>(
      '自然销售额',
      'organicSales',
      row =>
        row.organicIssue ? (
          <Tooltip title="广告销售额大于全部销售额（两个口径统计时点不同），不给自然销售额">
            <Tag color="warning" bordered={false}>
              口径不符
            </Tag>
          </Tooltip>
        ) : (
          moneyCell(row.organicSales)
        ),
      { group: '销售占比', width: 120, metric: 'M-129', ...right },
    ),
    renderColumn<AdsAsinRow>('光环销售额', 'haloSales', row => (halo.state === 'NOT_CONNECTED' ? NOT_CONNECTED(halo.note ?? '', '尚无记录') : moneyCell(row.haloSales)), {
      group: '销售占比',
      width: 120,
      sortable: false,
      ...right,
    }),
    renderColumn<AdsAsinRow>('广告分摊后利润', 'profit', () => NOT_CONNECTED(profit.note), { group: '销售占比', width: 130, sortable: false }),
    renderColumn<AdsAsinRow>('活动数', 'campaigns', row => numberCell(row.campaigns), { group: '广告', width: 90, ...right }),
    renderColumn<AdsAsinRow>(
      '在投广告',
      'ads',
      row =>
        row.ads ? (
          <Tooltip title="在投 / 全部广告（广告表里这个 ASIN 的广告数）">
            <span className="erp-num">
              {row.ads.enabled} / {row.ads.total}
            </span>
          </Tooltip>
        ) : (
          NONE
        ),
      { group: '广告', width: 100, sortable: false, ...right },
    ),
  ]
}
