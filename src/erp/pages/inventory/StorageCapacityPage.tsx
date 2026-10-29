import type { ReactNode } from 'react'
import { Alert, Card, Col, Descriptions, Row, Space, Typography } from 'antd'
import type { CapacityCrossing, CapacityRow, CapacitySuggestion, FeeMonth, StorageCapacityResponse } from '@nova/api-contracts'
import { ChartPanel, DataState, FreshnessBar, PageHeader, stateFromError, SimpleGrid } from '../../components'
import { formatMoney } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import type { ScopeOptions } from '../../shell/ScopeBar'
import { crossingColumns, feeColumns, feeTrendOption, hasFeeData, suggestionColumns, utilizationColumns } from './capacity-view'
import { Muted, StateBlock } from './inventory-ui'
import { LimitImportAction } from './LimitImportAction'

// 仓储容量与费用（P2a-09，06 章 6.6）：库容利用率与限额、近 6 个月仓储费、下月预测与库龄跨档提醒、清理建议、尚未接入的项目。
// 利用率来自亚马逊月度仓储费报告（只有比率）；限额与已用量来自文件导入，逐项标注来源。
// 实际发生的库龄附加费、低库存水平费在“费用事件”页查看（P2b-05）；本页暂不汇总实际发生额，这里列明而不是显示 0。

const money = (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : formatMoney(value, 'USD', { digits: 2 }))

function Figure({ title, value, note }: { title: string; value: ReactNode; note: string }) {
  return (
    <div>
      <Typography.Text type="secondary">{title}</Typography.Text>
      <div style={{ fontSize: 24, fontWeight: 600 }}>{value}</div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {note}
      </Typography.Text>
    </div>
  )
}

function Forecast({ data }: { data: StorageCapacityResponse }) {
  const forecast = data.forecast
  return (
    <Card size="small" title="下月预测">
      <Row gutter={16}>
        <Col xs={24} md={8}>
          <Figure title="预计下月仓储费" value={money(forecast.nextMonthStorage)} note={`亚马逊库存规划报告的预估值，覆盖 ${forecast.storageSkuCount} 个 SKU（没有预估的 SKU 不计入）`} />
        </Col>
        <Col xs={24} md={8}>
          <Figure title="库龄附加费预估" value={money(forecast.ageSurchargeEstimate)} note="亚马逊库龄报告的预估值，不是实际扣费" />
        </Col>
        <Col xs={24} md={8}>
          <Figure title="未来 30 天跨档预估增加" value={money(forecast.crossingTotal)} note="按报告里的库龄分桶与各档附加费估算，只含能算出金额的 SKU" />
        </Col>
      </Row>
    </Card>
  )
}

export default function StorageCapacityPage() {
  const query = useApiQuery<StorageCapacityResponse>({ domain: 'list', path: '/inventory/capacity' })
  const options = useApiQuery<ScopeOptions>({ domain: 'reference', path: '/scope/options', scoped: false })
  const stores = (options.data?.stores ?? []).map(store => ({ id: store.id, name: store.name }))

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'inventory.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />
  const data = query.data

  return (
    <div>
      <PageHeader
        title="仓储容量与费用"
        description="库容利用率与限额、近 6 个月仓储费、下月预测与清理建议。利用率来自月度仓储费报告，限额来自导入的库容文件。"
        actions={<LimitImportAction stores={stores} />}
      />
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <FreshnessBar freshness={data.freshness} />
        <StateBlock state={data.state} note={data.note} />
        <Card size="small" title="库容利用率与限额">
          <SimpleGrid<CapacityRow>
            gridId="inventory.storage-capacity-page"
            columns={utilizationColumns}
            rows={data.utilization}
            rowKey={row => `${row.sellerAccountId}|${row.storageType}`}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录：月度仓储费报告同步后显示利用率；导入限额文件后显示限额与已用量' }}
          />
        </Card>
        <ChartPanel
          title="近 6 个月仓储费"
          ariaLabel="近 6 个月仓储费堆叠柱图"
          option={feeTrendOption(data.fees.months)}
          emptyState={hasFeeData(data.fees.months) ? undefined : { kind: 'empty', domain: '仓储费', prerequisite: '亚马逊月度仓储费报告同步后显示；没有记录的月份不画成 0。' }}
        />
        <Card size="small" title="费用明细（按月）">
          <SimpleGrid<FeeMonth>
            gridId="inventory.storage-capacity-page-2"
            columns={feeColumns}
            rows={data.fees.months}
            rowKey={row => row.month}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
          />
        </Card>
        <Forecast data={data} />
        <Card size="small" title="库龄跨档提醒（未来 30 天）">
          <SimpleGrid<CapacityCrossing>
            gridId="inventory.storage-capacity-page-3"
            columns={crossingColumns}
            rows={data.forecast.crossings}
            rowKey={row => `${row.sellerAccountId}|${row.sku}|${row.boundaryDays}`}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '未来 30 天没有即将跨入更高附加费档的库存，或库龄报告尚未同步' }}
          />
        </Card>
        <Card size="small" title="清理建议（占用体积大且卖得慢的 SKU）">
          <SimpleGrid<CapacitySuggestion>
            gridId="inventory.storage-capacity-page-4"
            columns={suggestionColumns}
            rows={data.suggestions}
            rowKey={row => `${row.sellerAccountId}|${row.sku}`}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '没有可清理的 SKU：没有可售天数过长、冗余或库龄风险的记录' }}
          />
        </Card>
        {data.notConnected.length ? (
          <Alert
            type="info"
            showIcon
            message="本页暂未汇总的项目"
            description={
              <Descriptions size="small" column={1}>
                {data.notConnected.map(item => (
                  <Descriptions.Item key={item.key} label={item.label}>
                    {item.note}
                    {item.workPackage ? `（由 ${item.workPackage} 交付）` : ''}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            }
          />
        ) : null}
      </Space>
    </div>
  )
}
