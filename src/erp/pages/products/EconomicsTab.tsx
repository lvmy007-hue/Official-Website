import { useMemo } from 'react'
import { Alert, Card, Descriptions, Space } from 'antd'
import type { Asin360EconomicsResponse } from '@nova/api-contracts'
import { ChartPanel } from '../../components'
import { formatMoney, formatPercent } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { buildBridgeOption, buildTrendOption } from '../profit/profit-options'
import { BridgeTable } from '../profit/profit-ui'
import { QueryBody, useProductQuery } from './asin360-hooks'
import { unitBridgeView } from './asin360-options'
import { PriceSimulator } from './economics-simulator'
import { CostsSection, OfficialSection, PreviewSection } from './economics-sections'

// 利润与成本页签（05 章 5.2）：每件经济瀑布 → 价格模拟器 → 范围合计利润桥与趋势 → 官方对照 → 费用预览 → 成本版本时间线。
// 口径沿用利润分析页：只含这个 SKU 的利润日表行，店铺级费用与没能分摊到商品的广告花费不含在内；缺成本时整体净利润不给，没有数据的项目写明原因，不显示 0。

function Body({ id, data }: { id: string; data: Asin360EconomicsResponse }) {
  const { unit, bridge } = data
  const unitView = useMemo(() => unitBridgeView(unit), [unit])
  const unitOption = useMemo(() => buildBridgeOption(unitView), [unitView])
  const trendOption = useMemo(() => buildTrendOption(data.trend), [data.trend])
  const money = (value: number) => formatMoney(value, data.currency, { digits: 2 })
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {data.state === 'NO_DATA' ? <Alert type="warning" showIcon message="所选范围内没有这个商品的利润数据" description={data.note ?? '利润日表在订单与财务同步后生成；没有数据时不显示 0。'} /> : null}
      <Descriptions size="small" bordered column={{ xs: 1, md: 4 }} data-testid="asin360-economics-head">
        <Descriptions.Item label="统计范围">
          {data.range.from} 至 {data.range.to}
          {data.range.defaulted ? '（默认）' : ''}
        </Descriptions.Item>
        <Descriptions.Item label="收入确认口径">{data.basisLabel}</Descriptions.Item>
        <Descriptions.Item label="销售件数">
          <span className="erp-num">{unit.units}</span>
        </Descriptions.Item>
        <Descriptions.Item label="成本覆盖率">
          {data.costCoverage === null ? <Muted>无权查看或没有销量</Muted> : <span className="erp-num">{formatPercent(data.costCoverage, { digits: 1 })}</span>}
        </Descriptions.Item>
        <Descriptions.Item label="平均售价">{unit.avgPrice === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{money(unit.avgPrice)}</span>}</Descriptions.Item>
        <Descriptions.Item label="每件净利润">{unit.netPerUnit === null ? <Muted>算不出</Muted> : <span className="erp-num">{money(unit.netPerUnit)}</span>}</Descriptions.Item>
        <Descriptions.Item label="上架价">{data.listPrice === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{money(data.listPrice)}</span>}</Descriptions.Item>
        <Descriptions.Item label="预期获胜价">
          <Muted>尚未接入</Muted>
        </Descriptions.Item>
      </Descriptions>
      {unit.state === 'INCOMPLETE' ? <Alert type="warning" showIcon message="每件净利润暂时算不出" description={unit.note} /> : null}
      <ChartPanel
        title="每件经济瀑布"
        ariaLabel="商品每件经济瀑布图"
        option={unitOption}
        emptyState={unit.state === 'NO_UNITS' ? { kind: 'empty', domain: '每件经济', prerequisite: '所选范围内需要有这个商品的销量（订单与财务同步后显示）' } : undefined}
      />
      <Card size="small" title="每件明细" data-testid="asin360-unit-table">
        <BridgeTable view={unitView} />
      </Card>
      <PriceSimulator data={data} />
      <ChartPanel
        title="利润趋势"
        ariaLabel="商品利润趋势图"
        option={trendOption}
        emptyState={data.trend.length === 0 ? { kind: 'empty', domain: '利润趋势', prerequisite: '所选范围内需要有这个商品的利润日表记录' } : undefined}
      />
      <Card size="small" title="范围合计利润桥" data-testid="asin360-bridge">
        <BridgeTable view={bridge} />
      </Card>
      {data.notes.map(note => (
        <div key={note}>
          <Muted>{note}</Muted>
        </div>
      ))}
      <OfficialSection id={id} />
      <PreviewSection id={id} />
      <CostsSection id={id} />
    </Space>
  )
}

export function EconomicsTab({ id }: { id: string }) {
  const query = useProductQuery<Asin360EconomicsResponse>(id, 'economics', { scoped: true })
  return <QueryBody query={query}>{data => <Body id={id} data={data} />}</QueryBody>
}
