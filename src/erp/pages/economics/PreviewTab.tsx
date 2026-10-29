import { useState } from 'react'
import { Input, Space, Statistic, Switch } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { EconomicsPreviewFeeGroup, EconomicsPreviewResponse, EconomicsPreviewRow } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { formatNumber } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { PAGE_SIZE, Pager, TabFrame, plainMoney, signedMoney, useCursorStack } from './economics-ui'

// 费用预览（07 章 7.10 第 2 个页签）：官方给出的未来 120 天内费用调整（例如旧库存附加费、仓储费、入库配置费），
// 换算成对每个商品利润的影响 = −单件费用变化 × 预估数量。官方没给预估数量的行算不出影响，写“官方未给预估数量”，不拿 0 代替。

export const previewGroupColumns: ColumnsType<EconomicsPreviewFeeGroup> = [
  { title: '费用类型', dataIndex: 'feeType', render: (value: string) => <span className="erp-num">{value}</span> },
  { title: '行数', dataIndex: 'rows', width: 90, align: 'right', render: (value: number) => <span className="erp-num">{formatNumber(value, { digits: 0 })}</span> },
  { title: '预估金额', dataIndex: 'estimated', width: 140, align: 'right', render: (value: number) => plainMoney(value) },
  { title: '对利润的影响', dataIndex: 'impact', width: 150, align: 'right', render: (value: number | null) => (value === null ? <Muted>官方未给预估数量</Muted> : signedMoney(value)) },
]

export const previewColumns: ColumnsType<EconomicsPreviewRow> = [
  {
    title: '商品',
    key: 'product',
    width: 200,
    render: (_value, row) => (
      <div>
        <span className="erp-num">{row.msku}</span>
        {row.asin ? <span style={{ marginLeft: 8, color: 'rgba(0,0,0,0.45)' }}>{row.asin}</span> : null}
        <div style={{ color: 'rgba(0,0,0,0.55)' }}>{row.storeName}</div>
      </div>
    ),
  },
  { title: '费用类型', dataIndex: 'feeType', width: 220, render: (value: string) => <span className="erp-num">{value}</span> },
  { title: '适用区间', key: 'range', width: 190, render: (_value, row) => <span className="erp-num">{`${row.rangeStart} 至 ${row.rangeEnd}`}</span> },
  { title: '预估金额', dataIndex: 'estimatedAmount', width: 120, align: 'right', render: (value: number) => plainMoney(value) },
  {
    title: '预估数量',
    dataIndex: 'quantity',
    width: 100,
    align: 'right',
    render: (value: number | null) => (value === null ? <Muted>官方未提供</Muted> : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>),
  },
  { title: '单件费用', dataIndex: 'amountPerUnit', width: 110, align: 'right', render: (value: number | null) => plainMoney(value, <Muted>官方未提供</Muted>) },
  { title: '单件费用变化', dataIndex: 'amountPerUnitDelta', width: 130, align: 'right', render: (value: number | null) => (value === null ? <Muted>官方未提供</Muted> : signedMoney(value)) },
  {
    title: '对利润的影响',
    key: 'impact',
    width: 150,
    align: 'right',
    render: (_value, row) => (row.impactState === 'OK' ? signedMoney(row.impact) : row.impactState === 'NO_CHANGE' ? <Muted>官方没有给出费用调整</Muted> : <Muted>官方未给预估数量</Muted>),
  },
]

export function PreviewTab() {
  const [changedOnly, setChangedOnly] = useState(false)
  const [q, setQ] = useState<string | undefined>(undefined)
  const [text, setText] = useState('')
  const paging = useCursorStack()
  const query = useApiQuery<EconomicsPreviewResponse>({
    domain: 'list',
    path: '/finance/economics/preview',
    params: { changedOnly: changedOnly ? 'true' : 'false', q, pageSize: PAGE_SIZE, cursor: paging.cursor },
  })
  return (
    <div>
      <Space wrap style={{ margin: '8px 0' }}>
        <Space>
          <Switch
            aria-label="只看有费用调整的行"
            checked={changedOnly}
            onChange={value => {
              setChangedOnly(value)
              paging.reset()
            }}
          />
          <span>只看有费用调整的行</span>
        </Space>
        <Input.Search
          allowClear
          style={{ width: 220 }}
          placeholder="搜索 SKU 或 ASIN"
          aria-label="搜索商品"
          value={text}
          onChange={event => setText(event.target.value)}
          onSearch={value => {
            setQ(value.trim() || undefined)
            paging.reset()
          }}
        />
      </Space>
      <TabFrame query={query} testId="economics-preview">
        {data => (
          <>
            {data.horizon ? (
              <p style={{ margin: '4px 0', color: 'rgba(0,0,0,0.65)' }}>
                官方预览覆盖 {data.horizon.from} 至 {data.horizon.to}
                {data.queriedAt ? `，最近查询于 ${data.queriedAt.slice(0, 16).replace('T', ' ')}（UTC）` : ''}；金额单位 {data.currency}。
              </p>
            ) : null}
            <Space size={32} wrap style={{ margin: '8px 0' }} data-testid="economics-preview-summary">
              <Statistic title="商品数" value={data.summary.products} />
              <Statistic title="预览行数" value={data.summary.rows} />
              <Statistic title="有费用调整的行" value={data.summary.changedRows} />
              <Statistic title="算不出影响的行" value={data.summary.unknownRows} />
              <Statistic title="合计对利润的影响" formatter={() => (data.summary.totalImpact === null ? <Muted>尚无记录</Muted> : signedMoney(data.summary.totalImpact))} />
            </Space>
            {data.summary.byFeeType.length > 0 ? (
              <>
                <h4 style={{ margin: '12px 0 8px' }}>按费用类型</h4>
                <SimpleGrid<EconomicsPreviewFeeGroup>
                  gridId="economics.preview-tab"
                  columns={previewGroupColumns}
                  rows={data.summary.byFeeType}
                  rowKey={row => row.feeType}
                  emptyState={{ kind: 'empty', domain: '费用类型汇总', prerequisite: '官方预览尚无记录。' }}
                />
              </>
            ) : null}
            <h4 style={{ margin: '16px 0 8px' }}>商品明细</h4>
            <SimpleGrid<EconomicsPreviewRow>
              gridId="economics.preview-tab-2"
              columns={previewColumns}
              rows={data.items}
              rowKey={row => row.key}
              loading={query.isFetching}
              emptyState={{ kind: 'empty', domain: '官方费用预览', prerequisite: data.note ?? '所选条件下没有行。' }}
            />
            <Pager stack={paging.stack} setStack={paging.setStack} pageInfo={data.pageInfo} fetching={query.isFetching} />
          </>
        )}
      </TabFrame>
    </div>
  )
}
