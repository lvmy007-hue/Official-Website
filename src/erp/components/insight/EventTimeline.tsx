import { useMemo, useState } from 'react'
import { Checkbox, Empty, Space, Tag, Timeline, Typography } from 'antd'
import { formatDateTime } from '../../format'

// 事件标注时间轴（03 章 3.4 第 3 项）：改价、改预算、改竞价、刊登变更、他人修改详情页、断货与恢复、促销起止、
// 货件到仓、评论主题变化、账户状态变化、费用调整。可按类型筛选；来源标明是系统内操作还是亚马逊侧变化。

export const EVENT_KINDS = ['price', 'budget', 'bid', 'listing', 'third-party-edit', 'stockout', 'promotion', 'inbound-arrival', 'review-theme', 'account', 'fee-adjustment'] as const
export type EventKind = (typeof EVENT_KINDS)[number]

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  price: '改价',
  budget: '改预算',
  bid: '改竞价',
  listing: '刊登变更',
  'third-party-edit': '他人修改详情页',
  stockout: '断货与恢复',
  promotion: '促销起止',
  'inbound-arrival': '货件到仓',
  'review-theme': '评论主题变化',
  account: '账户状态变化',
  'fee-adjustment': '费用调整',
}

export type TimelineEvent = {
  id: string
  at: string
  kind: EventKind
  title: string
  detail?: string
  /** 来源：我方操作（审计）或亚马逊侧（同步差异、推送）。 */
  origin: 'system' | 'amazon'
  actor?: string
}

export function filterEvents(events: readonly TimelineEvent[], kinds: ReadonlySet<EventKind>): TimelineEvent[] {
  return events.filter(event => kinds.has(event.kind)).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

export function EventTimeline({ events, onCompare }: { events: readonly TimelineEvent[]; /** 对该事件做前后对照。 */ onCompare?: (event: TimelineEvent) => void }) {
  const present = useMemo(() => EVENT_KINDS.filter(kind => events.some(event => event.kind === kind)), [events])
  const [selected, setSelected] = useState<Set<EventKind>>(() => new Set(present))
  const visible = useMemo(() => filterEvents(events, new Set([...selected].filter(kind => present.includes(kind)))), [events, selected, present])
  if (events.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="所选范围内没有可标注的事件" />
  return (
    <div data-testid="event-timeline">
      <Space size={[12, 4]} wrap style={{ marginBottom: 8 }}>
        {present.map(kind => (
          <Checkbox
            key={kind}
            checked={selected.has(kind)}
            onChange={event =>
              setSelected(prev => {
                const next = new Set(prev)
                if (event.target.checked) next.add(kind)
                else next.delete(kind)
                return next
              })
            }
          >
            {EVENT_KIND_LABEL[kind]}
          </Checkbox>
        ))}
      </Space>
      {visible.length === 0 ? (
        <Typography.Text type="secondary">没有选中的事件类型</Typography.Text>
      ) : (
        <Timeline
          items={visible.map(event => ({
            key: event.id,
            color: event.origin === 'amazon' ? 'orange' : 'blue',
            children: (
              <div>
                <Space size={6} wrap>
                  <Typography.Text strong>{event.title}</Typography.Text>
                  <Tag bordered={false}>{EVENT_KIND_LABEL[event.kind]}</Tag>
                  <Tag bordered={false} color={event.origin === 'amazon' ? 'warning' : 'processing'}>
                    {event.origin === 'amazon' ? '亚马逊侧' : '系统内操作'}
                  </Tag>
                  {onCompare ? (
                    <Typography.Link onClick={() => onCompare(event)} aria-label={`对照分析：${event.title}`}>
                      前后对照
                    </Typography.Link>
                  ) : null}
                </Space>
                <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>
                  {formatDateTime(event.at)}
                  {event.actor ? ` · ${event.actor}` : ''}
                </div>
                {event.detail ? <div style={{ fontSize: 12 }}>{event.detail}</div> : null}
              </div>
            ),
          }))}
        />
      )}
    </div>
  )
}
