import { Tag, Tooltip } from 'antd'
import type { EChartsOption } from 'echarts'
import {
  COST_COVERAGE_HINT,
  COST_COVERAGE_LABEL,
  COST_COMPONENT_LABEL,
  COST_STATUS_LABEL,
  type CostComponent,
  type CostComposition,
  type CostCoverage,
  type CostLandedState,
  type CostPart,
  type CostStatus,
} from '@nova/api-contracts'
import { escapeHtml } from '../../components/chart/chart-utils'
import { formatMoney } from '../../format'
import { Muted } from '../inventory/inventory-ui'

// 商品成本页面的小部件（P2b-14）：覆盖状态与版本状态标签、金额与折合美元的写法、成本构成饼图配置。

const COVERAGE_COLOR: Record<CostCoverage, string> = { COVERED: 'success', STALE: 'warning', DRAFT_ONLY: 'processing', MISSING: 'error' }
const STATUS_COLOR: Record<CostStatus, string> = { DRAFT: 'processing', ACTIVE: 'success', REPLACED: 'default' }

export function CoverageTag({ coverage }: { coverage: CostCoverage }) {
  return (
    <Tooltip title={COST_COVERAGE_HINT[coverage]}>
      <Tag color={COVERAGE_COLOR[coverage]}>{COST_COVERAGE_LABEL[coverage]}</Tag>
    </Tooltip>
  )
}

export const StatusTag = ({ status }: { status: CostStatus }) => <Tag color={STATUS_COLOR[status]}>{COST_STATUS_LABEL[status]}</Tag>

/** 小数文本去掉多余的尾零：1.500000 -> 1.5；没有这一项写“无”（不是 0）。 */
export const amountText = (value: string | null | undefined) => {
  if (value === null || value === undefined) return <Muted>无</Muted>
  const [whole = '0', fraction = ''] = value.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  return <span className="erp-num">{trimmed ? `${whole}.${trimmed}` : whole}</span>
}

export const usdText = (value: number | null | undefined, whenNone = '缺汇率') =>
  value === null || value === undefined ? <Muted>{whenNone}</Muted> : <span className="erp-num">{formatMoney(value, 'USD', { digits: 2 })}</span>

/** 单项成本：币种 + 金额，折合美元放在下面；没有这一项写“无”。 */
export function PartCell({ part }: { part: CostPart | null }) {
  if (!part) return <Muted>无</Muted>
  return (
    <div>
      <div>
        <span className="erp-num">{part.currency}</span> {amountText(part.amount)}
      </div>
      {part.currency !== 'USD' ? <div style={{ fontSize: 12 }}>≈ {usdText(part.usd)}</div> : null}
    </div>
  )
}

const LANDED_NOTE: Record<Exclude<CostLandedState, 'OK'>, string> = { NO_DATA: '无生效成本', NO_PRODUCT: '缺采购单价', NO_FX: '缺汇率' }

export const landedText = (usd: number | null, state: CostLandedState) => (state === 'OK' ? usdText(usd) : <Muted>{LANDED_NOTE[state]}</Muted>)

const PIE_COLORS: Record<CostComponent, string> = { product: '#4c6ef5', firstMile: '#15aabf', duty: '#fab005', other: '#adb5bd' }

/** 成本构成饼图：每一项折合美元的占比；缺汇率的项目不画（说明在图上方）。 */
export function buildCompositionOption(composition: CostComposition): EChartsOption {
  return {
    tooltip: {
      trigger: 'item',
      formatter: params => `${escapeHtml((params as { name: string }).name)}：${formatMoney((params as { value: number }).value, 'USD', { digits: 2 })}（${(params as { percent: number }).percent}%）`,
    },
    legend: { bottom: 0 },
    series: [
      {
        type: 'pie',
        radius: ['45%', '70%'],
        label: { formatter: '{b} {d}%' },
        data: composition.slices.map(slice => ({ name: COST_COMPONENT_LABEL[slice.component], value: slice.usd, itemStyle: { color: PIE_COLORS[slice.component] } })),
      },
    ],
  }
}
