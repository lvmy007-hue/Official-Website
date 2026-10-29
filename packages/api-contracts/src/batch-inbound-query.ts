import { z } from 'zod'
import { TO_INBOUND_ITEMS_MAX } from './batch-inbound.js'
import { pageListQuery } from './query.js'

// 补货批次转入仓计划草稿的请求校验（P6-08）。单独成文件：zod 构造是顶层调用（见 PROGRESS 的 sideEffects 一条）。

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, { error: '编号格式不正确' })

/**
 * dryRun 缺省为 true：没写明就只预览，不会因为漏传参数就真的生成草稿。
 * 每条建议可以改数量（qty，不传就取建议量）、指定发货地址（不传就用该店铺的默认地址）。
 */
export const ToInboundDraftsBodySchema = z
  .object({
    dryRun: z.boolean().default(true),
    items: z
      .array(z.object({ recommendationId: id, qty: z.number().int().min(1).max(10_000_000).optional(), shipFromAddressId: id.optional() }).strict())
      .min(1, { error: '请先勾选要转入仓计划的建议' })
      .max(TO_INBOUND_ITEMS_MAX, { error: `一次最多转 ${TO_INBOUND_ITEMS_MAX} 条建议` })
      .superRefine((items, ctx) => {
        const seen = new Set<string>()
        items.forEach((item, index) => {
          if (seen.has(item.recommendationId)) ctx.addIssue({ code: 'custom', message: '同一条建议不能重复勾选', path: [index, 'recommendationId'] })
          seen.add(item.recommendationId)
        })
      }),
  })
  .strict()
export type ToInboundDraftsBody = z.infer<typeof ToInboundDraftsBodySchema>

/** 尚未生成草稿的意向：目前只有 PENDING 一种状态；可按批次收窄。 */
export const InboundIntentQuerySchema = pageListQuery({
  sortable: ['registeredAt'] as const,
  defaultSort: { field: 'registeredAt', dir: 'desc' },
  filters: { status: { type: 'enum', values: ['PENDING'] }, batchId: { type: 'text', max: 64 } },
})
export type InboundIntentQuery = z.infer<typeof InboundIntentQuerySchema>
