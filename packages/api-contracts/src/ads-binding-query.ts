import { z } from 'zod'
import { ADS_BINDING_REASON_MAX, ADS_BINDING_REASON_MIN } from './ads-binding.js'

// 人工绑定请求体（POST /connections/ads-accounts/:id/bind）。zod 校验单独成文件，前端首屏不引用它。
// sellerAccountId 给店铺编号表示绑定或改绑，给 null 表示解除绑定（回到未绑定，之后同步广告档案时会再次自动匹配）。
export const AdsAccountBindBodySchema = z
  .object({
    sellerAccountId: z.string().trim().min(1, '请选择店铺').max(64).nullable(),
    reason: z.string().trim().min(ADS_BINDING_REASON_MIN, `原因至少 ${ADS_BINDING_REASON_MIN} 个字`).max(ADS_BINDING_REASON_MAX, `原因最多 ${ADS_BINDING_REASON_MAX} 个字`).optional(),
  })
  .strict()
export type AdsAccountBindBody = z.infer<typeof AdsAccountBindBodySchema>
