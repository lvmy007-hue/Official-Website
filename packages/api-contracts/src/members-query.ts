import { z } from 'zod'
import { MEMBER_STATUSES } from './members.js'
import { ROLE_DESCRIPTION_MAX, ROLE_FIELD_TIERS, ROLE_NAME_MAX } from './roles.js'

// 成员与角色的请求校验（P5-08）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。

export const MemberListQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  status: z.enum(MEMBER_STATUSES).optional(),
  roleId: z.string().trim().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})
export type MemberListQuery = z.infer<typeof MemberListQuerySchema>

const ids = z.array(z.string().trim().min(1).max(64)).max(500)

/** 数据范围：全部主体与店铺，或指定的主体与店铺（二选一，具体列表至少一项；服务里再核对是否属于本企业）。 */
export const ScopeInputSchema = z
  .object({ all: z.boolean().default(false), legalEntityIds: ids.default([]), sellerAccountIds: ids.default([]) })
  .strict()
  .superRefine((value, ctx) => {
    const specific = value.legalEntityIds.length + value.sellerAccountIds.length
    if (value.all && specific > 0) ctx.addIssue({ code: 'custom', path: ['all'], message: '选了“全部主体与店铺”就不要再选具体的主体或店铺' })
    if (!value.all && specific === 0) ctx.addIssue({ code: 'custom', path: ['all'], message: '请选择“全部主体与店铺”，或至少选一个主体或店铺；没有任何授权的成员看不到任何数据' })
  })

export const MemberInviteBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email('请填写正确的邮箱').max(254),
    roleId: z.string().trim().min(1, '请选择角色').max(64),
    scope: ScopeInputSchema,
  })
  .strict()
export type MemberInviteBody = z.infer<typeof MemberInviteBodySchema>

const reason = z.string().trim().min(2, '请填写原因').max(500)
export const MemberDisableBodySchema = z.object({ reason }).strict()
export const MemberEnableBodySchema = z.object({ reason: reason.optional() }).strict()
export const MemberRoleBodySchema = z.object({ roleId: z.string().trim().min(1, '请选择角色').max(64), reason: reason.optional() }).strict()
export const MemberScopesBodySchema = z.object({ scope: ScopeInputSchema, reason: reason.optional() }).strict()

const permissionKeys = z.array(z.string().trim().min(1).max(80)).max(300)
const roleName = z.string().trim().min(2, '角色名称至少 2 个字').max(ROLE_NAME_MAX)
const description = z.string().trim().max(ROLE_DESCRIPTION_MAX)
const tier = z.enum(ROLE_FIELD_TIERS)
const fields = z.object({ cost: tier.optional(), profit: tier.optional(), buyer: tier.optional() }).strict()

/** 新建角色：可以从已有角色（含预设）复制，再覆盖名称、权限、字段权限；不复制时权限必填。 */
export const RoleCreateBodySchema = z
  .object({ name: roleName, description: description.optional(), copyFromRoleId: z.string().trim().min(1).max(64).optional(), permissions: permissionKeys.optional(), fields: fields.optional() })
  .strict()
  .refine(body => body.copyFromRoleId !== undefined || (body.permissions !== undefined && body.permissions.length > 0), { path: ['permissions'], message: '至少选择一个权限点，或从已有角色复制' })
export type RoleCreateBody = z.infer<typeof RoleCreateBodySchema>

/** 修改角色：带着看到的版本号（乐观锁）；至少改一项。 */
export const RoleUpdateBodySchema = z
  .object({
    version: z.number().int().min(1),
    name: roleName.optional(),
    description: description.nullable().optional(),
    permissions: permissionKeys.optional(),
    fields: fields.optional(),
    reason: reason.optional(),
  })
  .strict()
  .refine(body => ['name', 'description', 'permissions', 'fields'].some(key => key in body), { message: '没有要修改的内容' })
export type RoleUpdateBody = z.infer<typeof RoleUpdateBodySchema>
