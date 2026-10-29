import { z } from 'zod'
import { ADS_BID_STRATEGIES, ADS_KEYWORD_MATCHES, ADS_NEGATIVE_MATCHES, ADS_PLACEMENTS, ADS_WRITE_KINDS, ADS_WRITE_LIMITS, ADS_WRITE_STATES, adsWriteOpIssue, type AdsWriteOp } from './ads-write'

// 广告写入的请求校验（P3-17）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起。
// 内容合法性（取值范围、必填项）由纯函数 adsWriteOpIssue 判断，前后端共用；对象是否存在、是否在数据范围内由服务判断。

const idText = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, '编号格式不正确')
const fields = {
  state: z.enum(ADS_WRITE_STATES).optional(),
  amount: z.number().finite().optional(),
  strategy: z.enum(ADS_BID_STRATEGIES).optional(),
  placement: z.enum(ADS_PLACEMENTS).optional(),
  text: z.string().trim().min(1).max(ADS_WRITE_LIMITS.textMax).optional(),
  matchType: z.enum([...ADS_NEGATIVE_MATCHES, ...ADS_KEYWORD_MATCHES]).optional(),
  level: z.enum(['CAMPAIGN', 'AD_GROUP']).optional(),
}

const check = (value: Omit<AdsWriteOp, 'entityId'>, ctx: z.RefinementCtx) => {
  const issue = adsWriteOpIssue(value)
  if (issue) ctx.addIssue({ code: 'custom', path: ['kind'], message: issue })
}

const base = z.object({ kind: z.enum(ADS_WRITE_KINDS), entityId: idText, ...fields }).strict()
export const AdsWriteOpSchema = base.superRefine(check)

/** 批量写入与预览：每项自带对象编号。 */
export const AdsWriteBatchBodySchema = z.object({ ops: z.array(AdsWriteOpSchema).min(1, '请至少选择一项修改').max(ADS_WRITE_LIMITS.batchMax, `一次最多修改 ${ADS_WRITE_LIMITS.batchMax} 项`) }).strict()
export type AdsWriteBatchBody = z.infer<typeof AdsWriteBatchBodySchema>

/** 单对象写入（对象编号在路径里，或否定与关键词的请求体里单独给）。 */
export const AdsWriteBodySchema = base.omit({ entityId: true }).superRefine(check)
export type AdsWriteBody = z.infer<typeof AdsWriteBodySchema>
