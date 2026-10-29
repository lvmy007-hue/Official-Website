import { z } from 'zod'

// 份额趋势的请求校验（P6-29）。允许地址栏里的店铺范围参数共存，避免先被 422 掉。

export const ShareTrendQuerySchema = z
  .object({
    asin: z
      .string({ error: '请填写 ASIN' })
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{10}$/, { error: 'ASIN 是 10 位字母或数字' }),
  })
  .passthrough()
export type ShareTrendQuery = z.infer<typeof ShareTrendQuerySchema>
