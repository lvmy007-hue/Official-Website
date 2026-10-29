import { useMemo } from 'react'
import { Alert, Descriptions, Drawer, Space, Typography } from 'antd'
import { COST_COMPONENTS, COST_COMPONENT_LABEL, type CostDetailResponse } from '@nova/api-contracts'
import { ChartPanel, DataState, stateFromError } from '../../components'
import { formatNumber } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { CostCreateAction } from './costs-forms'
import { CoverageTag, PartCell, buildCompositionOption, landedText, usdText } from './costs-ui'
import { VersionCompare, VersionTimeline } from './costs-versions'

// 商品成本详情（05 章 5.9）：当前各项成本、版本时间线（含来源）、成本构成饼图、按企业计价方法估算的库存成本、版本对比、口径说明。
// 成本在企业层面，详情不跟页面顶部的店铺选择走；SKU 不在你的数据范围内时和不存在一样提示。

function Body({ data }: { data: CostDetailResponse }) {
  const option = useMemo(() => buildCompositionOption(data.composition), [data.composition])
  const { row, valuation } = data
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Descriptions size="small" column={2} bordered title="当前成本">
        <Descriptions.Item label="商品">{row.title ?? <Muted>没有同步到商品信息</Muted>}</Descriptions.Item>
        <Descriptions.Item label="覆盖状态">
          <CoverageTag coverage={row.coverage} />
        </Descriptions.Item>
        {COST_COMPONENTS.map(component => (
          <Descriptions.Item key={component} label={COST_COMPONENT_LABEL[component]}>
            <PartCell part={row.parts[component]} />
          </Descriptions.Item>
        ))}
        <Descriptions.Item label="到岸成本合计" span={2}>
          {landedText(row.landedUsd, row.landedState)}
        </Descriptions.Item>
      </Descriptions>
      {data.fx.length > 0 ? (
        <Muted>
          折合美元用今天的汇率估算：
          {data.fx.map(item => (item.rate === null ? `${item.currency} 缺汇率` : `1 美元 = ${item.rate} ${item.currency}（${item.rateDate}${item.carriedForward ? '，沿用前值' : ''}）`)).join('；')}
        </Muted>
      ) : null}

      <div>
        <Typography.Title level={5}>版本时间线</Typography.Title>
        <VersionTimeline sku={data.sku} versions={data.versions} canWrite={data.canWrite} truncated={data.versionsTruncated} />
      </div>

      <ChartPanel
        title="成本构成"
        ariaLabel="当前各项成本折合美元的构成"
        option={option}
        height={220}
        emptyState={data.composition.slices.length === 0 ? { kind: 'empty', domain: '成本构成', prerequisite: data.composition.note ?? '没有可画的成本' } : undefined}
      />
      {data.composition.note && data.composition.slices.length > 0 ? <Muted>{data.composition.note}</Muted> : null}

      <div data-testid="cost-valuation">
        <Typography.Title level={5}>库存成本（估算）</Typography.Title>
        <Descriptions size="small" column={2} bordered>
          <Descriptions.Item label="计价方法">
            {valuation.methodLabel}
            {valuation.methodValid ? null : <Muted>（企业设置的值不合法，按先进先出估算）</Muted>}
          </Descriptions.Item>
          <Descriptions.Item label="现有库存">
            {valuation.onHandUnits === null ? <Muted>尚无库存报告</Muted> : <span className="erp-num">{formatNumber(valuation.onHandUnits, { digits: 0 })} 件</span>}
          </Descriptions.Item>
          <Descriptions.Item label="库存成本">{usdText(valuation.valueUsd, valuation.state === 'NO_STOCK_DATA' ? '尚无库存报告' : '没有采购成本')}</Descriptions.Item>
          <Descriptions.Item label="平均单件">{usdText(valuation.avgUnitUsd, '无')}</Descriptions.Item>
        </Descriptions>
        <Muted>{valuation.note}</Muted>
      </div>

      <div>
        <Typography.Title level={5}>版本对比</Typography.Title>
        <VersionCompare sku={data.sku} versions={data.versions} />
      </div>

      <Alert
        type="info"
        showIcon
        message="口径说明"
        description={data.notes.map(note => (
          <div key={note}>{note}</div>
        ))}
      />
    </Space>
  )
}

export function CostDetailDrawer({ sku, onClose }: { sku: string | null; onClose: () => void }) {
  const query = useApiQuery<CostDetailResponse>({ domain: 'list', path: `/costs/${encodeURIComponent(sku ?? '')}`, scoped: false, enabled: Boolean(sku), staleMs: 0 })
  const data = query.data
  return (
    <Drawer
      open={Boolean(sku)}
      onClose={onClose}
      width={1100}
      title={sku ? `商品成本：${sku}` : '商品成本'}
      destroyOnClose
      extra={data ? <CostCreateAction canWrite={data.canWrite} today={data.today} sku={data.sku} /> : null}
    >
      {query.error ? <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} /> : null}
      {!data && !query.error ? <DataState kind="skeleton" rows={8} /> : null}
      {data ? <Body data={data} /> : null}
    </Drawer>
  )
}
