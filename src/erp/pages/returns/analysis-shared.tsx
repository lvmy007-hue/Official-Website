import { useCallback, useMemo } from 'react'
import { Alert, Typography } from 'antd'
import {
  DEFAULT_TIME_BASIS,
  RETURN_DEFAULT_DAYS,
  RETURN_CYCLE_ANCHORS,
  RETURN_CYCLE_ANCHOR_LABEL,
  RETURN_CYCLE_DIMENSIONS,
  RETURN_CYCLE_DIMENSION_LABEL,
  RETURN_TIME_BASES,
  RETURN_TIME_BASIS_LABEL,
  type ReturnAnalysisCommon,
  type ReturnCycleAnchor,
  type ReturnCycleDimension,
  type ReturnTimeBasis,
} from '@nova/api-contracts'
import { FreshnessBar, useUrlFilters, type FilterField } from '../../components'
import { formatNumber } from '../../format'
import { Muted } from '../inventory/inventory-ui'

// 退货分析各页签共用的小件（P6-13）：时间口径、周期起点、切片维度、天数段这几个设置写在地址栏里（刷新与复制链接都能还原）；
// 天数段另存一份在本机，下次打开自动沿用。统计范围、新鲜度、口径说明、“无法计算 N 条”提示每个页签都一样地显示。

const BOUNDS_STORE = 'erp.returns.cycle-bounds'

export const ANALYSIS_FIELDS: FilterField[] = [
  { key: 'timeBasis', label: '时间口径', kind: 'select', hidden: true, options: RETURN_TIME_BASES.map(value => ({ value, label: RETURN_TIME_BASIS_LABEL[value] })) },
  { key: 'anchor', label: '周期起点', kind: 'select', hidden: true, options: RETURN_CYCLE_ANCHORS.map(value => ({ value, label: RETURN_CYCLE_ANCHOR_LABEL[value] })) },
  { key: 'dimension', label: '切片维度', kind: 'select', hidden: true, options: RETURN_CYCLE_DIMENSIONS.map(value => ({ value, label: RETURN_CYCLE_DIMENSION_LABEL[value] })) },
  { key: 'bounds', label: '天数段', kind: 'text', hidden: true },
]

function readStoredBounds(): string | undefined {
  try {
    return window.localStorage.getItem(BOUNDS_STORE) ?? undefined
  } catch {
    return undefined
  }
}

function writeStoredBounds(value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(BOUNDS_STORE)
    else window.localStorage.setItem(BOUNDS_STORE, value)
  } catch {
    // 本机存不了（隐私模式等）：只影响“下次自动沿用”，当次设置仍写在地址栏里
  }
}

export type AnalysisParams = {
  timeBasis: ReturnTimeBasis
  anchor: ReturnCycleAnchor
  dimension: ReturnCycleDimension
  /** 天数段文字（地址栏优先，其次本机上次的设置；都没有为空，服务端用默认的一套）。 */
  bounds: string | undefined
  setTimeBasis: (value: ReturnTimeBasis) => void
  setAnchor: (value: ReturnCycleAnchor) => void
  setDimension: (value: ReturnCycleDimension) => void
  setBounds: (value: string | null) => void
}

export function useAnalysisParams(): AnalysisParams {
  const url = useUrlFilters(ANALYSIS_FIELDS)
  const { values, set } = url
  const setBounds = useCallback(
    (value: string | null) => {
      writeStoredBounds(value)
      // 恢复默认时地址栏里写“默认”的空值也要盖掉本机的旧设置：用占位值 default 表示“明确用默认”
      set({ bounds: value === null ? 'default' : value })
    },
    [set],
  )
  return useMemo(
    () => ({
      timeBasis: (values.timeBasis as ReturnTimeBasis | undefined) ?? DEFAULT_TIME_BASIS,
      anchor: (values.anchor as ReturnCycleAnchor | undefined) ?? 'order',
      dimension: (values.dimension as ReturnCycleDimension | undefined) ?? 'none',
      bounds: values.bounds === 'default' ? undefined : (values.bounds ?? readStoredBounds()),
      setTimeBasis: value => set({ timeBasis: value === DEFAULT_TIME_BASIS ? undefined : value }),
      setAnchor: value => set({ anchor: value === 'order' ? undefined : value }),
      setDimension: value => set({ dimension: value === 'none' ? undefined : value }),
      setBounds,
    }),
    [values, set, setBounds],
  )
}

/** 件数：没有数据写“尚无记录”，不写 0。 */
export const unitsText = (value: number | null | undefined) => (value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>)

/** 页签顶部：数据新鲜度、统计范围与时间口径。 */
export function AnalysisHead({ data }: { data: ReturnAnalysisCommon | undefined }) {
  return (
    <div>
      <FreshnessBar freshness={data?.freshness} />
      {data ? (
        <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
          统计范围 {data.range.from} 至 {data.range.to}
          {data.range.defaulted ? `（未选择日期范围，默认最近 ${RETURN_DEFAULT_DAYS} 天）` : ''}；{RETURN_TIME_BASIS_LABEL[data.timeBasis]}
        </Typography.Paragraph>
      ) : null}
    </div>
  )
}

/** 缺下单时间等原因算不出的退货：单独计数写明，不静默丢弃，也不当作 0（M-704）。 */
export function UnknownNotice({ data, what }: { data: ReturnAnalysisCommon | undefined; what: string }) {
  if (!data || data.unknownOrderRows <= 0) return null
  return (
    <Alert
      type="info"
      showIcon
      style={{ margin: '8px 0' }}
      message={`${what} ${data.unknownOrderRows} 条（${formatNumber(data.unknownOrderUnits, { digits: 0 })} 件）`}
      description="这些退货缺下单时间（订单还没同步，或同步晚于退货报告），没有计入下面的统计，也没有当作 0 处理；订单补齐后会自动转入统计。"
    />
  )
}

export function TruncatedNote({ show }: { show: boolean | undefined }) {
  if (!show) return null
  return <Alert type="warning" showIcon style={{ margin: '8px 0' }} message="明细可能不完整" description="退货明细超过 20000 行，只用了最近的 20000 行；汇总数字请缩小日期范围后再看。" />
}

export function BasisNote({ text }: { text: string | undefined }) {
  return text ? (
    <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
      {text}
    </Typography.Paragraph>
  ) : null
}
