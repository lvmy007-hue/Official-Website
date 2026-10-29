import { describe, expect, it } from 'vitest'
import {
  MEMBER_ACTION_LABEL,
  MemberDisableBodySchema,
  MemberInviteBodySchema,
  MemberListQuerySchema,
  MemberRoleBodySchema,
  MemberScopesBodySchema,
  RoleCreateBodySchema,
  RoleUpdateBodySchema,
  permissionDeniedMessage,
  permissionsActorLacks,
  scopeInputProblem,
  scopeKindOf,
  scopeLabelOf,
  separationConflicts,
  separationMessage,
  memberActionLabel,
  memberStatusLabel,
} from './index'

// 成员与角色契约（P5-08）：数据范围的种类与一句话、请求体校验、不能授予自己没有的权限、职责分离、无权限提示。

describe('数据范围', () => {
  it('种类：没有授权、全部（任一行两列都空）、只有主体、只有店铺、两者都有', () => {
    expect(scopeKindOf([])).toBe('NONE')
    expect(scopeKindOf([{ legalEntityId: null, sellerAccountId: null }])).toBe('ALL')
    expect(
      scopeKindOf([
        { legalEntityId: 'e1', sellerAccountId: null },
        { legalEntityId: null, sellerAccountId: null },
      ]),
    ).toBe('ALL')
    expect(scopeKindOf([{ legalEntityId: 'e1', sellerAccountId: null }])).toBe('ENTITIES')
    expect(scopeKindOf([{ legalEntityId: null, sellerAccountId: 's1' }])).toBe('STORES')
    expect(
      scopeKindOf([
        { legalEntityId: 'e1', sellerAccountId: null },
        { legalEntityId: null, sellerAccountId: 's1' },
      ]),
    ).toBe('MIXED')
  })

  it('一句话：全部与未授权不带名字；具体范围最多列 3 个名字，其余写“等 N 个”', () => {
    expect(scopeLabelOf('ALL', [], [])).toBe('全部主体与店铺')
    expect(scopeLabelOf('NONE', [], [])).toBe('尚未授权')
    expect(scopeLabelOf('STORES', [], ['美国站'])).toBe('指定店铺：美国站')
    expect(scopeLabelOf('MIXED', ['主体甲'], ['A', 'B', 'C'])).toBe('指定主体与店铺：主体甲、A、B等 4 个')
  })

  it('请求体的内在一致性：全部与具体列表二选一，具体列表至少一项', () => {
    expect(scopeInputProblem({ all: true, legalEntityIds: [], sellerAccountIds: [] })).toBeNull()
    expect(scopeInputProblem({ all: false, legalEntityIds: ['e1'], sellerAccountIds: [] })).toBeNull()
    expect(scopeInputProblem({ all: true, legalEntityIds: ['e1'], sellerAccountIds: [] })).toContain('就不要再选')
    expect(scopeInputProblem({ all: false, legalEntityIds: [], sellerAccountIds: [] })).toContain('没有任何授权的成员看不到任何数据')
  })
})

