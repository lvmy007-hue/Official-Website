import type { z } from 'zod'
import { ADS_CHANGE_ENTITY_TYPES, ADS_CHANGE_SOURCES } from './ads-changes'
import { cursorListQuery } from './query'

// 广告变更记录的请求校验（P3-14）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。

/** 列表：全局范围参数（日期范围，没给默认最近 30 天）加来源、对象类型、广告账户筛选；`q` 匹配对象名称或改前改后的值；只按发生时间排序。 */
export const AdsChangeListQuerySchema = cursorListQuery({
  sortable: ['occurredAt'] as const,
  defaultSort: { field: 'occurredAt', dir: 'desc' },
  filters: {
    source: { type: 'enum', values: ADS_CHANGE_SOURCES },
    entityType: { type: 'enum', values: ADS_CHANGE_ENTITY_TYPES },
    adsProfileId: { type: 'text', max: 64 },
  },
})
export type AdsChangeListQuery = z.infer<typeof AdsChangeListQuerySchema>
