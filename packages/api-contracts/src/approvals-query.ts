import { z } from 'zod'
import { APPROVAL_BOXES, APPROVAL_COMMENT_MAX, APPROVAL_DECISIONS, APPROVAL_PAGE_SIZE_MAX, APPROVAL_STATES } from './approvals'

// 审批收件箱的请求校验（P6-27）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起。

/** GET /approvals?box=&state=：信箱默认“我审批的”，状态默认“待处理”。 */
export const ApprovalListQuerySchema = z.object({
  box: z.enum(APPROVAL_BOXES).default('TODO'),
  state: z.enum(APPROVAL_STATES).default('PENDING'),
  limit: z.coerce.number().int().min(1).max(APPROVAL_PAGE_SIZE_MAX).default(30),
  cursor: z.string().max(500).optional(),
})
export type ApprovalListQuery = z.infer<typeof ApprovalListQuerySchema>

export const ApprovalIdParamSchema = z.string().min(1).max(64)

/** POST /approvals/:id/decision：驳回必须写意见；发起人自己点“驳回”就是撤回（沿用原模块规则，同样要写原因）。version 是收件箱记录的乐观锁版本。 */
export const ApprovalDecisionBodySchema = z
  .object({
    decision: z.enum(APPROVAL_DECISIONS),
    comment: z.string().trim().max(APPROVAL_COMMENT_MAX, `意见最多 ${APPROVAL_COMMENT_MAX} 字`).default(''),
    version: z.number().int().min(1).max(1_000_000),
  })
  .superRefine((value, ctx) => {
    if (value.decision === 'REJECTED' && value.comment.length < 2) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comment'], message: '驳回或撤回请写明原因（至少 2 个字）' })
  })
export type ApprovalDecisionBody = z.infer<typeof ApprovalDecisionBodySchema>
