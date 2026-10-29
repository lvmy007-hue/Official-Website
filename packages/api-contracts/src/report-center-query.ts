import { z } from 'zod'
import { CREATABLE_REPORT_TYPES } from './report-center-catalog'
import { REPORT_DOMAINS, REPORT_SOURCES, REPORT_STATUSES } from './report-center'
import { cursorListQuery } from './query'

// 报表中心的请求校验（P5-03）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** 报告任务列表：业务域、状态、来源筛选，按创建时间排序；搜索词匹配报告类型编号与名称。 */
export const ReportCenterListQuerySchema = cursorListQuery({
  sortable: ['createdAt'] as const,
  defaultSort: { field: 'createdAt', dir: 'desc' },
  filters: {
    domain: { type: 'enum', values: REPORT_DOMAINS },
    status: { type: 'enum', values: REPORT_STATUSES },
    source: { type: 'enum', values: REPORT_SOURCES },
  },
})
export type ReportCenterListQuery = z.infer<typeof ReportCenterListQuerySchema>

/** 创建 SP-API 报告任务：报告类型必须是目录里“可创建”的类型（有导入器）；日期是否需要、是否合法按目录里的数据周期在服务端检查。站点固定为美国站。 */
export const ReportCenterCreateBodySchema = z
  .object({
    reportType: z.string().refine(value => CREATABLE_REPORT_TYPES.includes(value), '不是报表中心可以创建的报告类型'),
    marketplaceId: z.literal('ATVPDKIKX0DER', { error: '当前只支持美国站（ATVPDKIKX0DER）' }).default('ATVPDKIKX0DER'),
    from: z.string().regex(DAY, '日期格式应为 YYYY-MM-DD').optional(),
    to: z.string().regex(DAY, '日期格式应为 YYYY-MM-DD').optional(),
  })
  .strict()
export type ReportCenterCreateBody = z.infer<typeof ReportCenterCreateBodySchema>
