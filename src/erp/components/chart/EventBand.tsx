import { useMemo, useState } from 'react'
import { Button, Checkbox, Modal, Tag, Typography } from 'antd'
import { EVENT_MAX_SPAN_DAYS, EVENT_PER_TYPE_LIMIT, EVENT_TYPE_LABEL, EVENT_TYPES, type EventType } from '@nova/api-contracts'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { describeError } from '../../query/errors'
import { bandPosition, eventRange, placeEvents, type BandPoint } from './event-band-utils'
import { useObjectEvents, type EventSource } from './use-events'
import './event-band.css'

// 事件带（P6-06，15 章第 9 节）：趋势图下方的一条事件带，每种类型一行、按类型着色，可以逐类开关；
// 点一个点打开事件详情；同一天同一类的多个事件合并成一个点，显示“N 个事件”。
// 事件来自统一事件接口（按对象读，权限与数据范围由服务端过滤）：没有读权限的类型在带上说明，不显示成“没有事件”。

export type EventBandProps = {
  source: EventSource
  /** 图的横轴类目（日期）。 */
  categories: readonly string[]
  /** 绘图区左右留白，让事件带和图的横轴对齐。 */
  grid: { left: number | string; right: number | string }
  /** 图的类目轴两端是否留白。 */
  boundaryGap: boolean
}

const spanDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1

function DetailModal({ point, onClose }: { point: BandPoint; onClose: () => void }) {
  return (
    <Modal open title={`${point.category} · ${EVENT_TYPE_LABEL[point.type]}`} footer={null} onCancel={onClose} destroyOnHidden width={560}>
      <div className="erp-event-detail" data-testid="event-detail">
        {point.items.map(item => (
          <div key={item.id} className="erp-event-detail-item">
            <div className="erp-event-detail-title">
              <Typography.Text strong>{item.title}</Typography.Text>
              <Tag bordered={false}>{EVENT_TYPE_LABEL[item.type]}</Tag>
            </div>
            <div className="erp-event-detail-meta">
              {formatDateTime(item.occurredAt)} · {item.actor}
            </div>
            {item.summary ? <div>{item.summary}</div> : null}
            {item.link ? (
              <AppLink to={item.link} onNavigate={onClose}>
                查看详情
              </AppLink>
            ) : null}
          </div>
        ))}
      </div>
    </Modal>
  )
}

export function EventBand({ source, categories, grid, boundaryGap }: EventBandProps) {
  const range = useMemo(() => eventRange(categories), [categories])
  const tooLong = range !== null && spanDays(range.from, range.to) > EVENT_MAX_SPAN_DAYS
  const query = useObjectEvents(source, range && !tooLong ? range : null)
  const [hidden, setHidden] = useState<ReadonlySet<EventType>>(() => new Set())
  const [opened, setOpened] = useState<{ type: EventType; index: number } | null>(null)

  const items = useMemo(() => query.data?.items ?? [], [query.data])
  const present = useMemo(() => EVENT_TYPES.filter(type => items.some(item => item.type === type)), [items])
  const counts = useMemo(() => new Map(present.map(type => [type, items.filter(item => item.type === type).length])), [present, items])
  const placed = useMemo(() => placeEvents(categories, items, hidden), [categories, items, hidden])
  const openedPoint = opened ? placed.points.find(point => point.type === opened.type && point.index === opened.index) : undefined
  const shownTypes = present.filter(type => !hidden.has(type))

  if (range === null) return null
  if (tooLong) return <div className="erp-event-band erp-event-note">时间范围超过 {EVENT_MAX_SPAN_DAYS} 天，事件带不显示；请缩小时间范围。</div>
  if (query.error)
    return (
      <div className="erp-event-band erp-event-note" role="status">
        事件加载失败：{describeError(query.error).message}{' '}
        <Button size="small" type="link" onClick={() => void query.refetch()}>
          重试
        </Button>
      </div>
    )
  if (query.isPending || !query.data)
    return (
      <div className="erp-event-band erp-event-note" role="status">
        正在加载事件…
      </div>
    )

  const data = query.data
  const notes: string[] = []
  if (data.unavailableTypes.length > 0) notes.push(`没有查看权限，未显示：${data.unavailableTypes.map(type => EVENT_TYPE_LABEL[type]).join('、')}`)
  if (data.truncatedTypes.length > 0) notes.push(`事件太多，只显示最近 ${EVENT_PER_TYPE_LIMIT} 条：${data.truncatedTypes.map(type => EVENT_TYPE_LABEL[type]).join('、')}`)
  if (placed.outside > 0) notes.push(`${placed.outside} 个事件不在图的日期范围内`)

  return (
    <div className="erp-event-band" data-testid="event-band">
      <div className="erp-event-head">
        <span className="erp-event-title">事件</span>
        {present.length === 0 ? <Typography.Text type="secondary">所选时间范围内没有事件</Typography.Text> : null}
        {present.map(type => (
          <Checkbox
            key={type}
            checked={!hidden.has(type)}
            onChange={event =>
              setHidden(prev => {
                const next = new Set(prev)
                if (event.target.checked) next.delete(type)
                else next.add(type)
                return next
              })
            }
          >
            <span className="erp-event-legend" data-type={type} />
            {EVENT_TYPE_LABEL[type]} {counts.get(type)}
          </Checkbox>
        ))}
      </div>
      {shownTypes.map(type => (
        <div key={type} className="erp-event-lane" data-testid={`event-lane-${type}`}>
          <span className="erp-event-lane-label" style={{ width: grid.left }} title={EVENT_TYPE_LABEL[type]}>
            {EVENT_TYPE_LABEL[type]}
          </span>
          <div className="erp-event-track">
            {placed.points
              .filter(point => point.type === type)
              .map(point => (
                <button
                  key={point.index}
                  type="button"
                  className="erp-event-dot"
                  data-type={type}
                  style={{ left: `${bandPosition(point.index, categories.length, boundaryGap)}%` }}
                  title={`${point.category}：${point.label}`}
                  aria-label={`${EVENT_TYPE_LABEL[type]} ${point.category}：${point.label}`}
                  onClick={() => setOpened({ type, index: point.index })}
                >
                  {point.count ?? ''}
                </button>
              ))}
          </div>
          <span style={{ width: grid.right }} />
        </div>
      ))}
      {notes.length > 0 ? <div className="erp-event-note">{notes.join('；')}</div> : null}
      {openedPoint ? <DetailModal point={openedPoint} onClose={() => setOpened(null)} /> : null}
    </div>
  )
}
