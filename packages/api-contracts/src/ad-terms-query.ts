import { z } from 'zod'
import { AD_TERM_ANOMALIES, AD_TERM_LIST_TABS, AD_TERM_NEGATIVE_LEVELS, AD_TERM_ROOT_SORTS, AD_TERM_SORTS, AD_TERM_SUBJECTS } from './ad-terms'
import { ADS_LEVEL_FILTERS } from './ads-levels'
import { cursorListQuery } from './query'

// 词级中心的请求校验（P3-10）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。

/** GET /ads/terms：范围参数加页签与筛选；`q` 匹配词；筛选与页签的组合是否合法由 termFilterIssue 判断（不适用的筛选返回 422，不静默忽略）。 */
export const AdTermListQuerySchema = cursorListQuery({
  sortable: AD_TERM_SORTS,
  defaultSort: { field: 'spend', dir: 'desc' },
  filters: {
    tab: { type: 'enum', values: AD_TERM_LIST_TABS },
    anomaly: { type: 'enum', values: AD_TERM_ANOMALIES },
    status: { type: 'enum', values: ['TARGETED', 'NEGATED', 'UNTARGETED'] },
    level: { type: 'enum', values: AD_TERM_NEGATIVE_LEVELS },
    matchType: { type: 'text', max: 40 },
    subject: { type: 'enum', values: AD_TERM_SUBJECTS },
    ...ADS_LEVEL_FILTERS,
  },
})
export type AdTermListQuery = z.infer<typeof AdTermListQuerySchema>

/** GET /ads/terms/roots：范围参数加关键字（词根包含）与排序。 */
export const AdTermRootsQuerySchema = cursorListQuery({
  sortable: AD_TERM_ROOT_SORTS,
  defaultSort: { field: 'spend', dir: 'desc' },
})
export type AdTermRootsQuery = z.infer<typeof AdTermRootsQuerySchema>

/** GET /ads/terms/detail：词级分析页按词的文字定位（不分大小写）；范围参数由全局范围校验，这里允许共存。 */
export const AdTermDetailQuerySchema = z.object({ term: z.string().trim().min(1, '请指定要分析的词').max(200) }).passthrough()
export type AdTermDetailQuery = z.infer<typeof AdTermDetailQuerySchema>
