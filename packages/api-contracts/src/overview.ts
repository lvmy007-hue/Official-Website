import type { FreshnessSourceView, FreshnessViewStatus } from './freshness.js'

// 数据源健康表（04 章 4.1 第 7 区域；14.11 过渡期“企业初始化与数据源健康”页）。
// 表里固定列出 9 类来源：已经有同步器登记新鲜度的来源显示真实状态；
// 同步器还没有交付的来源如实写“尚未接入”并说明由哪个阶段交付；推送类来源接收端缺失期间显示“未接入”（14.10）。
// 不编造时间、不显示示例数字。

export type SourceHealthState =
  /** 有同步器登记了新鲜度，状态来自真实记录 */
  | 'LIVE'
  /** 依赖部署专项（推送接收端、营销数据流），暂缓期间显示未接入 */
  | 'NOT_CONNECTED'
  /** 同步器尚未交付，随对应工作包接入 */
  | 'NOT_DELIVERED'

export interface PendingSourceSpec {
  key: string
  label: string
  state: Exclude<SourceHealthState, 'LIVE'>
  note: string
}

/** 表的行顺序：来源键为已登记的新鲜度来源，`pending` 为尚未交付的来源。 */
export const SOURCE_HEALTH_LAYOUT: ReadonlyArray<{ live: string } | { pending: PendingSourceSpec }> = [
  { live: 'orders.api' },
  { live: 'inventory.api' },
  { live: 'inbound.plan' },
  { live: 'finance.transactions' },
  { pending: { key: 'reports', label: '报告', state: 'NOT_DELIVERED', note: '报告类同步随各数据域工作包接入（阶段 2a、2b）' } },
  { pending: { key: 'datakiosk', label: '数据中心', state: 'NOT_DELIVERED', note: '销售与流量、单品经济的数据集随阶段 2b 接入' } },
  { pending: { key: 'ads', label: '广告', state: 'NOT_DELIVERED', note: '广告数据同步随阶段 3 接入' } },
  { pending: { key: 'marketing-stream', label: '营销数据流', state: 'NOT_CONNECTED', note: '依赖部署专项提供的数据流接收端，暂缓期间未接入' } },
  { pending: { key: 'brand-analytics', label: '品牌分析', state: 'NOT_DELIVERED', note: '品牌分析数据随阶段 4 接入，且需要品牌资格' } },
  { pending: { key: 'notifications-push', label: '消息推送', state: 'NOT_CONNECTED', note: '依赖部署专项提供的推送接收端，暂缓期间未接入' } },
]

export interface SourceHealthRow {
  sourceKey: string
  label: string
  state: SourceHealthState
  status: FreshnessViewStatus
  statusLabel: string
  lastSuccessAt: string | Date | null
  lagMinutes: number | null
  coverage: { total: number; fresh: number } | null
  errorCode: string | null
  errorMessage: string | null
  note: string | null
}

/** 把新鲜度聚合结果按固定布局排成数据源健康表。 */
export function buildSourceHealth(sources: readonly FreshnessSourceView[]): SourceHealthRow[] {
  return SOURCE_HEALTH_LAYOUT.map((entry): SourceHealthRow => {
    if ('pending' in entry) {
      const spec = entry.pending
      return {
        sourceKey: spec.key,
        label: spec.label,
        state: spec.state,
        status: spec.state === 'NOT_CONNECTED' ? 'NOT_CONNECTED' : 'NO_RECORD',
        statusLabel: spec.state === 'NOT_CONNECTED' ? '未接入' : '尚未接入',
        lastSuccessAt: null,
        lagMinutes: null,
        coverage: null,
        errorCode: null,
        errorMessage: null,
        note: spec.note,
      }
    }
    const view = sources.find(item => item.sourceKey === entry.live)
    if (!view) throw new Error(`来源目录缺少 ${entry.live}`)
    return {
      sourceKey: view.sourceKey,
      label: view.label,
      state: 'LIVE',
      status: view.status,
      statusLabel: view.statusLabel,
      lastSuccessAt: view.lastSuccessAt,
      lagMinutes: view.lagMinutes,
      coverage: view.coverage,
      errorCode: view.errorCode,
      errorMessage: view.errorMessage,
      note: null,
    }
  })
}
