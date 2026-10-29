import { z } from 'zod'
import { ACCOUNT_HEALTH_LIMITS, POLICY_HANDLING_STATUSES, POLICY_ISSUE_KINDS, POLICY_ISSUE_SORTS, POLICY_ISSUE_STATUSES } from './account-health.js'
import { cursorListQuery } from './query.js'

// 账户健康的请求校验（P5-02）。单独成文件：zod 校验不能进前端首屏（见 PROGRESS.md 的 sideEffects 一条）。

/** 政策问题列表：全局范围参数加状态、类型、处理状态、负责人筛选；关键字 q 搜索标题、问题编号与 ASIN；默认按首次出现时间从新到旧。 */
export const PolicyIssueListQuerySchema = cursorListQuery({
  sortable: POLICY_ISSUE_SORTS,
  defaultSort: { field: 'firstSeenAt', dir: 'desc' },
  filters: {
    status: { type: 'enum', values: POLICY_ISSUE_STATUSES },
    kind: { type: 'enum', values: POLICY_ISSUE_KINDS },
    handlingStatus: { type: 'enum', values: POLICY_HANDLING_STATUSES },
    ownerId: { type: 'text', max: 64 },
  },
})
export type PolicyIssueListQuery = z.infer<typeof PolicyIssueListQuerySchema>

/**
 * 处理政策问题：版本号必填（乐观锁），其余字段给了才改。
 * ownerUserId / handlingNote / amazonCaseId 传 null 表示清空；amazonCaseId 是卖家后台里这条问题对应的案件编号（手工填写，用来在客服案件里找到关联）。
 */
export const PolicyIssueUpdateBodySchema = z
  .object({
    version: z.number().int().min(1),
    ownerUserId: z.string().trim().min(1).max(64).nullable().optional(),
    handlingStatus: z.enum(POLICY_HANDLING_STATUSES, { error: '处理状态只能是 OPEN、IN_PROGRESS、DONE' }).optional(),
    handlingNote: z
      .string()
      .trim()
      .max(ACCOUNT_HEALTH_LIMITS.noteMax, { error: `备注不能超过 ${ACCOUNT_HEALTH_LIMITS.noteMax} 个字` })
      .nullable()
      .optional(),
    amazonCaseId: z
      .string()
      .trim()
      .max(ACCOUNT_HEALTH_LIMITS.amazonCaseIdMax, { error: `案件编号不能超过 ${ACCOUNT_HEALTH_LIMITS.amazonCaseIdMax} 个字符` })
      .regex(/^[A-Za-z0-9_-]+$/, { error: '案件编号只能包含字母、数字、横线与下划线' })
      .nullable()
      .optional(),
  })
  .strict()
  .refine(value => value.ownerUserId !== undefined || value.handlingStatus !== undefined || value.handlingNote !== undefined || value.amazonCaseId !== undefined, {
    error: '没有要修改的内容',
  })
export type PolicyIssueUpdateBody = z.infer<typeof PolicyIssueUpdateBodySchema>
