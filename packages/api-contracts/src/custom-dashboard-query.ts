import { z } from 'zod'
import { DASHBOARD_NAME_MAX, DASHBOARD_REFRESH_MAX, DASHBOARD_REFRESH_MIN, DASHBOARD_TEXT_MAX, WIDGET_TYPES } from './custom-dashboard.js'
import { CUSTOM_REPORT_SOURCES, REPORT_PAGE_MAX } from './report-source.js'

// 自定义仪表盘请求校验（P6-33）。与零 zod 的常量分开，避免进前端首屏。

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: '日期格式应为 YYYY-MM-DD' })
const sourceCode = z.enum(CUSTOM_REPORT_SOURCES.map(item => item.code) as [string, ...string[]])

export const WidgetQuerySchema = z.object({
  source: sourceCode,
  dimension: z.string().trim().min(1).max(40),
  metrics: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
  from: day.optional(),
  to: day.optional(),
  q: z.string().trim().max(80).optional(),
  pageSize: z.number().int().min(1).max(REPORT_PAGE_MAX).optional(),
})
export type WidgetQuery = z.infer<typeof WidgetQuerySchema>

export const WidgetOptionsSchema = z.object({
  text: z.string().max(DASHBOARD_TEXT_MAX).optional(),
  metric: z.string().trim().min(1).max(40).optional(),
})

export const WidgetBodySchema = z.object({
  type: z.enum(WIDGET_TYPES),
  query: WidgetQuerySchema.optional(),
  options: WidgetOptionsSchema.optional(),
  version: z.number().int().min(1).optional(),
})
export type WidgetBody = z.infer<typeof WidgetBodySchema>

const layoutItem = z.object({
  widgetId: z.string().trim().min(1).max(40),
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(200),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(20),
})

export const DashboardBodySchema = z.object({
  name: z.string().trim().min(1).max(DASHBOARD_NAME_MAX),
  folderId: z.string().trim().min(1).max(40).nullable().optional(),
  shared: z.boolean().optional(),
  refreshMinutes: z.number().int().min(DASHBOARD_REFRESH_MIN).max(DASHBOARD_REFRESH_MAX).nullable().optional(),
  layout: z.object({ items: z.array(layoutItem).max(24) }).optional(),
  version: z.number().int().min(1).optional(),
})
export type DashboardBody = z.infer<typeof DashboardBodySchema>

export const FolderBodySchema = z.object({
  name: z.string().trim().min(1).max(DASHBOARD_NAME_MAX),
  parentId: z.string().trim().min(1).max(40).nullable().optional(),
  version: z.number().int().min(1).optional(),
})
export type FolderBody = z.infer<typeof FolderBodySchema>

export const DashboardListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(REPORT_PAGE_MAX).default(50),
  q: z.string().trim().max(80).optional(),
  folderId: z.string().trim().min(1).max(40).optional(),
})
