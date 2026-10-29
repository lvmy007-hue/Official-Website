import { z } from 'zod'
import { ADS_BULK_ADD_LIMIT, ADS_BULK_ADD_MODES, ADS_BULK_ADD_SOURCES } from './ads-tools'
import { ADS_CONFLICT_KINDS } from './ads-conflicts'
import { ADS_KEYWORD_MATCHES, ADS_NEGATIVE_MATCHES, ADS_WRITE_LIMITS } from './ads-write'

// 广告新增分析与工具的请求校验（P6-24）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。

const idText = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, '编号格式不正确')

/** 冲突与重复关键词列表：游标分页（范围参数由全局范围校验，这里允许共存）。 */
export const AdsToolListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
    q: z.string().trim().min(1).max(120).optional(),
    kind: z.enum(ADS_CONFLICT_KINDS).optional(),
    matchType: z.enum(ADS_KEYWORD_MATCHES).optional(),
  })
  .passthrough()
export type AdsToolListQuery = z.infer<typeof AdsToolListQuerySchema>

const item = z
  .object({
    text: z.string().trim().min(1, '请填写词').max(ADS_WRITE_LIMITS.textMax, `词最长 ${ADS_WRITE_LIMITS.textMax} 个字符`),
    matchType: z.enum([...ADS_KEYWORD_MATCHES, ...ADS_NEGATIVE_MATCHES]),
    amount: z.number().finite().optional(),
  })
  .strict()

/**
 * 词研究一键加词（批量）：把候选词加进指定广告组（关键词）或加成否定投放（挂在广告组或活动）。
 * 每项的取值合法性仍由写入流水线统一判断（匹配方式要和模式对得上、竞价范围等）；这里只管形状与数量上限。
 */
export const BulkKeywordBodySchema = z
  .object({
    mode: z.enum(ADS_BULK_ADD_MODES),
    /** 父对象的系统编号：关键词是广告组；否定投放按 level 是活动或广告组。 */
    entityId: idText,
    level: z.enum(['CAMPAIGN', 'AD_GROUP']).optional(),
    source: z.enum(ADS_BULK_ADD_SOURCES).default('MANUAL'),
    items: z.array(item).min(1, '请至少选择一个词').max(ADS_BULK_ADD_LIMIT, `一次最多添加 ${ADS_BULK_ADD_LIMIT} 个词`),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.mode === 'NEGATIVE' && !body.level) ctx.addIssue({ code: 'custom', path: ['level'], message: '否定投放要选择挂在活动还是广告组' })
    if (body.mode === 'KEYWORD' && body.level) ctx.addIssue({ code: 'custom', path: ['level'], message: '加关键词只能加到广告组，不需要 level' })
  })
export type BulkKeywordBody = z.infer<typeof BulkKeywordBodySchema>
