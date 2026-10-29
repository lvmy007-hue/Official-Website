import { Space } from 'antd'
import type { PriceCompare, PriceCompareSide } from '@nova/api-contracts'
import { formatNumber, formatPercent } from '../../format'
import { Muted } from '../inventory/inventory-ui'

// 调价前后对照（P4-11）：调价前后各 7 天的日均销量、会话、转化率、购物车获得率。
// 调价后观察期不满写“观察中”，没有数据写“尚无记录”；这是相关性，不是因果，页面上明说。

const dash = <Muted>尚无记录</Muted>

function Side({ side }: { side: PriceCompareSide | null }) {
  if (!side) return dash
  const part = (label: string, value: string | null) => (value === null ? null : <span key={label}>{`${label} ${value}`}</span>)
  const parts = [
    part('日均销量', side.unitsPerDay === null ? null : formatNumber(side.unitsPerDay, { digits: 1 })),
    part('会话', side.sessions === null ? null : formatNumber(side.sessions, { digits: 0 })),
    part('转化率', side.conversionPct === null ? null : formatPercent(side.conversionPct, { digits: 1 })),
    part('购物车获得率', side.buyBoxPct === null ? null : formatPercent(side.buyBoxPct, { digits: 1 })),
  ].filter(Boolean)
  return parts.length === 0 ? (
    dash
  ) : (
    <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
      {parts}
      <span style={{ color: 'rgba(0,0,0,0.45)' }}>共 {side.days} 天</span>
    </Space>
  )
}

export function CompareView({ compare }: { compare: PriceCompare | null }) {
  if (!compare) return <Muted>尚无记录</Muted>
  if (compare.state !== 'OK') return <Muted>{compare.state === 'WAITING' ? (compare.note ?? '观察中') : (compare.note ?? '尚无记录')}</Muted>
  return (
    <Space align="start" size={16} data-testid="price-compare">
      <div>
        <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>调价前</div>
        <Side side={compare.before} />
      </div>
      <div>
        <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>调价后</div>
        <Side side={compare.after} />
      </div>
    </Space>
  )
}
