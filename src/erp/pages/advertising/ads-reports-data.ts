import type { AdsParityStatus, AdsReportStatus, AdsReportTemplatesResponse } from '@nova/api-contracts'
import { useApiQuery } from '../../query/api-query'

// 广告报表页（P3-15）的共用取数与小工具：模板与档案选项（创建弹窗、模板库、历史可用起点共用一份）。

export const useReportTemplates = () => useApiQuery<AdsReportTemplatesResponse>({ domain: 'list', path: '/ads/report-templates', staleMs: 0 })

/** 往前推 N 天（按 YYYY-MM-DD 文本算，不依赖本机时区）。 */
export const daysBefore = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10)

export const STATUS_COLOR: Record<AdsReportStatus, string> = { PENDING: 'default', GENERATING: 'processing', READY: 'success', FAILED: 'error' }

export const PARITY_STATUS_LABEL: Record<AdsParityStatus, string> = { PASSED: '通过', HAS_DIFFS: '有差异', LEGACY_UNAVAILABLE: '旧接口不可用' }
export const PARITY_STATUS_COLOR: Record<AdsParityStatus, string> = { PASSED: 'success', HAS_DIFFS: 'warning', LEGACY_UNAVAILABLE: 'default' }

/** 有没做完的任务（排队中或生成中）时每 15 秒刷新一次，全部结束后停止。 */
export const REFRESH_MS = 15_000
