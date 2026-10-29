import { Tag } from 'antd'
import type { SyncDataDomain, SyncDomainSummary } from '@nova/api-contracts'
import { formatDateTime } from '../../format'
import { Muted } from '../inventory/inventory-ui'

// 各数据域近 24 小时的同步概况（09 章 9.8 的 18 个数据域，外加连接与系统任务）：点一张卡片就按该数据域筛选任务，再点一次取消。
// 同步器没有交付的数据域写“尚未接入”，部分交付的写“部分接入”并说明缺什么；还没有任务的写“尚无记录”，不写 0。

const AVAILABILITY_TAG: Record<string, { color: string; text: string } | undefined> = {
  PARTIAL: { color: 'warning', text: '部分接入' },
  NOT_CONNECTED: { color: 'default', text: '尚未接入' },
}

function Body({ item }: { item: SyncDomainSummary }) {
  if (item.availability === 'NOT_CONNECTED') return <Muted>{item.note ?? '同步器尚未接入，没有同步任务'}</Muted>
  if (!item.hasJobs) return <Muted>尚无记录</Muted>
  return (
    <div style={{ fontSize: 12 }}>
      <span className="erp-num">
        成功 {item.succeeded} · 失败 {item.failed} · 进行中 {item.active}
      </span>
      <div>{item.lastSuccessAt ? <Muted>最近成功 {formatDateTime(item.lastSuccessAt)}</Muted> : <Muted>近 24 小时没有成功的任务</Muted>}</div>
      {item.lastFailureText ? <div style={{ color: '#cf1322' }}>{item.lastFailureText}</div> : null}
    </div>
  )
}

export function SyncDomainCards({
  domains,
  active,
  truncated,
  onPick,
}: {
  domains: SyncDomainSummary[]
  active?: SyncDataDomain
  truncated: boolean
  onPick: (domain: SyncDataDomain | undefined) => void
}) {
  return (
    <div data-testid="domain-cards">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8, marginBottom: 8 }}>
        {domains.map(item => {
          const tag = AVAILABILITY_TAG[item.availability]
          const selected = active === item.domain
          return (
            <button
              key={item.domain}
              type="button"
              aria-pressed={selected}
              aria-label={`数据域 ${item.label}`}
              title={item.note ?? undefined}
              onClick={() => onPick(selected ? undefined : item.domain)}
              style={{ textAlign: 'left', padding: '8px 10px', cursor: 'pointer', background: selected ? '#e6f4ff' : '#fff', border: `1px solid ${selected ? '#1677ff' : '#f0f0f0'}`, borderRadius: 6 }}
            >
              <div style={{ marginBottom: 4 }}>
                <strong>{item.label}</strong>
                {tag ? (
                  <Tag color={tag.color} bordered={false} style={{ marginLeft: 6 }}>
                    {tag.text}
                  </Tag>
                ) : null}
              </div>
              <Body item={item} />
              {item.note && item.availability === 'PARTIAL' ? (
                <div style={{ fontSize: 12, marginTop: 2 }}>
                  <Muted>{item.note}</Muted>
                </div>
              ) : null}
            </button>
          )
        })}
      </div>
      {truncated ? <Muted>近 24 小时的任务超过 5000 个，概况只统计了最近的 5000 个</Muted> : null}
    </div>
  )
}