describe('请求体校验', () => {
  it('列表查询：默认分页、页大小上限 200、状态只认使用中与已停用', () => {
    expect(MemberListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 50 })
    expect(MemberListQuerySchema.parse({ status: 'DISABLED', q: ' 小李 ', page: '2', pageSize: '10' })).toEqual({ status: 'DISABLED', q: '小李', page: 2, pageSize: 10 })
    expect(MemberListQuerySchema.safeParse({ pageSize: '201' }).success).toBe(false)
    expect(MemberListQuerySchema.safeParse({ status: 'LEGACY' }).success).toBe(false)
  })

  it('邀请：邮箱转小写、范围必须有效、不认识的字段拒绝', () => {
    const ok = MemberInviteBodySchema.parse({ email: ' New@Example.COM ', roleId: 'preset-ops', scope: { all: true } })
    expect(ok).toEqual({ email: 'new@example.com', roleId: 'preset-ops', scope: { all: true, legalEntityIds: [], sellerAccountIds: [] } })
    expect(MemberInviteBodySchema.safeParse({ email: 'x', roleId: 'r', scope: { all: true } }).success).toBe(false)
    expect(MemberInviteBodySchema.safeParse({ email: 'a@b.cn', roleId: 'r', scope: { all: false } }).success).toBe(false)
    expect(MemberInviteBodySchema.safeParse({ email: 'a@b.cn', roleId: 'r', scope: { all: true }, extra: 1 }).success).toBe(false)
  })

  it('停用必须写原因；改角色与改范围的原因可选；改范围沿用同一套范围校验', () => {
    expect(MemberDisableBodySchema.safeParse({}).success).toBe(false)
    expect(MemberDisableBodySchema.safeParse({ reason: ' ' }).success).toBe(false)
    expect(MemberDisableBodySchema.parse({ reason: ' 已离职 ' })).toEqual({ reason: '已离职' })
    expect(MemberRoleBodySchema.parse({ roleId: 'preset-finance' })).toEqual({ roleId: 'preset-finance' })
    expect(MemberScopesBodySchema.safeParse({ scope: { all: true, sellerAccountIds: ['s1'] } }).success).toBe(false)
    expect(MemberScopesBodySchema.safeParse({ scope: { all: false, sellerAccountIds: ['s1'] }, reason: '调岗' }).success).toBe(true)
  })

  it('新建角色：复制或至少一个权限点；名称至少 2 个字；字段只认三档', () => {
    expect(RoleCreateBodySchema.safeParse({ name: '新角色' }).success).toBe(false)
    expect(RoleCreateBodySchema.safeParse({ name: '新角色', permissions: [] }).success).toBe(false)
    expect(RoleCreateBodySchema.safeParse({ name: '新角色', copyFromRoleId: 'preset-ops' }).success).toBe(true)
    expect(RoleCreateBodySchema.safeParse({ name: '新', permissions: ['orders.read'] }).success).toBe(false)
    expect(RoleCreateBodySchema.safeParse({ name: '新角色', permissions: ['orders.read'], fields: { cost: 'OWNER_ONLY' } }).success).toBe(true)
    expect(RoleCreateBodySchema.safeParse({ name: '新角色', permissions: ['orders.read'], fields: { cost: 'MAYBE' } }).success).toBe(false)
    expect(RoleCreateBodySchema.safeParse({ name: '新角色', permissions: ['orders.read'], fields: { secret: 'VISIBLE' } }).success).toBe(false)
  })

  it('修改角色：必须带版本号且至少改一项；说明可以清空', () => {
    expect(RoleUpdateBodySchema.safeParse({ name: '改名' }).success).toBe(false)
    expect(RoleUpdateBodySchema.safeParse({ version: 1 }).success).toBe(false)
    expect(RoleUpdateBodySchema.safeParse({ version: 1, name: '改名' }).success).toBe(true)
    expect(RoleUpdateBodySchema.parse({ version: 2, description: null }).description).toBeNull()
  })
})

describe('权限与职责分离', () => {
  it('不能授予自己没有的权限点：通配只有通配持有人能授予', () => {
    expect(permissionsActorLacks(['a', 'b'], ['a'])).toEqual([])
    expect(permissionsActorLacks(['a'], ['a', 'b', 'c'])).toEqual(['b', 'c'])
    expect(permissionsActorLacks(['*'], ['a', 'b'])).toEqual([])
    expect(permissionsActorLacks(['a', 'b'], ['*'])).toEqual(['*'])
    expect(permissionsActorLacks(['*'], ['*'])).toEqual([])
  })

  it('职责分离：同时有发起与审批两个不同点位才算冲突；发起与审批是同一个点位的不算', () => {
    const pairs = [
      ['purchase.order.write', 'purchase.order.approve'],
      ['finance.policy.write', 'finance.policy.write'],
    ] as const
    expect(separationConflicts(['purchase.order.write'], pairs)).toEqual([])
    expect(separationConflicts(['purchase.order.write', 'purchase.order.approve'], pairs)).toEqual([['purchase.order.write', 'purchase.order.approve']])
    expect(separationConflicts(['finance.policy.write'], pairs)).toEqual([])
    expect(separationMessage([['a', 'b']], key => `点位${key}`)).toBe('职责分离：“点位a”与“点位b”不能放在同一个角色里，否则同一个人可以自己批准自己的单')
  })

  it('无权限提示：写明缺哪个权限点并指向角色编辑器', () => {
    expect(permissionDeniedMessage('member.read')).toBe('缺少权限点 member.read。请联系企业管理员在“成员与角色”的角色编辑器里为你的角色开通该权限点')
  })

  it('标签：成员状态与审计动作；不认识的原样返回', () => {
    expect(memberStatusLabel('ACTIVE')).toBe('使用中')
    expect(memberStatusLabel('DISABLED')).toBe('已停用')
    expect(memberStatusLabel('X')).toBe('X')
    expect(memberActionLabel('MEMBER_DISABLED')).toBe('停用成员')
    expect(memberActionLabel('SOMETHING')).toBe('SOMETHING')
    expect(Object.keys(MEMBER_ACTION_LABEL)).toEqual(expect.arrayContaining(['MEMBER_INVITED', 'ROLE_UPDATED']))
  })
})
