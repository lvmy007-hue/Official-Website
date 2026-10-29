import { Injectable } from '@nestjs/common'
import { INVITATION_TTL_HOURS, INVITE_EMAIL_TAKEN, MEMBER_ACTIONS, MEMBER_INVITE, MemberInviteBodySchema, OWNER_ROLE_ID, scopeKindOf, scopeLabelOf, type InviteResult } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { MailService } from '../../platform/mail'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService, assertUnrestricted } from '../auth'
import { appPublicUrl, generateInviteToken, hashInviteToken, inviteLink } from '../lifecycle'
import { MemberSystemService } from './member-system.service'
import { OWNER_SCOPE_BLOCKED, assertRoleGrantable, resolveScopeGrants } from './members-guards'
import { scopeNamesOf } from './members-common'

const MEMBERS_QUOTA_KEY = 'members'

// 邀请成员（P5-08）：令牌只存哈希、72 小时有效；同一邮箱再次邀请会作废之前未接受的邀请。
// 邮件通道未配置时，链接只在这一次响应里返回，由管理员复制后交付（14.10）；已发邮件则不返回链接。
@Injectable()
export class MembersInviteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly system: MemberSystemService,
    private readonly mail: MailService,
  ) {}

  async invite(req: RequestWithContext, rawBody: unknown): Promise<InviteResult> {
    const { context, scope } = await this.context.authorizeScoped(req, MEMBER_INVITE, {})
    assertUnrestricted(scope)
    const body = MemberInviteBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const base = appPublicUrl()
    if (!base) throw appError('DEPENDENCY_UNAVAILABLE', '站点地址（APP_PUBLIC_URL）未配置，无法生成邀请链接，请联系平台运营')
    const role = await this.system.role(tenantId, body.roleId)
    if (!role) throw appError('VALIDATION_FAILED', '所选角色不存在', { fieldErrors: { roleId: ['所选角色不存在'] } })
    assertRoleGrantable(context.permissions, role)
    if (role.id === OWNER_ROLE_ID && !body.scope.all) throw appError('VALIDATION_FAILED', OWNER_SCOPE_BLOCKED, { fieldErrors: { scope: [OWNER_SCOPE_BLOCKED] } })
    const grants = await resolveScopeGrants(this.prisma, tenantId, body.scope)
    if (await this.system.emailRegistered(body.email)) throw appError('DATA_CONDITION_FAILED', INVITE_EMAIL_TAKEN, { fieldErrors: { email: [INVITE_EMAIL_TAKEN] } })

    const names = await scopeNamesOf(this.prisma, tenantId, grants)
    const scopeLabel = scopeLabelOf(
      scopeKindOf(grants),
      grants.flatMap(grant => (grant.legalEntityId ? [names.entities.get(grant.legalEntityId) ?? ''] : [])),
      grants.flatMap(grant => (grant.sellerAccountId ? [names.stores.get(grant.sellerAccountId) ?? ''] : [])),
    )
    const token = generateInviteToken()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_HOURS * 3600_000)
    const created = await this.prisma.$transaction(async tx => {
      // 同一邮箱只保留最新一封有效邀请：旧的作废，旧链接立即失效
      const replaced = await tx.memberInvitation.updateMany({ where: { tenantId, email: body.email, status: 'PENDING' }, data: { status: 'REVOKED' } })
      const row = await tx.memberInvitation.create({
        data: {
          tenantId,
          email: body.email,
          roleId: role.id,
          scopeSnapshot: { all: body.scope.all, legalEntityIds: body.scope.legalEntityIds, sellerAccountIds: body.scope.sellerAccountIds },
          tokenHash: hashInviteToken(token),
          expiresAt,
          invitedBy: context.userId,
        },
      })
      // 审计里只记邮箱、角色、范围与有效期；链接与令牌不进审计
      await this.audit.record(
        req,
        {
          action: MEMBER_ACTIONS.invited,
          resourceType: 'MemberInvitation',
          resourceId: row.id,
          after: { email: body.email, roleId: role.id, roleName: role.name, scope: scopeLabel, expiresAt: expiresAt.toISOString(), replacedPrevious: replaced.count },
        },
        { client: tx },
      )
      return { row, replaced: replaced.count }
    })

    const warnings: string[] = []
    const quota = await this.prisma.tenantQuota.findUnique({ where: { tenantId_quotaKey: { tenantId, quotaKey: MEMBERS_QUOTA_KEY } } })
    if (quota) {
      const [active, pending] = await Promise.all([
        this.prisma.membership.count({ where: { tenantId, status: 'ACTIVE' } }),
        this.prisma.memberInvitation.count({ where: { tenantId, status: 'PENDING', expiresAt: { gt: now } } }),
      ])
      if (active + pending > quota.limitValue) warnings.push(`成员数（含待接受的邀请）将超过报价约定的 ${quota.limitValue} 人，请联系平台运营调整配额`)
    }
    const [tenant, inviter] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }),
      this.prisma.user.findFirst({ where: { id: context.userId }, select: { displayName: true } }),
    ])
    const link = inviteLink(base, token)
    const sent = await this.mail.send(body.email, { kind: 'invitation', companyName: tenant.name, link, expiresAt, ...(inviter ? { inviterName: inviter.displayName } : {}) })
    return {
      invitationId: created.row.id,
      email: body.email,
      expiresAt: expiresAt.toISOString(),
      link: sent.delivered ? null : link,
      emailed: sent.delivered,
      replacedPrevious: created.replaced,
      warnings,
    }
  }
}
