import type { ColumnsType } from 'antd/es/table'
import { Alert, Tag } from 'antd'
import { PROFIT_ADS_VERDICT_LABEL, type ProfitAdsRow, type ProfitAdsStoreRow, type ProfitAdsResponse, type ProfitAdsVerdict } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { money } from '../orders/orders-ui'
import { GroupsToolbar, Pager, useGroupPaging } from './groups-controls'
import { ProfitFrame, margin, signedMoney } from './profit-ui'

// 广告后利润（07 章 7.9 第 4 个页签）：店铺层面看广告花费占比与广告前后的净利润；商品层面看广告分摊后是否仍盈利。
// 广告分摊到商品（P3-16）：先按广告商品报表归属到 ASIN，剩余按销售额或销量分摊；范围内没有分摊结果（广告未接入）时，商品行的“广告分摊”写“广告尚未分摊”，不拿 0 冒充。

const VERDICT_COLOR: Record<ProfitAdsVerdict, string> = { PROFIT_AFTER_ADS: 'success', LOSS_AFTER_ADS: 'error', NOT_ALLOCATED: 'default', NO_COST: 'warning' }

const storeColumns: ColumnsType<ProfitAdsStoreRow> = [
  { title: '店铺', dataIndex: 'storeName', width: 180 },
  { title: '销售额', dataIndex: 'revenue', width: 130, align: 'right', render: (value: number | null) => money(value) },
  { title: '广告花费（账户合计）', dataIndex: 'adsSpend', width: 160, align: 'right', render: (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : money(value)) },
  { title: '广告花费占销售额', dataIndex: 'adsShare', width: 150, align: 'right', render: (value: number | null) => margin(value) },
  { title: '广告前净利润', dataIndex: 'profitBeforeAds', width: 140, align: 'right', render: (value: number | null) => signedMoney(value) },
  { title: '广告后净利润', dataIndex: 'netProfit', width: 140, align: 'right', render: (value: number | null) => signedMoney(value) },
]

const itemColumns: ColumnsType<ProfitAdsRow> = [
  {
    title: '商品',
    key: 'product',
    render: (_value, row) => (
      <div>
        <span className="erp-num">
          {row.productId && row.asin ? (
            <LiveLink component="Asin360Page" id={row.productId}>
              {row.asin}
            </LiveLink>
          ) : (
            (row.asin ?? '—')
          )}
        </span>
        {row.sku ? <span style={{ marginLeft: 8, color: 'rgba(0,0,0,0.45)' }}>{row.sku}</span> : null}
        <div style={{ color: 'rgba(0,0,0,0.65)' }}>{row.title ?? <Muted>尚无商品名</Muted>}</div>
      </div>
    ),
  },
  { title: '销售额', dataIndex: 'revenue', width: 120, align: 'right', render: (value: number) => money(value) },
  { title: '广告分摊', dataIndex: 'adsAllocated', width: 120, align: 'right', render: (value: number | null) => (value === null ? <Muted>广告尚未分摊</Muted> : money(value)) },
  { title: '广告前净利润', dataIndex: 'profitBeforeAds', width: 130, align: 'right', render: (value: number | null) => signedMoney(value) },
  { title: '广告后净利润', dataIndex: 'profit', width: 130, align: 'right', render: (value: number | null) => signedMoney(value) },
  { title: '广告占比', dataIndex: 'adsShare', width: 100, align: 'right', render: (value: number | null) => margin(value) },
  {
    title: '结论',
    dataIndex: 'verdict',
    width: 150,
    render: (value: ProfitAdsVerdict) => (
      <Tag color={VERDICT_COLOR[value]} bordered={false}>
        {PROFIT_ADS_VERDICT_LABEL[value]}
      </Tag>
    ),
  },
]

export function AdsTab({ recognition }: { recognition: string }) {
  const paging = useGroupPaging({ by: 'SKU', sort: 'profit' })
  const query = useApiQuery<ProfitAdsResponse>({ domain: 'list', path: '/profit/ads', params: { recognition, ...paging.params } })
  return (
    <div>
      <GroupsToolbar filters={paging.filters} set={paging.set} />
      <ProfitFrame query={query} testId="profit-ads">
        {data => (
          <>
            <Alert
              type={data.allocation.state === 'ALLOCATED' ? 'success' : 'info'}
              showIcon
              style={{ marginBottom: 8 }}
              message={data.allocation.state === 'ALLOCATED' ? '广告已分摊到商品' : '广告尚未分摊到商品'}
              description={data.allocation.note}
              data-testid="ads-allocation"
            />
            {data.truncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="商品数量超过读取上限，列表可能不完整" /> : null}
            <h4 style={{ margin: '8px 0' }}>店铺层面</h4>
            <SimpleGrid<ProfitAdsStoreRow>
              gridId="profit.ads-tab"
              columns={storeColumns}
              rows={data.stores}
              rowKey={row => row.sellerAccountId}
              emptyState={{ kind: 'empty', domain: '店铺广告', prerequisite: '没有可看的店铺。' }}
            />
            <h4 style={{ margin: '16px 0 8px' }}>商品层面</h4>
            <SimpleGrid<ProfitAdsRow>
              gridId="profit.ads-tab-2"
              columns={itemColumns}
              rows={data.items}
              rowKey={row => row.key}
              loading={query.isFetching}
              emptyState={{ kind: 'empty', domain: '商品广告后利润', prerequisite: data.note ?? '所选范围内尚无利润数据。' }}
            />
            <Pager stack={paging.stack} setStack={paging.setStack} pageInfo={data.pageInfo} fetching={query.isFetching} />
          </>
        )}
      </ProfitFrame>
    </div>
  )
}
