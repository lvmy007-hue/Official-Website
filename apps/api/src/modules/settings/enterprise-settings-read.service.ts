import { Injectable } from '@nestjs/common'
import { AUDIT_LOG_RETENTION_NOTE, FIXED_SCHEDULES, REFRESH_SETTING_KEY, RETENTION_SETTING_KEY, SETTINGS_READ, SETTINGS_WRITE, type EnterpriseSettingsResponse } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { FORMER_MEMBER_LABEL, memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { editorOf, internalAccessView, loadStoredSettings, refreshItems, retentionItems, riskSummary, storedRefresh, storedRetention } from './enterprise-settings-common'

// 企业设置总览（P5-10，09 章 9.12；freeze/api.md GET /settings）：基本信息、数据保留、刷新策略、风险规则版本、内部访问模式。
// 财务口径、接口与写入开关、汇率各有自己的接口，这里不重复。
@Injectable()
export class EnterpriseSettingsReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async get(req: RequestWithContext): Promise<EnterpriseSettingsResponse> {
    const context = await this.context.authorize(req, SETTINGS_READ)
    const tenantId = context.tenantId
    const [tenant, stored, risk, internal] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, slug: true, mode: true, timezone: true, localTimezone: true, defaultCurrency: true, updatedAt: true } }),
      loadStoredSettings(this.prisma, tenantId),
      riskSummary(this.prisma, tenantId),
      internalAccessView(this.prisma, tenantId),
    ])
    const retentionRow = stored.get(RETENTION_SETTING_KEY)
    const refreshRow = stored.get(REFRESH_SETTING_KEY)
    const names = await memberNames(this.prisma, tenantId, [retentionRow?.updatedBy, refreshRow?.updatedBy])
    const refresh = storedRefresh(refreshRow)
    return {
      canWrite: hasPermission(context.permissions, SETTINGS_WRITE),
      basic: {
        name: tenant.name,
        slug: tenant.slug,
        mode: tenant.mode,
        dataTimezone: tenant.timezone,
        localTimezone: tenant.localTimezone,
        defaultCurrency: tenant.defaultCurrency,
        version: tenant.updatedAt.getTime(),
        updatedAt: tenant.updatedAt.toISOString(),
      },
      retention: {
        ...editorOf(retentionRow, names, FORMER_MEMBER_LABEL),
        version: retentionRow?.version ?? 0,
        items: retentionItems(storedRetention(retentionRow)),
        auditLog: AUDIT_LOG_RETENTION_NOTE,
      },
      refresh: {
        ...editorOf(refreshRow, names, FORMER_MEMBER_LABEL),
        version: refreshRow?.version ?? 0,
        items: refreshItems(refresh),
        fixed: FIXED_SCHEDULES,
        pausedCount: Object.values(refresh).filter(item => item.mode === 'PAUSED').length,
      },
      risk,
      internal,
    }
  }
}
