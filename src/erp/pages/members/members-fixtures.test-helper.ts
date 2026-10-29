import type { InviteResult, MemberDetail, MemberListResponse, MemberRow, RoleEditorView, RoleFields, RolesResponse } from '@nova/api-contracts'

export const ok = (data: unknown) => ({ status: 200, body: { success: true, data } })

const HIDDEN: RoleFields = { cost: 'HIDDEN', profit: 'HIDDEN', buyer: 'HIDDEN' }

export const memberRow = (over: Partial<MemberRow> = {}): MemberRow => ({
  id: 'm2',
  userId: 'u2',
  name: '小王',
  email: 'wang@example.com',
  status: 'ACTIVE',
  roleId: 'r-ops',
  roleName: '运营',
  roleSystem: true,
  scope: { kind: 'ENTITIES', label: '指定主体：深圳跨境科技', entityNames: ['深圳跨境科技'], storeNames: [] },
  lastLoginAt: null,
  createdAt: '2026-10-01T02:00:00.000Z',
  isSelf: false,
  ...over,
})

export const memberList = (over: Partial<MemberListResponse> = {}): MemberListResponse => ({
  items: [
    memberRow({
      id: 'm1',
      userId: 'u1',
      name: '林然',
      email: 'owner@example.com',
      roleId: 'r-owner',
      roleName: '所有者',
      scope: { kind: 'ALL', label: '全部主体与店铺', entityNames: [], storeNames: [] },
      lastLoginAt: '2026-10-24T08:00:00.000Z',
      isSelf: true,
    }),
    memberRow(),
    memberRow({ id: 'm3', userId: 'u3', name: '小张', email: 'zhang@example.com', status: 'DISABLED', roleName: '只读' }),
  ],
  total: 3,
  page: 1,
  pageSize: 50,
  summary: { total: 3, active: 2, disabled: 1, pendingInvitations: 1 },
  roles: [
    { id: 'r-owner', name: '所有者' },
    { id: 'r-ops', name: '运营' },
  ],
  invitations: [
    { id: 'i1', email: 'new@example.com', roleName: '运营', expiresAt: '2026-10-28T02:00:00.000Z', invitedByName: '林然', scopeLabel: '全部主体与店铺', createdAt: '2026-10-25T02:00:00.000Z' },
  ],
  canInvite: true,
  inviteBlockedReason: null,
  canManage: true,
  manageBlockedReason: null,
  ...over,
})

export const roleView = (over: Partial<RoleEditorView> = {}): RoleEditorView => ({
  id: 'r-ops',
  name: '运营',
  system: true,
  description: '日常运营',
  permissions: ['overview.read', 'products.read'],
  fields: HIDDEN,
  presetKey: 'ops',
  version: 1,
  memberCount: 1,
  invitationCount: 1,
  canEdit: false,
  editBlockedReason: '预设角色不能直接修改，请复制后再改（点“复制为自定义角色”）',
  ...over,
})

export const memberDetail = (over: Partial<MemberDetail> = {}): MemberDetail => ({
  member: { ...memberRow(), disabledAt: null, disabledReason: null },
  role: roleView(),
  roles: [
    { id: 'r-owner', name: '所有者' },
    { id: 'r-ops', name: '运营' },
  ],
  grants: [{ id: 'g1', kind: 'ENTITY', refId: 'e1', name: '深圳跨境科技', grantedAt: '2026-10-01T02:00:00.000Z', note: null }],
  sessions: [{ id: 's1', loginAt: '2026-10-24T08:00:00.000Z', lastSeenAt: '2026-10-24T09:00:00.000Z', ipMasked: '203.0.113.*', device: 'Chrome / Windows', state: 'ACTIVE' }],
  sessionsTruncated: false,
  audit: {
    state: 'OK',
    items: [
      {
        id: 'a1',
        occurredAt: '2026-10-02T03:00:00.000Z',
        action: 'MEMBER_ROLE_CHANGED',
        actionLabel: '修改角色',
        resourceType: 'Membership',
        result: '成功',
        asActor: false,
        operator: '林然',
        reason: '转岗到运营',
      },
    ],
    truncated: false,
  },
  canManage: true,
  manageBlockedReason: null,
  actions: { disable: null, enable: '该成员正在使用中，不需要恢复', role: null, scopes: null },
  ...over,
})

export const rolesResponse = (over: Partial<RolesResponse> = {}): RolesResponse => ({
  items: [
    roleView({
      id: 'r-owner',
      name: '所有者',
      permissions: ['*'],
      presetKey: 'owner',
      fields: { cost: 'VISIBLE', profit: 'VISIBLE', buyer: 'VISIBLE' },
      memberCount: 1,
      invitationCount: 0,
      description: '企业所有者',
    }),
    roleView(),
    roleView({
      id: 'r-custom',
      name: '采购专员',
      system: false,
      description: null,
      permissions: ['purchase.read', 'purchase.order.write'],
      fields: { cost: 'OWNER_ONLY', profit: 'HIDDEN', buyer: 'HIDDEN' },
      presetKey: null,
      version: 4,
      memberCount: 2,
      invitationCount: 0,
      canEdit: true,
      editBlockedReason: null,
    }),
  ],
  canManage: true,
  manageBlockedReason: null,
  customCount: 1,
  customLimit: 50,
  ...over,
})

export const inviteResult = (over: Partial<InviteResult> = {}): InviteResult => ({
  invitationId: 'i9',
  email: 'new@example.com',
  expiresAt: '2026-10-28T02:00:00.000Z',
  link: 'https://erp.example.com/invite/abc123',
  emailed: false,
  replacedPrevious: 1,
  warnings: ['成员数将超过报价约定的 5 人'],
  ...over,
})
