import { erpTokens as t } from '../../theme/tokens'

// 行内迷你趋势：纯 SVG 折线，用于表格单元格和指标卡。至少 2 个点才画线，否则显示占位。
export function buildTrendPath(points: readonly number[], width: number, height: number, padding = 2): string {
  if (points.length < 2) return ''
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const stepX = (width - padding * 2) / (points.length - 1)
  return points
    .map((value, index) => {
      const x = padding + index * stepX
      const y = height - padding - ((value - min) / span) * (height - padding * 2)
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}

export function MiniTrend({ points, label, width = 96, height = 24, tone }: { points: readonly number[]; label: string; width?: number; height?: number; tone?: 'positive' | 'negative' | 'neutral' }) {
  const path = buildTrendPath(points, width, height)
  if (!path) return <span aria-label={`${label}：数据不足`}>—</span>
  const color = tone === 'positive' ? t.success : tone === 'negative' ? t.danger : t.brand
  const first = points[0]!
  const last = points[points.length - 1]!
  return (
    <svg role="img" aria-label={`${label}：${points.length} 个点，从 ${first} 到 ${last}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ verticalAlign: 'middle' }}>
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
