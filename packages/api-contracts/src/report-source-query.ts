import { z } from 'zod'
import { CUSTOM_REPORT_SOURCES, REPORT_PAGE_MAX } from './report-source.js'

// 自定义报表请求校验（P6-32）。与目录常量分开：zod 不能进前端首屏。

export const REPORT_FORMATS = ['money', 'number', 'percent', 'decimal'] as const

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: '日期格式应为 YYYY-MM-DD' })
const keyText = z
  .string()
  .trim()
  .regex(/^C-[A-Z0-9]{2,20}$/, { error: '编号应为 C- 加 2 到 20 位大写字母或数字' })

export const ReportQuerySchema = z.object({
  dimension: z.string().trim().min(1).max(40),
  metrics: z.array(z.string().trim().min(1).max(40)).min(1).max(40),
  cursor: z.string().max(500).optional(),
  pageSize: z.number().int().min(1).max(REPORT_PAGE_MAX).optional(),
  q: z.string().trim().max(80).optional(),
  from: day.optional(),
  to: day.optional(),
})
export type ReportQuery = z.infer<typeof ReportQuerySchema>

export const CustomMetricBodySchema = z.object({
  key: keyText,
  name: z.string().trim().min(1).max(40),
  expression: z.string().trim().min(1).max(400),
  dimensions: z.array(z.string().trim().min(1).max(40)).min(1).max(20),
  format: z.enum(REPORT_FORMATS),
  version: z.number().int().min(1).optional(),
})
export type CustomMetricBody = z.infer<typeof CustomMetricBodySchema>

export const CustomMetricValidateSchema = z.object({
  key: keyText.optional(),
  expression: z.string().trim().min(1).max(400),
})

const schedule = z
  .object({
    frequency: z.enum(['DAILY', 'WEEKLY']),
    hour: z.number().int().min(0).max(23),
    weekday: z.number().int().min(0).max(6).optional(),
  })
  .nullable()
  .optional()

export const CustomReportBodySchema = z.object({
  name: z.string().trim().min(1).max(40),
  source: z.enum(CUSTOM_REPORT_SOURCES.map(item => item.code) as [string, ...string[]]),
  shared: z.boolean().optional(),
  starred: z.boolean().optional(),
  version: z.number().int().min(1).optional(),
  schedule,
  config: z.object({
    dimension: z.string().trim().min(1).max(40),
    metrics: z.array(z.string().trim().min(1).max(40)).min(1).max(40),
    from: day.optional(),
    to: day.optional(),
    q: z.string().trim().max(80).optional(),
  }),
})
export type CustomReportBody = z.infer<typeof CustomReportBodySchema>

export const ReportRunSchema = z.object({
  cursor: z.string().max(500).optional(),
  pageSize: z.number().int().min(1).max(REPORT_PAGE_MAX).optional(),
})

export const ReportListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(REPORT_PAGE_MAX).default(50),
  q: z.string().trim().max(80).optional(),
})
