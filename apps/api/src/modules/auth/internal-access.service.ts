import { Injectable } from '@nestjs/common'
import { hash } from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { appError } from '../../platform/http'
import { SystemPrismaService } from '../../platform/prisma.service'
import type { InternalAccessConfig } from './internal-access'
import { permissionsOfRole } from './role-permissions'

export interface InternalPrincipal {
  userId: string
  membershipId: string
  tenantId: string
  permissions: string[]
}

const CACHE_MS = 60_000

// 内部访问主体：内部访问请求没有个人登录，用一个专用的“内部访问”账号承载——
// 账号状态不是 ACTIVE（不能用密码登录，密码本身也是无人知晓的随机值），只有内部访问模式会使用它；
// 数据范围为内部租户的全部店铺，权限完全由配置的角色决定（以配置为准，每次读取角色，不看成员列表里被改动的角色）。
// 这样审计、创建人等外键都指向真实存在的行，而不是在各处特殊处理。
@Injectable()
export class InternalAccessService {
  private cache = new Map<string, { value: InternalPrincipal; at: number }>()

  constructor(private readonly prisma: SystemPrismaService) {}

  async principal(config: InternalAccessConfig): Promise<InternalPrincipal> {
    const key = `${config.tenantId}:${config.roleId}`
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value

    const tenant = await this.prisma.tenant.findUnique({ where: { id: config.tenantId }, select: { id: true } })
    if (!tenant) throw appError('INTERNAL_ACCESS_NOT_CONFIGURED', 'INTERNAL_ACCESS_TENANT_ID 指向的企业不存在')
    const role = await this.prisma.role.findFirst({
      where: { id: config.roleId, OR: [{ tenantId: null, system: true }, { tenantId: config.tenantId }] },
      include: { fieldPermissions: { select: { fieldKey: true, allowed: true, ownerOnly: true } } },
    })
    if (!role) throw appError('INTERNAL_ACCESS_NOT_CONFIGURED', 'INTERNAL_ACCESS_ROLE_ID 指向的角色不存在，或不属于该企业')

    const email = `internal-access+${tenant.id}@internal.invalid`
    const user = await this.prisma.user.upsert({
      where: { email },
      create: { email, displayName: '内部访问', passwordHash: await hash(randomBytes(32).toString('hex'), 10), status: 'INTERNAL_ACCESS' },
      update: {},
    })
    const membership = await this.prisma.membership.upsert({
      where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } },
      create: { userId: user.id, tenantId: tenant.id, roleId: role.id, status: 'ACTIVE' },
      update: { roleId: role.id, status: 'ACTIVE' },
    })
    const grant = await this.prisma.membershipScope.findFirst({ where: { tenantId: tenant.id, membershipId: membership.id, legalEntityId: null, sellerAccountId: null } })
    if (!grant) await this.prisma.membershipScope.create({ data: { tenantId: tenant.id, membershipId: membership.id, grantedBy: 'internal-access' } })

    const value = { userId: user.id, membershipId: membership.id, tenantId: tenant.id, permissions: permissionsOfRole({ ...role, permissions: role.permissions }) }
    this.cache.set(key, { value, at: Date.now() })
    return value
  }
}
