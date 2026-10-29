import { useState } from 'react'
import { Alert, Collapse, Radio, Tooltip } from 'antd'
import type { AdsAttributionWindow, AdsBudgetTimelineResponse, BudgetTimelineDay } from '@nova/api-contracts'
import { DataState, stateFromError } from '../../components'
import { describeError } from '../../query/errors'
import { formatMoney } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { StateNote } from './ads-ui'

// 活动的超预算时间条与归因窗口切换（P6-24）：近 14 天每天一条 24 小时的条，累计花费超过日预算的小时标红；展开才读取。
// 归因窗口只有报告行真的带了那个窗口的列才能选，缺列的窗口置灰并写原因，不用别的窗口顶替。小时数据只来自营销数据流，精度说明一直显示。

const HOUR_LABEL = (hour: number) => `${String(hour).padStart(2, '0')}:00`

function DayBar({ day, currency }: { day: BudgetTimelineDay; currency: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }} data-testid={`timeline-day-${day.date}`}>
      <span className="erp-num" style={{ width: 88 }}>
        {day.date}
      </span>
      <div style={{ display: 'flex', gap: 1 }}>
        {day.hours.map(hour => (
          <Tooltip
            key={hour.hour}
            title={`${HOUR_LABEL(hour.hour)}：${hour.spend === null ? '尚无记录' : formatMoney(hour.spend, currency)}${hour.cumulative === null ? '' : `，累计 ${formatMoney(hour.cumulative, currency)}`}`}
          >
            <span
              data-over={hour.over ? 'true' : 'false'}
              style={{
                width: 14,
                height: 16,
                background: hour.over ? 'var(--ant-color-error)' : hour.spend === null ? 'var(--ant-color-fill-tertiary)' : hour.active ? 'var(--ant-color-success)' : 'var(--ant-color-border)',
              }}
            />
          </Tooltip>
        ))}
      </div>
      <span style={{ fontSize: 12 }}>
        {day.hoursRecorded === 0 ? (
          <Muted>尚无记录</Muted>
        ) : day.exceededAtHour === null ? (
          <span>
            花费 {formatMoney(day.spend, currency)}
            {day.overBudgetHours === null ? '' : '，未超预算'}
          </span>
        ) : (
          <span>
            {HOUR_LABEL(day.exceededAtHour)} 起超预算，共 {day.overBudgetHours} 小时；预算内活跃 {day.activeHoursWithinBudget} 小时
          </span>
        )}
      </span>
    </div>
  )
}

function Body({ id }: { id: string }) {
  const query = useApiQuery<AdsBudgetTimelineResponse>({ domain: 'analytics', path: `/ads/campaigns/${encodeURIComponent(id)}/budget-timeline` })
  const [chosen, setChosen] = useState<AdsAttributionWindow | null>(null)
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'ads.read', onRetry: () => void query.refetch() })} />
  const data = query.data
  if (!data) return <DataState kind="skeleton" rows={3} />
  const current = data.windows.find(item => item.window === (chosen ?? data.defaultWindow))
  return (
    <div data-testid="budget-timeline">
      <Alert type="info" showIcon style={{ marginBottom: 8 }} message={data.precisionNote} />
      {data.state !== 'OK' ? <StateNote state={data.state} note={data.note} /> : null}
      {data.budgetNote ? <Muted>{data.budgetNote}</Muted> : null}
      {data.state === 'OK' ? (
        <div style={{ margin: '8px 0' }}>
          <div style={{ marginBottom: 6 }}>
            日预算 {data.budget === null ? <Muted>未知（只显示花费）</Muted> : formatMoney(data.budget, data.currency)}
            ；平均每天超预算 {data.averageOverBudgetHours === null ? <Muted>尚无记录</Muted> : `${data.averageOverBudgetHours} 小时`}（企业时区 {data.zone}）
          </div>
          {data.days.map(day => (
            <DayBar key={day.date} day={day} currency={data.currency} />
          ))}
        </div>
      ) : null}
      <div style={{ marginTop: 8 }}>
        <span style={{ marginRight: 8 }}>归因窗口：</span>
        <Radio.Group value={current?.window} onChange={event => setChosen(event.target.value as AdsAttributionWindow)} data-testid="attribution-windows">
          {data.windows.map(item => (
            <Tooltip key={item.window} title={item.available ? null : item.reason}>
              <Radio.Button value={item.window} disabled={!item.available}>
                {item.window} 天
              </Radio.Button>
            </Tooltip>
          ))}
        </Radio.Group>
        <div style={{ marginTop: 6 }} data-testid="attribution-result">
          {current?.available ? (
            <span>
              {current.window} 天归因：销售额 {current.sales === null ? <Muted>尚无记录</Muted> : formatMoney(current.sales, data.currency)}，订单 {current.orders ?? '尚无记录'}（覆盖{' '}
              {current.coveredDays}/{current.totalDays} 天）
            </span>
          ) : (
            <Muted>{current?.reason ?? '所选范围内没有带归因窗口列的报告行'}</Muted>
          )}
        </div>
      </div>
    </div>
  )
}

export function BudgetTimelineCard({ id }: { id: string }) {
  return <Collapse size="small" style={{ marginTop: 8 }} data-testid="budget-timeline-card" items={[{ key: 'timeline', label: '超预算时间条与归因窗口（近 14 天）', children: <Body id={id} /> }]} />
}
