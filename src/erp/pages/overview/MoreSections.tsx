import { useMemo } from 'react'
import { Descriptions, Tag, Typography } from 'antd'
import type { CashResponse, PendingSection, WaterfallItem, WaterfallResponse } from '@nova/api-contracts'
import { ChartPanel, EstimateTag } from '../../components'
import { formatMoney } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { DrillLink, PendingNote, Section, StateNote } from './dash-parts'
import { buildWaterfallOption } from './waterfall-option'

// 广告异常、库存风险分布、增长归因瀑布、现金视角（04 章 4.1 第 6 至 8 项）。
// 广告与库存规则还没交付：只写“尚未接入”和由哪个工作包交付，不画任何示例图。

function PendingArea({ title, path, drill, drillLabel, testId }: { title: string; path: string; drill: string; drillLabel: string; testId: string }) {
  const query = useApiQuery<PendingSection>({ domain: 'analytics', path })
  return (
    <Section title={title} loading={query.isPending} error={query.error} onRetry={() => void query.refetch()} extra={<DrillLink component={drill} label={drillLabel} />} testId={testId}>
      {query.data ? <PendingNote note={query.data.note} workPackage={query.data.workPackage} /> : null}
    </Section>
  )
}

export const AdAnomaliesSection = () => <PendingArea title="广告异常" path="/overview/ad-anomalies" drill="AdsConsolePage" drillLabel="去广告控制台" testId="ad-anomalies-section" />
export const InventoryRiskSection = () => <PendingArea title="库存风险分布" path="/overview/inventory-risk" drill="InventoryHealthPage" drillLabel="去库存健康" testId="inventory-risk-section" />

function ItemList({ items }: { items: WaterfallItem[] }) {
  return (
    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
      {items.map(item => (
        <li key={item.key}>
          {item.label}：{item.amount === null ? <Typography.Text type="secondary">尚未接入</Typography.Text> : formatMoney(item.amount, 'USD', { digits: 2, sign: true })}
          {item.estimate ? <EstimateTag method="按近期销量与断货天数估算（模型）" /> : null}
          {item.note ? <span style={{ color: 'var(--ant-color-text-secondary)' }}>（{item.note}）</span> : null}
        </li>
      ))}
    </ul>
  )
}

export function WaterfallSection() {
  const query = useApiQuery<WaterfallResponse>({ domain: 'analytics', path: '/overview/growth-waterfall' })
  const data = query.data
  const option = useMemo(() => (data && data.state === 'OK' ? buildWaterfallOption(data) : {}), [data])
  if (query.error || query.isPending || !data) return <Section title="增长归因瀑布" loading={query.isPending} error={query.error} onRetry={() => void query.refetch()} testId="waterfall-section" />
  if (data.state !== 'OK') {
    return (
      <Section title="增长归因瀑布" testId="waterfall-section">
        <StateNote state={data.state} note={data.note} />
      </Section>
    )
  }
  return (
    <div style={{ marginBottom: 12 }} data-testid="waterfall-section">
      <ChartPanel title="增长归因瀑布" ariaLabel="销售额变化瀑布图" option={option} height={280} />
      <Descriptions size="small" column={1} style={{ marginTop: 8 }}>
        <Descriptions.Item label="说明">{data.note}</Descriptions.Item>
        <Descriptions.Item label="按店铺">
          <ItemList items={data.byStore} />
        </Descriptions.Item>
        <Descriptions.Item label="按驱动因素">
          <ItemList items={data.byDriver} />
        </Descriptions.Item>
      </Descriptions>
    </div>
  )
}

export function CashSection() {
  const query = useApiQuery<CashResponse>({ domain: 'analytics', path: '/overview/cash' })
  const data = query.data
  return (
    <Section title="现金视角" loading={query.isPending} error={query.error} onRetry={() => void query.refetch()} extra={<DrillLink component="SettlementsPage" label="去结算" />} testId="cash-section">
      {data && data.state !== 'OK' ? <StateNote state={data.state} note={data.note} /> : null}
      {data && data.state === 'OK' ? (
        <Descriptions size="small" column={{ xs: 1, md: 3 }}>
          <Descriptions.Item label="本期已释放">{data.released === null ? <Tag bordered={false}>尚无记录</Tag> : formatMoney(data.released, 'USD', { digits: 2 })}</Descriptions.Item>
          <Descriptions.Item label="递延中余额">
            {data.deferred ? `${formatMoney(data.deferred.amount, 'USD', { digits: 2 })}（截至 ${data.deferred.asOf}）` : <Tag bordered={false}>尚无记录</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label="下次预计打款日">{data.nextPayoutDate ? data.nextPayoutDate : <Tag bordered={false}>尚无记录</Tag>}</Descriptions.Item>
        </Descriptions>
      ) : null}
      {data && data.state === 'OK' ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {data.nextPayoutNote}
        </Typography.Text>
      ) : null}
    </Section>
  )
}
