import type { ReactNode } from 'react'
import { Alert, Descriptions } from 'antd'
import type { AdsRuleEffect, AdsRuleQuality, AdsRuleTotalsView } from '@nova/api-contracts'
import { formatDateTime } from '../../format'
import { moneyCell, numberCell, NONE, percentCell } from './ads-campaigns-ui'
import { StateNote } from './ads-ui'
import { SimpleGrid } from '../../components'

// 规则质量（P3-13）：最近一次评估的命中率、近 30 天的运行数、待办采纳率、执行后的前后 7 天对比。
// 采纳率与效果都没有数据时写“尚无记录”/原因，不当 0；执行后效果要等自动执行（P3-17）真的执行过才会有。

type EffectLine = { key: string; label: string; before: ReactNode; after: ReactNode }

const effectLines = (before: AdsRuleTotalsView, after: AdsRuleTotalsView): EffectLine[] => [
  { key: 'spend', label: '花费', before: moneyCell(before.spend), after: moneyCell(after.spend) },
  { key: 'sales', label: '广告销售额', before: moneyCell(before.sales), after: moneyCell(after.sales) },
  { key: 'orders', label: '订单', before: numberCell(before.orders), after: numberCell(after.orders) },
  { key: 'clicks', label: '点击', before: numberCell(before.clicks), after: numberCell(after.clicks) },
  // 效果里的广告成本销售比是百分数（30 表示 30%），展示组件要小数
  { key: 'acos', label: '广告成本销售比', before: percentCell(before.acos === null ? null : before.acos / 100), after: percentCell(after.acos === null ? null : after.acos / 100) },
]

function EffectBlock({ effect }: { effect: AdsRuleEffect }) {
  if (effect.state !== 'OK' || !effect.before || !effect.after) return <StateNote state={effect.state} note={effect.note} />
  return (
    <div>
      <p style={{ margin: '0 0 8px' }}>
        统计了 {effect.samples} 次已执行的动作，每次对比执行前后各 {effect.windowDays} 天的合计。
      </p>
      <SimpleGrid<EffectLine>
        gridId="advertising.ads-rules-quality"
        columns={[
          { title: '指标', dataIndex: 'label', width: 160 },
          { title: '执行前', dataIndex: 'before', align: 'right' },
          { title: '执行后', dataIndex: 'after', align: 'right' },
        ]}
        rows={effectLines(effect.before, effect.after)}
        rowKey={row => row.key}
        emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
      />
    </div>
  )
}

export function QualityBlock({ quality }: { quality: AdsRuleQuality }) {
  const { lastScan, recent, adoption } = quality
  return (
    <div data-testid="rule-quality">
      <Descriptions size="small" column={2} bordered>
        <Descriptions.Item label="最近一次评估">{lastScan.at ? formatDateTime(lastScan.at) : '尚未评估'}</Descriptions.Item>
        <Descriptions.Item label="命中率">
          {lastScan.hitRate === null ? NONE : percentCell(lastScan.hitRate)}
          {lastScan.evaluated !== null ? `（评估 ${lastScan.evaluated} 个，命中 ${lastScan.matched ?? 0} 个）` : ''}
        </Descriptions.Item>
        <Descriptions.Item label={`近 ${quality.windowDays} 天运行记录`}>
          {recent.runs === 0 ? NONE : `${recent.runs} 条，涉及 ${recent.objects} 个对象（待办 ${recent.suggested}，已执行 ${recent.applied}，跳过 ${recent.skipped}，失败 ${recent.failed}）`}
        </Descriptions.Item>
        <Descriptions.Item label="待办采纳率">
          {adoption.state === 'OK' ? percentCell(adoption.adoptionRate) : <StateNote state={adoption.state} />}
          <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
            处理中 {adoption.open}，已处理 {adoption.handled}，无需处理 {adoption.notNeeded}，误报 {adoption.falsePositive}
          </div>
        </Descriptions.Item>
      </Descriptions>
      <h4 style={{ margin: '12px 0 8px' }}>执行后效果</h4>
      <EffectBlock effect={quality.effect} />
      {quality.notes.length > 0 ? <Alert type="info" showIcon style={{ marginTop: 8 }} message={quality.notes.join('；')} /> : null}
    </div>
  )
}
