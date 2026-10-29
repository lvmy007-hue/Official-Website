import { useEffect, useRef, useState } from 'react'
import { Button, Typography } from 'antd'
import type { ICellRendererParams } from 'ag-grid-community'
import { describeError } from '../../query/errors'
import { columnId, type ErpColDef, type FetchSummary } from './grid-types'

// 汇总行（P6-02，15 章第 6 节）：固定在表头下方；数字只取服务端汇总接口，前端不自行求和。
// - 没有传 fetchSummary：不显示这一行；
// - 加载中：显示“汇总（加载中）”占位行；读取失败：不显示这一行，在工具栏写明原因并给重试，不拿 0 或旧数充数；
// - 接口没给的列显示“—”（没有汇总，不是 0）；接口给 null 的列也显示“—”。

export const SUMMARY_FLAG = '__erpSummary'
export const SUMMARY_LABEL_KEY = '__erpSummaryLabel'

export type SummaryState = { status: 'idle' } | { status: 'loading' } | { status: 'error'; forbidden: boolean } | { status: 'ready'; totals: Record<string, number | null>; currency: string | null }

type Result = { key: string; state: SummaryState }

const cleanTotals = (raw: unknown): Record<string, number | null> | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, number | null> = {}
  for (const [key, value] of Object.entries(raw)) out[key] = typeof value === 'number' && Number.isFinite(value) ? value : null
  return out
}

/** 取汇总：resetKey（筛选、范围）变化或点重试时重新取，旧响应作废。 */
export function useGridSummary(fetchSummary: FetchSummary | undefined, resetKey: string): { state: SummaryState; retry: () => void } {
  const [nonce, setNonce] = useState(0)
  const [result, setResult] = useState<Result | null>(null)
  const fetchRef = useRef(fetchSummary)
  fetchRef.current = fetchSummary
  const enabled = fetchSummary !== undefined
  const key = `${resetKey}#${nonce}`
  useEffect(() => {
    const fetcher = fetchRef.current
    if (!enabled || !fetcher) return
    const controller = new AbortController()
    Promise.resolve()
      .then(() => fetcher({ signal: controller.signal }))
      .then(response => {
        if (controller.signal.aborted) return
        const totals = cleanTotals(response?.totals)
        setResult({ key, state: totals ? { status: 'ready', totals, currency: response.currency ?? null } : { status: 'error', forbidden: false } })
      })
      .catch(error => {
        if (!controller.signal.aborted) setResult({ key, state: { status: 'error', forbidden: describeError(error).kind === 'forbidden' } })
      })
    return () => controller.abort()
  }, [enabled, key])
  const state: SummaryState = !enabled ? { status: 'idle' } : result?.key === key ? result.state : { status: 'loading' }
  return { state, retry: () => setNonce(value => value + 1) }
}

/** 钉在表头下方的数据行；以列标识为键，没有汇总时返回空数组。 */
export function buildSummaryRows<T>(columns: readonly ErpColDef<T>[], state: SummaryState): Record<string, unknown>[] {
  if (state.status === 'loading') return [{ [SUMMARY_FLAG]: true, [SUMMARY_LABEL_KEY]: '汇总（加载中）' }]
  if (state.status !== 'ready') return []
  const row: Record<string, unknown> = { [SUMMARY_FLAG]: true, [SUMMARY_LABEL_KEY]: '汇总' }
  for (const col of columns) {
    const id = columnId(col)
    if (id && Object.prototype.hasOwnProperty.call(state.totals, id)) row[id] = state.totals[id]
  }
  return [row]
}

export function SummaryLabelCell(params: ICellRendererParams) {
  return <strong>{typeof params.value === 'string' ? params.value : '汇总'}</strong>
}

export function SummaryValueCell(params: ICellRendererParams) {
  return <span className="erp-num">{params.valueFormatted ?? ''}</span>
}

export function SummaryError({ onRetry, forbidden = false }: { onRetry: () => void; forbidden?: boolean }) {
  if (forbidden)
    return (
      <Typography.Text type="warning" role="alert">
        当前账号没有查看汇总的权限，表格数据不受影响
      </Typography.Text>
    )
  return (
    <span role="alert">
      <Typography.Text type="warning">汇总暂时读不到，表格数据不受影响</Typography.Text>
      <Button type="link" size="small" onClick={onRetry}>
        重试汇总
      </Button>
    </span>
  )
}
