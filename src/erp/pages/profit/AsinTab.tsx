import { useMemo } from 'react'
import { Alert, Collapse } from 'antd'
import type { ProfitGroupRow, ProfitGroupsResponse } from '@nova/api-contracts'
import { RowDetailDrawer, SimpleGrid, useRowDetail } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { GroupExpanded, groupColumns } from './asin-columns'
import { GroupsToolbar, Pager, useGroupPaging } from './groups-controls'
import { BridgeTable, ProfitFrame } from './profit-ui'

// ASIN 利润（07 章 7.9 第 3 个页签）：按 SKU、ASIN、父体汇总；搜索、排序、分页都在服务端；展开看单位经济、成本折算明细与官方对照。
// 不属于任何 SKU 的店铺级费用与账户级广告另列在表下方，表内各行合计加上它才等于总览。

export function AsinTab({ recognition }: { recognition: string }) {
  const paging = useGroupPaging()
  const detail = useRowDetail()
  const query = useApiQuery<ProfitGroupsResponse>({ domain: 'list', path: '/profit/asins', params: { recognition, ...paging.params } })
  const withCost = query.data?.items.some(row => row.costCoverage !== undefined) ?? false
  const columns = useMemo(() => groupColumns(withCost), [withCost])
  const filtered = Boolean(paging.filters.q)
  return (
    <div>
      <GroupsToolbar filters={paging.filters} set={paging.set} />
      <ProfitFrame query={query} testId="profit-asins">
        {data => (
          <>
            {data.truncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="商品数量超过读取上限，列表可能不完整" description="请缩小日期范围或选择店铺后再看。" /> : null}
            <SimpleGrid<ProfitGroupRow>
              gridId="profit.asins"
              columns={columns}
              rows={data.items}
              rowKey={row => row.key}
              loading={query.isFetching}
              onRowOpen={row => detail.open(row.key)}
              emptyState={{ kind: 'empty', domain: '商品利润', prerequisite: filtered ? '没有符合搜索条件的商品。' : (data.note ?? '所选范围内尚无利润数据。') }}
            />
            <RowDetailDrawer rows={data.items} rowKey={row => row.key} openKey={detail.openKey} onClose={detail.close} title={row => `利润明细：${row.key}`} width={860}>
              {row => <GroupExpanded row={row} />}
            </RowDetailDrawer>
            <Pager stack={paging.stack} setStack={paging.setStack} pageInfo={data.pageInfo} fetching={query.isFetching} />
            {data.storeLevel ? (
              <Collapse
                style={{ marginTop: 12 }}
                items={[{ key: 'store-level', label: '店铺级费用与账户级广告（不属于任何 SKU）', children: <BridgeTable view={data.storeLevel} testId="profit-store-level" /> }]}
              />
            ) : null}
          </>
        )}
      </ProfitFrame>
    </div>
  )
}
