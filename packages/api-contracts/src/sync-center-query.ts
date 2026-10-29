import type { z } from 'zod'
import { cursorListQuery } from './query'
import { SYNC_DATA_DOMAINS, SYNC_STATES } from './sync-center'

// 同步中心的请求校验（P5-06）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。

/** 同步任务列表：数据域、状态筛选，按创建时间排序；搜索词匹配请求编号、任务编号与任务类型。 */
export const SyncJobListQuerySchema = cursorListQuery({
  sortable: ['createdAt'] as const,
  defaultSort: { field: 'createdAt', dir: 'desc' },
  filters: {
    domain: { type: 'enum', values: SYNC_DATA_DOMAINS },
    state: { type: 'enum', values: SYNC_STATES },
  },
})
export type SyncJobListQuery = z.infer<typeof SyncJobListQuerySchema>
