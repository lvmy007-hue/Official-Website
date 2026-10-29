import { z } from 'zod'

// 写接口的横向契约（P1-14）：幂等键、再次验证身份、需要填写原因的动作。

export const IDEMPOTENCY_HEADER = 'idempotency-key'
/** 幂等键只允许字母、数字与 . _ : -，长度 8–128（建议前端用随机 UUID）。 */
export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/, '幂等键只允许字母、数字与 . _ : -，长度 8 到 128')
export const IDEMPOTENCY_TTL_HOURS = 24

/**
 * 需要再次验证身份的操作（freeze/permissions.md 第七节、12 章 12.9 第 6 条）。
 * 再次验证按操作分别计算，有效期 10 分钟；到期后重新验证。
 */
export const STEP_UP_ACTIONS = {
  'switch.enable': '开启亚马逊写入开关',
  'fx.write': '手工覆盖汇率或调整汇率来源',
  'finance.policy': '修改或审批财务口径',
  'finance.period.close': '关账',
  'finance.period.reopen': '重新开账',
  'connection.disconnect': '断开亚马逊连接',
  'member.manage': '修改成员角色、数据范围或停用成员',
  'role.manage': '修改角色权限',
  'pii.access': '查看买家个人信息',
  'export.sensitive': '导出含敏感字段的文件',
  'pricing.change': '修改价格',
  'ads.bulk': '广告批量修改',
  'support.access': '授权或申请平台支持访问',
  'tenant.deactivate': '停用租户',
  'tenant.close': '注销租户',
} as const

export type StepUpAction = keyof typeof STEP_UP_ACTIONS
export const STEP_UP_TTL_MINUTES = 10
export const StepUpActionSchema = z.enum(Object.keys(STEP_UP_ACTIONS) as [StepUpAction, ...StepUpAction[]])

export const StepUpMethodSchema = z.enum(['PASSWORD', 'TOTP'])
export type StepUpMethod = z.infer<typeof StepUpMethodSchema>

/** POST /auth/step-up：用密码（或绑定后的多因素验证码）为指定操作做再次验证。 */
export const StepUpBodySchema = z
  .object({
    action: StepUpActionSchema,
    method: StepUpMethodSchema.default('PASSWORD'),
    password: z.string().min(1).max(200).optional(),
    code: z
      .string()
      .regex(/^\d{6}$/, '验证码为 6 位数字')
      .optional(),
  })
  .refine(value => (value.method === 'PASSWORD' ? Boolean(value.password) : Boolean(value.code)), { message: '请提供密码或验证码' })

/** 需要填写原因的动作（忽略预警、重新开账、查看买家信息、开启开关等）。 */
export const ReasonBodySchema = z.object({ reason: z.string().trim().min(2, '请填写原因').max(500) })

/** 被多人编辑的对象：请求体带 version，冲突返回 409 CONFLICT（P1-15）。 */
export const VersionBodySchema = z.object({ version: z.number().int().min(1) })
