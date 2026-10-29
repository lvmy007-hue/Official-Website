import { useEffect, useRef, useState, type RefObject } from 'react'
import { Card, Image, Space, Tag, Typography } from 'antd'
import { FreshnessBar } from '../page/FreshnessBar'
import { Delta } from '../metric/MetricCard'
import type { DetailLayoutProps, IdentityMetric } from './DetailLayout'
import './detail.css'

// 整页详情的头部信息卡与收缩后的吸顶条（P6-05，15 章 5.3）：
// 头部信息卡 = 主图、标题、状态标签、编码字段组（“字段名 值”排成一行，可换行）、关键指标（竖线分隔，不做小卡片）、主操作；
// 滚到信息卡以下时收缩成一行吸顶：标题、状态、前三个关键指标、主操作。

/** 吸顶条里最多放几个关键指标。 */
export const COMPACT_METRICS_MAX = 3

type IdentityProps = Pick<DetailLayoutProps, 'title' | 'subtitle' | 'imageUrl' | 'statuses' | 'freshness' | 'primaryActions' | 'watch' | 'identityExtra' | 'codes'> & { metrics: IdentityMetric[] }

function MetricItem({ metric }: { metric: IdentityMetric }) {
  return (
    <div className="erp-detail-metric">
      <div className="erp-detail-metric-label">{metric.label}</div>
      <div className="erp-num erp-detail-metric-value">{metric.value}</div>
      {metric.delta ? (
        <div style={{ fontSize: 12 }}>
          <Delta label={metric.delta.label} ratio={metric.delta.ratio} goodWhen={metric.delta.goodWhen} />
        </div>
      ) : null}
    </div>
  )
}

/** 关键指标：竖线分隔、不做小卡片；整页详情的头部信息卡与抽屉共用。 */
export function MetricsRow({ metrics }: { metrics: IdentityMetric[] }) {
  return (
    <div className="erp-detail-metrics">
      {metrics.map(metric => (
        <MetricItem key={metric.label} metric={metric} />
      ))}
    </div>
  )
}

export function IdentityCard(props: IdentityProps) {
  return (
    <Card size="small" data-testid="identity">
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {props.imageUrl ? <Image src={props.imageUrl} alt={props.title} width={72} height={72} style={{ objectFit: 'contain', borderRadius: 6 }} /> : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <Typography.Title level={4} style={{ margin: 0 }}>
                {props.title}
              </Typography.Title>
              {props.subtitle ? <Typography.Text type="secondary">{props.subtitle}</Typography.Text> : null}
              {props.statuses?.length ? (
                <Space size={4} style={{ marginLeft: props.subtitle ? 8 : 0 }}>
                  {props.statuses.map(status => (
                    <Tag key={status.text} color={status.color} bordered={false}>
                      {status.text}
                    </Tag>
                  ))}
                </Space>
              ) : null}
            </div>
            <Space wrap>
              {props.watch}
              {props.primaryActions}
            </Space>
          </div>
          {props.codes?.length ? (
            <dl className="erp-detail-codes" aria-label="编码">
              {props.codes.map(code => (
                <div key={code.label} className="erp-detail-code">
                  <dt>{code.label}</dt>
                  <dd>{code.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <MetricsRow metrics={props.metrics} />
          {props.identityExtra}
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <FreshnessBar freshness={props.freshness} />
      </div>
    </Card>
  )
}

/** 收缩后的一行：标题、状态、前三个关键指标、主操作。 */
export function CompactBar(props: IdentityProps) {
  return (
    <div className="erp-detail-compact" data-testid="identity-compact" role="group" aria-label="对象摘要">
      <Typography.Text strong ellipsis style={{ maxWidth: 360 }}>
        {props.title}
      </Typography.Text>
      {props.statuses?.slice(0, 3).map(status => (
        <Tag key={status.text} color={status.color} bordered={false} style={{ marginInlineEnd: 0 }}>
          {status.text}
        </Tag>
      ))}
      <span className="erp-detail-compact-metrics">
        {props.metrics.slice(0, COMPACT_METRICS_MAX).map(metric => (
          <span key={metric.label} className="erp-detail-compact-metric">
            <span className="erp-detail-metric-label">{metric.label}</span> <span className="erp-num">{metric.value}</span>
          </span>
        ))}
      </span>
      <span className="erp-detail-compact-actions">{props.primaryActions}</span>
    </div>
  )
}

/**
 * 头部信息卡是否已经滚出视口上沿。用卡片后面的一个哨兵元素观察：哨兵离开视口且在上方，就算滚出。
 * 没有 IntersectionObserver 的环境永远是“没收缩”。
 */
export function useIdentityCollapsed(): { sentinel: RefObject<HTMLDivElement>; collapsed: boolean } {
  const sentinel = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    const element = sentinel.current
    if (!element || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver(entries => {
      const entry = entries[entries.length - 1]
      if (entry) setCollapsed(!entry.isIntersecting && entry.boundingClientRect.top < 0)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { sentinel, collapsed }
}
