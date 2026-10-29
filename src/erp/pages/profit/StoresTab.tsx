import type { ColumnsType } from 'antd/es/table'
import type { ProfitStoreRow, ProfitStoresResponse } from '@nova/api-contracts'
import { RowDetailDrawer, SimpleGrid, useRowDetail } from '../../components'
import { formatNumber } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { money } from '../orders/orders-ui'
import { BridgeTable, ProfitFrame, margin, signedMoney } from './profit-ui'

// 店铺利润（07 章 7.9 第 2 个页签）：范围内每个店铺一行（含没有数据的店铺），展开看这个店铺自己的利润桥。
// 店铺净利润含店铺级费用与账户级广告；该店铺有一行缺成本时净利润不给。

const columns: ColumnsType<ProfitStoreRow> = [
  { title: '店铺', dataIndex: 'storeName', width: 200 },
  {
    title: '销量（件）',
    dataIndex: 'units',
    width: 110,
    align: 'right',
    render: (value: number, row) => (row.revenue === null ? '' : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>),
  },
  { title: '销售额', dataIndex: 'revenue', width: 140, align: 'right', render: (value: number | null) => money(value) },
  { title: '净利润', dataIndex: 'netProfit', width: 140, align: 'right', render: (value: number | null) => signedMoney(value) },
  { title: '利润率', dataIndex: 'margin', width: 100, align: 'right', render: (value: number | null) => margin(value) },
]

export function StoresTab({ recognition }: { recognition: string }) {
  const query = useApiQuery<ProfitStoresResponse>({ domain: 'analytics', path: '/profit/stores', params: { recognition } })
  const detail = useRowDetail()
  return (
    <ProfitFrame query={query} testId="profit-stores">
      {data => (
        <>
          <SimpleGrid<ProfitStoreRow>
            gridId="profit.stores"
            columns={columns}
            rows={data.items}
            rowKey={row => row.sellerAccountId}
            onRowOpen={row => detail.open(row.sellerAccountId)}
            emptyState={{ kind: 'empty', domain: '店铺利润', prerequisite: '没有可看的店铺；店铺授权并完成订单与财务同步后显示。' }}
          />
          <RowDetailDrawer rows={data.items} rowKey={row => row.sellerAccountId} openKey={detail.openKey} onClose={detail.close} title={row => `利润桥：${row.storeName}`} width={860}>
            {row => <BridgeTable view={row.bridge} />}
          </RowDetailDrawer>
        </>
      )}
    </ProfitFrame>
  )
}
