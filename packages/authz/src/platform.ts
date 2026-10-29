// 平台运营后台权限（freeze/permissions.md 第八节）：与租户权限体系完全分离，租户的所有者也不具备。
// 平台账号单独存放（PlatformAdmin），强制多因素验证，不与租户成员混用。

export const PLATFORM_PERMISSIONS = ['platform.tenant.read', 'platform.tenant.manage', 'platform.support.access', 'platform.quota.manage'] as const
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number]

export const PLATFORM_ROLE_KEYS = ['PLATFORM_OWNER', 'PLATFORM_OPS', 'PLATFORM_SUPPORT'] as const
export type PlatformRoleKey = (typeof PLATFORM_ROLE_KEYS)[number]

export const PLATFORM_ROLE_LABELS: Record<PlatformRoleKey, string> = {
  PLATFORM_OWNER: '平台所有者',
  PLATFORM_OPS: '平台运营',
  PLATFORM_SUPPORT: '平台支持',
}

// 平台所有者：全部；平台运营：开通与生命周期、配额，不做支持访问；平台支持：只读租户并发起（经租户授权的）限时支持访问。
export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRoleKey, readonly PlatformPermission[]> = {
  PLATFORM_OWNER: PLATFORM_PERMISSIONS,
  PLATFORM_OPS: ['platform.tenant.read', 'platform.tenant.manage', 'platform.quota.manage'],
  PLATFORM_SUPPORT: ['platform.tenant.read', 'platform.support.access'],
}

export const isPlatformRole = (value: string): value is PlatformRoleKey => (PLATFORM_ROLE_KEYS as readonly string[]).includes(value)

export const platformPermissionsOf = (role: string): readonly PlatformPermission[] => (isPlatformRole(role) ? PLATFORM_ROLE_PERMISSIONS[role] : [])

export const hasPlatformPermission = (role: string, required: PlatformPermission) => platformPermissionsOf(role).includes(required)
