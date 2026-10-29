import { useMemo } from 'react'
import { Alert, Card, Col, Row, Space, Tag } from 'antd'
import {
  BA_BREAKPOINT_ADVICE,
  BA_BREAKPOINT_BASIS,
  BA_BREAKPOINT_LABEL,
  BA_BREAKPOINTS,
  BA_QUADRANT_BASIS,
  BA_QUADRANT_HINT,
  BA_QUADRANT_LABEL,
  BA_QUADRANTS,
  type BaBreakpointSummary,
  type BaFunnelStage,
  type BaOverview,
  type BaPriceRow,
  type BaQuadrantSummary,
  type BaRootRow,
  type BaShippingRow,
  type BaTrendPoint,
} from '@nova/api-contracts'
import { ChartPanel, LocalGrid, renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { Muted } from '../inventory/inventory-ui'
import { buildQuadrantOption, buildTrendOption, changeColor, changeText, countText, moneyText, percentText, quadrantColor } from './brand-options'

// 搜索查询表现页的各块（P4-04）：份额漏斗、逐期趋势、价格与配送速度、机会象限、份额漏斗断点诊断、品牌搜索份额总览。

export function FunnelPanel({ stages }: { stages: readonly BaFunnelStage[] }) {
  return (
    <Row gutter={8} data-testid="ba-funnel">
      {stages.map(stage => (
        <Col key={stage.key} xs={12} md={6}>
          <Card size="small" styles={{ body: { padding: '10px 12px' } }} data-testid={`ba-funnel-${stage.key}`}>
            <div style={{ color: 'rgba(0,0,0,0.65)', fontSize: 13 }}>{stage.label}份额</div>
            <div style={{ fontSize: 22, fontWeight: 600 }} className="erp-num">
              {percentText(stage.share)}
            </div>
            <div style={{ fontSize: 12, color: changeColor(stage.shareChange) }}>较上一周期 {changeText(stage.shareChange)}</div>
            <div style={{ fontSize: 12 }}>
              <Muted>
                我方 {countText(stage.own)} / 全部 {countText(stage.market)}
              </Muted>
            </div>
          </Card>
        </Col>
      ))}
    </Row>
  )
}

export function TrendPanel({ trend, note }: { trend: readonly BaTrendPoint[]; note: string }) {
  const option = useMemo(() => buildTrendOption(trend), [trend])
  const empty = trend.length === 0 || trend.every(point => Object.values(point.shares).every(value => value === null))
  return (
    <div style={{ marginTop: 8 }}>
      <ChartPanel
        title="逐期份额趋势"
        ariaLabel="搜索查询份额逐期趋势图"
        option={option}
        height={260}
        emptyState={empty ? { kind: 'empty', domain: '逐期份额趋势', prerequisite: '所选范围内还没有可用的份额数据。' } : undefined}
      />
      <Muted>{note}</Muted>
    </div>
  )
}

const priceColumns: ErpColDef<BaPriceRow>[] = [
  renderColumn<BaPriceRow>('环节', 'label', row => row.label, { width: 120 }),
  renderColumn<BaPriceRow>('我方中位价', 'own', row => moneyText(row.own), { width: 130, ...RIGHT_ALIGNED }),
  renderColumn<BaPriceRow>('全部商家中位价', 'market', row => moneyText(row.market), { width: 150, ...RIGHT_ALIGNED }),
  renderColumn<BaPriceRow>('价差', 'gap', row => (row.gap === null ? '尚无记录' : `${row.gap > 0 ? '贵' : row.gap < 0 ? '便宜' : '持平'} ${percentText(Math.abs(row.gap))}`), {
    width: 130,
    ...RIGHT_ALIGNED,
  }),
]
const shipColumns: ErpColDef<BaShippingRow>[] = [
  renderColumn<BaShippingRow>('配送速度', 'label', row => row.label, { width: 130 }),
  renderColumn<BaShippingRow>('我方购买', 'own', row => countText(row.own), { width: 110, ...RIGHT_ALIGNED }),
  renderColumn<BaShippingRow>('全部购买', 'market', row => countText(row.market), { width: 110, ...RIGHT_ALIGNED }),
  renderColumn<BaShippingRow>('我方占比', 'share', row => percentText(row.share), { width: 110, ...RIGHT_ALIGNED }),
]
const rootColumns: ErpColDef<BaRootRow>[] = [
  renderColumn<BaRootRow>('词根', 'root', row => <span title={row.forms.join('、')}>{row.root}</span>, { width: 160, pin: 'left' }),
  renderColumn<BaRootRow>('词数', 'terms', row => row.terms, { width: 90, ...RIGHT_ALIGNED }),
  renderColumn<BaRootRow>('全部点击', 'mc', row => countText(row.marketClicks), { width: 120, ...RIGHT_ALIGNED }),
  renderColumn<BaRootRow>('我方点击份额', 'cs', row => percentText(row.clickShare), { width: 130, ...RIGHT_ALIGNED }),
  renderColumn<BaRootRow>('全部购买', 'mp', row => countText(row.marketPurchases), { width: 120, ...RIGHT_ALIGNED }),
  renderColumn<BaRootRow>('我方购买份额', 'ps', row => percentText(row.purchaseShare), { width: 130, ...RIGHT_ALIGNED }),
]

export function PricePanel({ price, priceNote, shipping }: { price: readonly BaPriceRow[]; priceNote: string; shipping: readonly BaShippingRow[] }) {
  const empty = { kind: 'empty' as const, domain: '价格与配送', prerequisite: '所选范围内没有价格或配送数据。' }
  return (
    <Row gutter={8} style={{ marginTop: 8 }} data-testid="ba-price">
      <Col xs={24} lg={12}>
        <Card size="small" title="价格对比">
          <LocalGrid<BaPriceRow> gridId="analytics.brand.sqp.price" columns={priceColumns} rows={price} getRowId={row => row.stage} initialPageSize={20} height={240} emptyState={empty} />
          <Muted>{priceNote}</Muted>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card size="small" title="购买的配送速度" extra={<Muted>只统计购买环节</Muted>}>
          <LocalGrid<BaShippingRow> gridId="analytics.brand.sqp.shipping" columns={shipColumns} rows={shipping} getRowId={row => row.speed} initialPageSize={20} height={240} emptyState={empty} />
        </Card>
      </Col>
    </Row>
  )
}
export function QuadrantPanel({ quadrant }: { quadrant: BaQuadrantSummary }) {
  const option = useMemo(() => buildQuadrantOption(quadrant), [quadrant])
  return (
    <Card size="small" title="机会象限" style={{ marginTop: 8 }} data-testid="ba-quadrant">
      {quadrant.state === 'INSUFFICIENT' ? (
        <Alert type="info" showIcon message={quadrant.note} data-testid="ba-quadrant-note" />
      ) : (
        <>
          <Space wrap style={{ marginBottom: 6 }}>
            {BA_QUADRANTS.map(key => (
              <Tag key={key} color={quadrantColor(key)} bordered={false} title={BA_QUADRANT_HINT[key]}>
                {BA_QUADRANT_LABEL[key]} {quadrant.counts[key]} 个
              </Tag>
            ))}
          </Space>
          <ChartPanel title="搜索量 × 购买份额" ariaLabel="机会象限散点图" option={option} height={300} />
          <ul style={{ margin: '6px 0 0', paddingInlineStart: 18, fontSize: 12 }}>
            {BA_QUADRANTS.map(key => (
              <li key={key}>
                <b>{BA_QUADRANT_LABEL[key]}</b>：{BA_QUADRANT_HINT[key]}
              </li>
            ))}
          </ul>
          <Muted>{BA_QUADRANT_BASIS}。图上只画搜索量最高的部分词。</Muted>
        </>
      )}
    </Card>
  )
}

export function BreakpointPanel({ breakpoints }: { breakpoints: BaBreakpointSummary }) {
  return (
    <Card size="small" title="份额漏斗断点诊断" style={{ marginTop: 8 }} data-testid="ba-breakpoints">
      {breakpoints.state === 'INSUFFICIENT' ? (
        <Alert type="info" showIcon message={breakpoints.note} data-testid="ba-breakpoints-note" />
      ) : (
        <Row gutter={8}>
          {BA_BREAKPOINTS.map(key => (
            <Col key={key} xs={24} md={8}>
              <Card size="small" type="inner" title={`${BA_BREAKPOINT_LABEL[key]}（${breakpoints.counts[key]} 个词）`} data-testid={`ba-breakpoint-${key}`}>
                <p style={{ margin: '0 0 6px', fontSize: 12 }}>{BA_BREAKPOINT_ADVICE[key]}</p>
                {breakpoints.examples[key].length === 0 ? (
                  <Muted>没有符合的词</Muted>
                ) : (
                  <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12 }}>
                    {breakpoints.examples[key].map(example => (
                      <li key={example.searchQuery}>
                        {example.searchQuery}（搜索量 {countText(example.searchVolume)}，展示 {percentText(example.shares.impression)} → 购买 {percentText(example.shares.purchase)}）
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </Col>
          ))}
        </Row>
      )}
      <Muted>{BA_BREAKPOINT_BASIS}</Muted>
    </Card>
  )
}

export function OverviewPanel({ overview }: { overview: BaOverview }) {
  return (
    <Card size="small" title="品牌搜索份额总览" extra={<Muted>按词根汇总</Muted>} style={{ marginTop: 8 }} data-testid="ba-overview">
      {overview.state === 'NO_DATA' ? (
        <Alert type="info" showIcon message={overview.note} />
      ) : (
        <LocalGrid<BaRootRow>
          gridId="analytics.brand.sqp.overview"
          columns={rootColumns}
          rows={overview.rows}
          getRowId={row => row.root}
          initialPageSize={50}
          height={420}
          emptyState={{ kind: 'empty', domain: '品牌搜索份额总览', prerequisite: overview.note }}
        />
      )}
    </Card>
  )
}
