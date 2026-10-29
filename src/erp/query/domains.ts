// 数据请求的缓存新鲜时间，按数据域设置（P1-06，依据 10 章 10.5）。
// 新鲜时间内重复进入页面直接用缓存，不再打服务端；越“实时”的数据域越短。

export const DATA_DOMAINS = {
  /** 登录与权限：变化很少，但权限变更后要尽快生效。 */
  session: { staleMs: 5 * 60_000, label: '登录与权限' },
  /** 主体、店铺、连接、成员等基础资料。 */
  reference: { staleMs: 5 * 60_000, label: '基础资料' },
  /** 业务列表与明细（订单、库存、采购……）。 */
  list: { staleMs: 60_000, label: '业务列表' },
  /** 指标、图表、分析汇总：来自日汇总表，更新频率低。 */
  analytics: { staleMs: 5 * 60_000, label: '指标与分析' },
  /** 任务、队列、今日实时：需要尽快看到变化。 */
  realtime: { staleMs: 15_000, label: '实时状态' },
  /** 设置、开关、规则：保存后立即失效重取，平时可缓存较久。 */
  config: { staleMs: 2 * 60_000, label: '设置与规则' },
} as const

export type DataDomain = keyof typeof DATA_DOMAINS

export const staleTimeOf = (domain: DataDomain) => DATA_DOMAINS[domain].staleMs

/** 未被页面使用的缓存保留多久后回收。 */
export const CACHE_GC_MS = 5 * 60_000
/** 缓存条目数上限：超出后优先回收最久没更新、且当前无人使用的条目。 */
export const CACHE_MAX_ENTRIES = 300
