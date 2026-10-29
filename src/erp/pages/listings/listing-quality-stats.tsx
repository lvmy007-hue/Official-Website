import { Alert, Card, Statistic, Tag, Typography } from 'antd'
import type { ListingLifecycleStats, ListingQualityResponse, ListingSourceView } from '@nova/api-contracts'
import { formatNumber } from '../../format'

// 刊登质量页顶部：问题生命周期统计与数据来源说明。没有数据写“尚无记录”，没有接入写“尚未接入”，不写 0 代替。

const SOURCE_TAG: Record<ListingSourceView['state'], { color: string; text: string }> = {
  OK: { color: 'green', text: '已接入' },
  NO_DATA: { color: 'gold', text: '尚无记录' },
  NOT_CONNECTED: { color: 'default', text: '尚未接入' },
}

function hoursText(hours: number | null): string {
  if (hours === null) return '尚无记录'
  return hours < 48 ? `${formatNumber(hours, { digits: 1 })} 小时` : `${formatNumber(hours / 24, { digits: 1 })} 天`
}

export function LifecycleStats({ stats, empty }: { stats: ListingLifecycleStats; empty: boolean }) {
  const cell = (title: string, value: string, hint?: string) => (
    <Card size="small" key={title} style={{ minWidth: 150, flex: '1 1 150px' }}>
      <Statistic title={title} value={value} valueStyle={{ fontSize: 20 }} />
      {hint ? <Typography.Text type="secondary">{hint}</Typography.Text> : null}
    </Card>
  )
  // 还没有任何同步数据时，数量类指标写“尚无记录”，不写 0
  const count = (value: number) => (empty ? '尚无记录' : formatNumber(value, { digits: 0 }))
  return (
    <div data-testid="listing-quality-stats" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
      {cell('未解决问题', count(stats.openCount), empty ? undefined : `错误 ${stats.openErrors} · 警告 ${stats.openWarnings}`)}
      {cell('影响销售的未解决问题', count(stats.openImpactCount))}
      {cell('处理中', count(stats.inProgressCount), '本系统已提交修复')}
      {cell(`所选范围新增（${stats.range.from} ~ ${stats.range.to}）`, count(stats.newCount))}
      {cell('所选范围已解决', count(stats.resolvedCount))}
      {cell('平均解决时长', hoursText(stats.avgResolveHours), stats.resolveSampleTruncated ? '只统计最近解决的部分' : undefined)}
    </div>
  )
}

export function SourceNotes({ sources }: { sources: readonly ListingSourceView[] }) {
  return (
    <div data-testid="listing-quality-sources" style={{ margin: '4px 0 8px' }}>
      {sources.map(source => (
        <div key={source.key} style={{ fontSize: 12 }}>
          <Tag color={SOURCE_TAG[source.state].color}>{SOURCE_TAG[source.state].text}</Tag>
          {source.label}
          {source.note ? <Typography.Text type="secondary">：{source.note}</Typography.Text> : null}
        </div>
      ))}
    </div>
  )
}

export function StateNote({ data }: { data: ListingQualityResponse }) {
  if (data.state === 'OK' || !data.note) return null
  return (
    <Alert type={data.state === 'NOT_CONNECTED' ? 'info' : 'warning'} showIcon style={{ margin: '8px 0' }} message={data.state === 'NOT_CONNECTED' ? '尚未接入' : '尚无记录'} description={data.note} />
  )
}
