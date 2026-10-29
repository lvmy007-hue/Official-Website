import type { ColumnsType } from 'antd/es/table'
import { Card, Col, Row, Statistic } from 'antd'
import type { ProfitBridgeCompareResponse, ProfitBridgeCompareRow, ProfitSummary } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { formatMoney, formatPercent } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { money } from '../orders/orders-ui'
import { ProfitFrame, StateTag, signedMoney } from './profit-ui'

// 利润桥对比（07 章 7.9 第 6 个页签）：当前期对比另一期（全局“对比期”；没选就用上一期），逐项给出对净利润的影响。
// 任一期某项没有数据、没接入或没权限，这一项不给影响值（不拿 0 当“上期没有”）；任一期净利润算不出，净利润变化也不给。

const MODE_LABEL = { previous: '上一期', yoy: '去年同期', custom: '自选对比期' } as const

const columns: ColumnsType<ProfitBridgeCompareRow> = [
  { title: '项目', dataIndex: 'label', width: 150 },
  { title: '对比期', dataIndex: 'base', width: 130, align: 'right', render: (value: number | null) => money(value) },
  { title: '当前期', dataIndex: 'current', width: 130, align: 'right', render: (value: number | null) => money(value) },
  { title: '对净利润的影响', dataIndex: 'impact', width: 160, align: 'right', render: (value: number | null) => (value === null ? <Muted>不给（有一期没有数据）</Muted> : signedMoney(value)) },
  { title: '状态', dataIndex: 'state', width: 100, render: (_value, row) => <StateTag state={row.state} /> },
]

const netText = (summary: ProfitSummary) => (summary.netProfit === null ? '尚无记录' : formatMoney(summary.netProfit, 'USD', { digits: 2 }))

function Period({ title, range, summary }: { title: string; range: { from: string; to: string }; summary: ProfitSummary }) {
  return (
    <Col xs={24} md={12}>
      <Card size="small" title={`${title}：${range.from} 至 ${range.to}`}>
        <Row gutter={12}>
          <Col span={8}>
            <Statistic title="销售额" value={summary.revenue === null ? '尚无记录' : formatMoney(summary.revenue, 'USD', { digits: 2 })} />
          </Col>
          <Col span={8}>
            <Statistic title="净利润" value={netText(summary)} />
          </Col>
          <Col span={8}>
            <Statistic title="利润率" value={summary.margin === null ? '尚无记录' : formatPercent(summary.margin, { digits: 1 })} />
          </Col>
        </Row>
      </Card>
    </Col>
  )
}

export function BridgeCompareTab({ recognition }: { recognition: string }) {
  const query = useApiQuery<ProfitBridgeCompareResponse>({ domain: 'analytics', path: '/profit/bridge', params: { recognition } })
  return (
    <ProfitFrame query={query} testId="profit-compare">
      {data => (
        <>
          <Row gutter={[12, 12]} style={{ margin: '8px 0 12px' }}>
            <Period title="对比期" range={data.baseRange} summary={data.base} />
            <Period title="当前期" range={data.range} summary={data.current} />
          </Row>
          <p data-testid="compare-net">
            对比方式：{MODE_LABEL[data.compareMode]}。净利润变化：{data.netImpact === null ? <Muted>不给（至少一期净利润算不出或没有数据）</Muted> : signedMoney(data.netImpact)}
            {data.netImpact !== null && data.unexplained !== null && Math.abs(data.unexplained) >= 0.01 ? (
              <Muted>；逐项影响之和与它相差 {formatMoney(data.unexplained, 'USD', { digits: 2 })}（舍入或尚未接入的项目造成）</Muted>
            ) : null}
          </p>
          <SimpleGrid<ProfitBridgeCompareRow>
            gridId="profit.bridge-compare-tab"
            columns={columns}
            rows={data.rows}
            rowKey={row => row.key}
            emptyState={{ kind: 'empty', domain: '利润桥对比', prerequisite: '所选两期都没有利润数据。' }}
          />
        </>
      )}
    </ProfitFrame>
  )
}
