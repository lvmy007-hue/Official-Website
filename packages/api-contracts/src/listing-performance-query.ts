import { z } from 'zod'
import { LISTING_LIVE_ANOMALIES, LISTING_PERF_SORTS } from './listing-performance.js'
import { PRODUCT_CHANNELS } from './product-list.js'
import { cursorListQuery } from './query.js'

// 刊登表现的请求校验（P4-09）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起。
// 筛选里没有“有刊登问题”“质量分区间”：这两项的数据来源（P4-10）还没有，提供了也只会筛出空结果，造成误导。
// 异常筛选只认现在算得出来的（转化率骤降）；其余三类异常来源未接入，页面上只显示“尚未接入”。

/** 列表：全局范围参数加筛选；排序字段白名单；关键字 `q` 是 cursorListQuery 自带的。 */
export const ListingPerfQuerySchema = cursorListQuery({
  sortable: LISTING_PERF_SORTS,
  defaultSort: { field: 'sales', dir: 'desc' },
  filters: {
    brand: { type: 'text', max: 120 },
    category: { type: 'text', max: 200 },
    status: { type: 'text', max: 40 },
    fulfillment: { type: 'enum', values: PRODUCT_CHANNELS },
    ownerId: { type: 'text', max: 64 },
    anomaly: { type: 'enum', values: LISTING_LIVE_ANOMALIES },
  },
})
export type ListingPerfQuery = z.infer<typeof ListingPerfQuerySchema>
