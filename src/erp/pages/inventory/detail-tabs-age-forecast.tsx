import { Alert, Descriptions, Space, Tag, Timeline, Typography } from 'antd'
import type { EChartsOption } from 'echarts'
import type { AgeCrossing, InventoryAgeFeesResponse, InventoryForecastResponse } from '@nova/api-contracts'
import { ChartPanel, EstimateTag, SimpleGrid } from '../../components'
import { formatMoney, formatNumber } from '../../format'
import { QueryBody, useDetailQuery } from './detail-hooks'
import { Muted, StateBlock } from './inventory-ui'

// 库存详情的“库龄与费用”与“预测”页签。库龄跨档时间线与费用预估都是模型估算，页面逐项标注并写明窗口与单价的推算方式。

const money = (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMoney(value, 'USD', { digits: 2 })}</span>)

function CrossingTimeline({ crossings }: { crossings: AgeCrossing[] }) {
  if (crossings.length === 0) return <Typography.Text type="secondary">当前没有库存即将进入更高库龄档</Typography.Text>
  return (
    <Timeline
      items={crossings.map(item => ({
        color: item.likelyCrossed ? 'gray' : item.feeTier ? 'red' : 'blue',
        children: (
          <Space direction="vertical" size={0}>
            <span>
              <strong>{item.qty} 件</strong> 将进入 <strong>{item.toLabel}</strong>（第 {item.boundaryDays} 天起）
              {item.feeTier ? (
                <Tag color="warning" bordered={false} style={{ marginLeft: 4 }}>
                  收库龄附加费
                </Tag>
              ) : (
                <Tag bordered={false} style={{ marginLeft: 4 }}>
                  不收库龄附加费
                </Tag>
              )}
              {item.likelyCrossed ? <Tag bordered={false}>窗口已过，待下一份快照确认</Tag> : null}
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              预计跨档窗口：{item.earliestDate} 至 {item.latestDate}（报告只给分段数量，不给每件的库龄，只能给窗口）
            </Typography.Text>
            {item.estimatedIncrease !== null ? (
              <span>
                预计新增库龄附加费 {formatMoney(item.estimatedIncrease, 'USD', { digits: 2 })} <EstimateTag method="跨档数量 × 本 SKU 目标档当前平均单价（目标档预估费 ÷ 目标档数量）" />
              </span>
            ) : item.note ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {item.note}
              </Typography.Text>
            ) : null}
          </Space>
        ),
      }))}
    />
  )
}

function ageBucketOption(data: InventoryAgeFeesResponse): EChartsOption {
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 56, right: 16, top: 16, bottom: 28 },
    xAxis: { type: 'category', data: data.buckets.map(bucket => bucket.label) },
    yAxis: { type: 'value', minInterval: 1 },
    series: [{ name: '件数', type: 'bar', data: data.buckets.map(bucket => bucket.qty), tooltip: { valueFormatter: (value: unknown) => formatNumber(Number(value), { digits: 0 }) } }],
  }
}

export function AgeFeesTab({ id }: { id: string }) {
  const query = useDetailQuery<InventoryAgeFeesResponse>(id, 'age-fees')
  return (
    <QueryBody query={query}>
      {data => (
        <StateBlock state={data.state} note={data.note}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <ChartPanel
              title={`库龄分布（快照 ${data.snapshotDate ?? '—'}${data.granularity === 'COARSE' ? '，报告未给细分段' : ''}）`}
              ariaLabel="库龄分布柱图"
              option={ageBucketOption(data)}
              height={220}
            />
            <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered>
              <Descriptions.Item label="库龄附加费预估（月）">{money(data.surchargeEstimate)}</Descriptions.Item>
              <Descriptions.Item label="6 个月以上长期仓储费预估">{money(data.longTerm6Month)}</Descriptions.Item>
              <Descriptions.Item label="12 个月以上长期仓储费预估">{money(data.longTerm12Month)}</Descriptions.Item>
            </Descriptions>
            <SimpleGrid
              gridId="inventory.detail-tabs-age-forecast"
              columns={[
                { title: '库龄附加费分档', dataIndex: 'label' },
                { title: '预估金额', dataIndex: 'amount', align: 'right', render: (value: number | null) => money(value) },
              ]}
              rows={data.bands}
              rowKey={row => row.label}
              emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无库存规划报告里的库龄附加费分档预估' }}
            />
            <div>
              <Typography.Title level={5}>跨档时间线</Typography.Title>
              <CrossingTimeline crossings={data.crossings} />
            </div>
          </Space>
        </StateBlock>
      )}
    </QueryBody>
  )
}

export function forecastOption(data: InventoryForecastResponse): EChartsOption {
  const dates = [...data.history.map(point => point.date), ...data.forecast.map(point => point.date)]
  const pad = (length: number) => Array<null>(length).fill(null)
  const future = (pick: (point: InventoryForecastResponse['forecast'][number]) => number | null) => [...pad(data.history.length), ...data.forecast.map(pick)]
  const dashed = { type: 'dashed' as const }
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 56, right: 16, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: dates },
    yAxis: { type: 'value', minInterval: 1 },
    series: [
      { name: '历史日销', type: 'line', data: [...data.history.map(point => point.units), ...pad(data.forecast.length)], showSymbol: false, connectNulls: false },
      { name: '断货日', type: 'scatter', symbolSize: 9, itemStyle: { color: '#cf1322' }, data: [...data.history.map(point => (point.stockout ? point.units : null)), ...pad(data.forecast.length)] },
      { name: '预测（中）', type: 'line', data: future(point => point.mid), showSymbol: false, lineStyle: dashed },
      { name: '预测（低）', type: 'line', data: future(point => point.low), showSymbol: false, lineStyle: { type: 'dotted' } },
      { name: '预测（高）', type: 'line', data: future(point => point.high), showSymbol: false, lineStyle: { type: 'dotted' } },
    ],
  }
}

export function ForecastTab({ id }: { id: string }) {
  const query = useDetailQuery<InventoryForecastResponse>(id, 'forecast')
  return (
    <QueryBody query={query}>
      {data => (
        <StateBlock state={data.state} note={data.note}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <ChartPanel title="日销历史与未来 30 天预测" ariaLabel="日销历史与预测折线图" option={forecastOption(data)} height={300} />
            <Typography.Text>
              预测口径 {data.method}{' '}
              <EstimateTag
                method="近期日均外推：低 / 高为 7、30、90 天日均的最小 / 最大，中为近 30 天日均（剔除已知断货日）"
                range={data.forecast[0] ? `低 ${data.forecast[0].low} / 中 ${data.forecast[0].mid} / 高 ${data.forecast[0].high} 件/天` : undefined}
              />
              ，销量来源：{data.source === 'ORDERS' ? '订单日汇总' : '亚马逊库存规划报告'}。
            </Typography.Text>
            <Alert
              type="info"
              showIcon
              message="剔除与未纳入"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  <li>
                    断货：{data.exclusions.stockoutDays > 0 ? `已剔除近 30 天内 ${data.exclusions.stockoutDays} 个断货日。` : '近 30 天没有已知断货日。'}
                    {data.exclusions.stockoutNote}
                  </li>
                  <li>促销：{data.exclusions.promotionNote}</li>
                  <li>季节性：{data.exclusions.seasonality ? `亚马逊标注 ${data.exclusions.seasonality}，本预测不做季节调整。` : '没有季节性标注，本预测不做季节调整。'}</li>
                </ul>
              }
            />
          </Space>
        </StateBlock>
      )}
    </QueryBody>
  )
}
