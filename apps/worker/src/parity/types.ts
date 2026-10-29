// 新旧接口并行双跑核对（P1-26，14 章 P1-26 验收：核对报告里的差异全部分类）。
// 每条差异必须归入四类之一，并写明中文原因；归不进前三类的就是“未解释”，需要人工看。

export type ParityCategory = 'TIME_BASIS' | 'ATTRIBUTION_BASIS' | 'SCOPE' | 'UNEXPLAINED'

/** 四类的含义：时间口径＝两次请求的时刻或时间窗边界不同造成；归因口径＝同一笔钱新旧接口归到不同的科目或订单；范围＝新旧接口返回的数据集合本来就不同；未解释＝以上都说不通。 */
export const PARITY_CATEGORY_LABEL: Record<ParityCategory, string> = {
  TIME_BASIS: '时间口径',
  ATTRIBUTION_BASIS: '归因口径',
  SCOPE: '范围',
  UNEXPLAINED: '未解释',
}

export type ParityDiff = { category: ParityCategory; entityKey: string; field: string; legacyValue?: string; newValue?: string; explanation: string }

export type ParityReport = { legacyCount: number; newCount: number; matchedCount: number; diffs: ParityDiff[] }

export type ParityWindow = { start: Date; end: Date }

/** 金额比较容差（半分钱）：两边都是两位小数的美元金额，累加后只允许浮点误差。 */
export const AMOUNT_EPSILON = 0.005
/** 落在时间窗边界这个范围内的差异归为时间口径。 */
export const EDGE_MS = 5 * 60 * 1000
/** 官方说明：财务事件可能不包含最近 48 小时的订单。 */
export const FINANCE_LAG_MS = 48 * 60 * 60 * 1000

export const nearEdge = (time: Date, window: ParityWindow) => Math.abs(time.getTime() - window.start.getTime()) <= EDGE_MS || Math.abs(time.getTime() - window.end.getTime()) <= EDGE_MS

export const money = (value: number) => value.toFixed(2)

export const zeroUnexplained = (report: ParityReport) => report.diffs.every(diff => diff.category !== 'UNEXPLAINED')
export const countByCategory = (diffs: ParityDiff[]) => {
  const counts: Record<ParityCategory, number> = { TIME_BASIS: 0, ATTRIBUTION_BASIS: 0, SCOPE: 0, UNEXPLAINED: 0 }
  for (const diff of diffs) counts[diff.category] += 1
  return counts
}
