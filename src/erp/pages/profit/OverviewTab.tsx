import { useMemo } from 'react'
import { Card, Col, Row, Statistic, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { ProfitFlagCount, ProfitOverviewResponse, ProfitSummary } from '@nova/api-contracts'
import { ChartPanel, SimpleGrid } from '../../components'
import { formatDateTime, formatMoney, formatNumber, formatPercent } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { DictionarySection } from './DictionarySection'
import { buildBridgeOption, buildTrendOption } from './profit-options'
import { BridgeTable, ProfitFrame } from './profit-ui'

// 利润总览（07 章 7.9 第 1 个页签）：核心指标、利润桥瀑布与明细、趋势、问题标记汇总、口径说明。
// 净利润在范围内只要有一行因缺成本算不出，就整体不给，并写明几行算不出、已能算出的部分是多少，不拿部分数字冒充整体。

function Kpis({ summary }: { summary: ProfitSummary }) {
  const profitText = summary.netProfit === null ? '尚无记录' : formatMoney(summary.netProfit, 'USD', { digits: 2 })
  return (
    <Row gutter={[12, 12]} style={{ margin: '8px 0 12px' }} data-testid="profit-kpis">
      <Col xs={12} md={6}>
        <Card size="small">
          <Statistic title="销售额" value={summary.revenue === null ? '尚无记录' : formatMoney(summary.revenue, 'USD', { digits: 2 })} />
        </Card>
      </Col>
      <Col xs={12} md={6}>
        <Card size="small">
          <Statistic title="净利润" value={profitText} valueStyle={summary.netProfit !== null && summary.netProfit < 0 ? { color: '#cf1322' } : undefined} />
          {summary.netProfit === null && summary.incompleteRows > 0 ? (
            <Typography.Text type="secondary" data-testid="profit-partial">
              有 {summary.incompleteRows} 行缺成本算不出，已能算出的部分 {summary.coveredProfit === null ? '尚无记录' : formatMoney(summary.coveredProfit, 'USD', { digits: 2 })}（只是部分）
            </Typography.Text>
          ) : null}
        </Card>
      </Col>
      <Col xs={12} md={4}>
        <Card size="small">
          <Statistic title="利润率" value={summary.margin === null ? '尚无记录' : formatPercent(summary.margin, { digits: 1 })} />
        </Card>
      </Col>
      <Col xs={12} md={4}>
        <Card size="small">
          <Statistic title="销量（件）" value={formatNumber(summary.units, { digits: 0 })} />
        </Card>
      </Col>
      {summary.costCoverage !== undefined ? (
        <Col xs={12} md={4}>
          <Card size="small">
            <Statistic title="成本覆盖率" value={summary.costCoverage === null ? '尚无记录' : formatPercent(summary.costCoverage, { digits: 1 })} />
          </Card>
        </Col>
      ) : null}
    </Row>
  )
}

const flagColumns: ColumnsType<ProfitFlagCount> = [
  { title: '问题', dataIndex: 'label', width: 180, render: (value: string, row) => <span style={row.severity === 'WARN' ? { color: '#d46b08' } : undefined}>{value}</span> },
  { title: '涉及行数', dataIndex: 'rows', width: 110, align: 'right', render: (value: number) => <span className="erp-num">{formatNumber(value, { digits: 0 })}</span> },
  { title: '含义', dataIndex: 'note' },
]

function Body({ data }: { data: ProfitOverviewResponse }) {
  const bridgeOption = useMemo(() => buildBridgeOption(data.bridge), [data.bridge])
  const trendOption = useMemo(() => buildTrendOption(data.trend), [data.trend])
  const empty = data.state === 'NO_DATA'
  const flags = data.flags.filter(flag => flag.rows > 0)
  return (
    <>
      <Kpis summary={data.summary} />
      <ChartPanel
        title="利润桥"
        ariaLabel="从销售额到净利润的利润桥瀑布图"
        option={bridgeOption}
        height={300}
        emptyState={empty ? { kind: 'empty', domain: '利润桥', prerequisite: '所选范围内尚无利润数据。' } : undefined}
      />
      <div style={{ margin: '12px 0' }}>
        <BridgeTable view={data.bridge} testId="profit-bridge-table" />
      </div>
      {data.dictionary ? <DictionarySection view={data.dictionary} /> : null}
      <ChartPanel
        title="销售额与净利润趋势"
        ariaLabel="每日销售额与净利润趋势图"
        option={trendOption}
        emptyState={data.trend.length === 0 ? { kind: 'empty', domain: '利润趋势', prerequisite: '所选范围内尚无利润数据。' } : undefined}
      />
      <h4 style={{ margin: '16px 0 8px' }}>问题标记汇总</h4>
      <SimpleGrid<ProfitFlagCount>
        gridId="profit.overview-tab"
        columns={flagColumns}
        rows={flags}
        rowKey={row => row.flag}
        emptyState={{ kind: 'empty', domain: '问题标记', prerequisite: empty ? '所选范围内尚无利润数据。' : '所选范围内没有带问题标记的利润行。' }}
      />
      <h4 style={{ margin: '16px 0 8px' }}>口径说明</h4>
      <ul data-testid="profit-notes" style={{ margin: 0, paddingLeft: 20 }}>
        {data.notes.map(note => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      <p style={{ marginTop: 8 }}>
        <Muted>{data.refreshedAt ? `利润日表最近刷新：${formatDateTime(data.refreshedAt)}；计算版本 ${data.metricVersion}` : `利润日表尚无刷新记录；计算版本 ${data.metricVersion}`}</Muted>
      </p>
    </>
  )
}

export function OverviewTab({ recognition }: { recognition: string }) {
  const query = useApiQuery<ProfitOverviewResponse>({ domain: 'analytics', path: '/profit/overview', params: { recognition } })
  return (
    <ProfitFrame query={query} testId="profit-overview">
      {data => <Body data={data} />}
    </ProfitFrame>
  )
}
