import {
  RATINGS_TEMPLATE_EXAMPLE,
  RATINGS_TEMPLATE_HEADER,
  REVIEWS_LIMITS,
  REVIEWS_RETURNS_BASIS,
  REVIEWS_TABS,
  type ImprovementRow,
  type RatingRow,
  type ReviewSectionState,
  type ReviewSort,
  type ReviewsTab,
  type SolicitationBatchResult,
} from '@nova/api-contracts'

// 评价与反馈页的公共状态与纯函数（P4-13）。不引入 zod：首屏脚本不能依赖请求校验库。

export const PAGE_SIZES = [20, 50, 100] as const

/** 地址栏里的页签与选择（刷新不丢）；页签面板通过 onSelect 改写。 */
export type SearchPatch = Partial<Record<'tab' | 'storeId' | 'asin' | 'nodeId', string | undefined>>
export type SelectionProps = { storeId?: string; asin?: string; nodeId?: string; onSelect: (patch: SearchPatch) => void }

/** 地址栏的页签参数：不认识的值回到默认页签。 */
export const tabOf = (value: unknown): ReviewsTab => ((REVIEWS_TABS as readonly string[]).includes(String(value)) ? (value as ReviewsTab) : 'ratings')

export const SORT_LABEL: Record<ReviewSort, string> = { asin: 'ASIN', avgRating: '平均星级', ratingCount: '评分数', captureDate: '采集日期', delta: '较上次的星级变化' }
export const SORT_FIELDS = Object.keys(SORT_LABEL) as ReviewSort[]

/** “星级低于”下拉的取值（接口要求 1 到 5）。 */
export const RATING_BELOW_OPTIONS = [5, 4.5, 4, 3.5, 3] as const

export const SEVERITY_LABEL = { CRITICAL: '严重', WARNING: '警告', INFO: '提示' } as const
export type Severity = keyof typeof SEVERITY_LABEL

/** 评分概况的筛选。 */
export interface RatingFilters {
  q?: string
  ratingBelow?: number
}

/** 各区块状态的标题：没有数据写“尚无记录”，没有权限写“无权限”，来源没接上写“尚未接入”。 */
export const SECTION_TITLE: Record<ReviewSectionState, string> = {
  OK: '',
  NO_DATA: '尚无记录',
  NOT_CONNECTED: '尚未接入',
  RESTRICTED: '无权限',
  NOT_APPLICABLE: '不适用',
}

export const SOLICIT_SKIP_LABEL: Record<SolicitationBatchResult['skipped'][number]['reason'], string> = {
  ALREADY_REQUESTED: '已经请求过',
  OUT_OF_WINDOW: '不在可请求期内（送达后第 5 至 30 天）',
  NOT_FOUND: '找不到订单或不属于这个店铺',
  NOT_DELIVERED: '还没有全部送达',
}

/** 批量请求结果的文字：已受理 N 个，跳过 M 个（按原因分组）。 */
export function solicitResultText(result: Pick<SolicitationBatchResult, 'accepted' | 'skipped'>): string {
  const groups = new Map<string, number>()
  for (const item of result.skipped) groups.set(item.reason, (groups.get(item.reason) ?? 0) + 1)
  const reasons = [...groups.entries()].map(([reason, count]) => `${SOLICIT_SKIP_LABEL[reason as keyof typeof SOLICIT_SKIP_LABEL] ?? reason} ${count} 个`)
  const skipped = result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 个（${reasons.join('；')}）` : ''
  return `已受理 ${result.accepted} 个订单${skipped}`
}

/** 评分来源文字：文件导入 · 文件名 · 导入人。 */
export const ratingSourceText = (row: Pick<RatingRow, 'sourceLabel' | 'sourceFileName' | 'importedBy'>): string => `${row.sourceLabel} · ${row.sourceFileName} · ${row.importedBy ?? '导入人尚无记录'}`

/** 变化带正负号；没变化写“±0.00”（这是真实的“没变化”，不是没数据）。 */
export const signedNumber = (value: number, digits: number): string => `${value > 0 ? '+' : value < 0 ? '-' : '±'}${Math.abs(value).toFixed(digits)}`

/** 评分导入模板：UTF-8 带 BOM（Excel 才不会把中文列名读成乱码），CRLF 换行。 */
export const ratingsTemplateCsv = (): string => `\uFEFF${[RATINGS_TEMPLATE_HEADER.join(','), RATINGS_TEMPLATE_EXAMPLE.join(',')].join('\r\n')}\r\n`

/** 在浏览器里生成并下载模板文件。 */
export function downloadRatingsTemplate(): void {
  const url = URL.createObjectURL(new Blob([ratingsTemplateCsv()], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = '评分导入模板.csv'
  link.click()
  URL.revokeObjectURL(url)
}

/** 选择框的取值：店铺与对象用竖线拼成一个值。 */
export const pairValue = (storeId: string, id: string): string => `${storeId}|${id}`
export const splitPair = (value: string | null | undefined): [string, string] | null => {
  const index = (value ?? '').indexOf('|')
  return value && index > 0 ? [value.slice(0, index), value.slice(index + 1)] : null
}

const DETAIL_MAX = 2000
const ACTION_MAX = 500

/** “指派跟进”生成的待办标题：改进评价问题：<ASIN> <首个负面主题>。 */
export const improvementTitle = (row: Pick<ImprovementRow, 'asin' | 'negativeTopics'>): string => `改进评价问题：${row.asin} ${row.negativeTopics[0]?.topic ?? ''}`.trim()

/** 待办说明：建议、负面主题、退货原因与数据口径（只写事实，不写因果）。 */
export function improvementDetail(row: ImprovementRow, days: number): string {
  const topics = row.negativeTopics.map(item => `${item.topic}${item.mentionRange ? `（提及量 ${item.mentionRange}）` : ''}`).join('；')
  const reasons = row.returnReasons.map(item => `${item.label} ${item.units} 件`).join('；')
  const lines = [
    `建议：${row.suggestion}`,
    `最新负面评论主题（快照日期 ${row.snapshotDate}）：${topics || '尚无记录'}`,
    `近 ${days} 天退货：${row.returnUnits > 0 ? `${row.returnUnits} 件；${reasons}` : '尚无记录'}`,
    `是否可能相关：${row.possiblyRelated ? '主题与退货原因文字有重合（只做文字比对，不代表因果）' : '文字上没有重合'}`,
    `数据口径：${REVIEWS_RETURNS_BASIS}`,
  ]
  return lines.join('\n').slice(0, DETAIL_MAX)
}

export const improvementAction = (row: Pick<ImprovementRow, 'suggestion'>): string => row.suggestion.slice(0, ACTION_MAX)

/** 请求评价一次最多的订单数。 */
export const BATCH_MAX = REVIEWS_LIMITS.batchMax

/** 批量请求的前置条件：选 1 到 50 单，且同一店铺；不满足时返回原因。 */
export function batchIssue(rows: ReadonlyArray<{ storeId: string }>): string | null {
  if (rows.length === 0) return '请先勾选要请求评价的订单'
  if (rows.length > BATCH_MAX) return `一次最多请求 ${BATCH_MAX} 个订单`
  if (new Set(rows.map(row => row.storeId)).size > 1) return '一次只能请求同一个店铺的订单，请先在上方选择店铺'
  return null
}
