import { Injectable } from '@nestjs/common'
import { FINANCE_POLICY_HISTORY_LIMIT, FINANCE_POLICY_READ, FINANCE_POLICY_WRITE, policyActionsOf, type FinancePolicyResponse } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { currentOf, fieldInfos, loadFrozenPeriods, POLICY_SELECT, tenantToday, viewOf } from './finance-policy-common'

// 财务口径读取（P2b-15，09 章 9.12 第 2 个页签）：当前口径、待审批的修改、历史版本、每项口径的使用情况、可用动作。
@Injectable()
export class FinancePolicyReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async get(req: RequestWithContext): Promise<FinancePolicyResponse> {
    const context = await this.context.authorize(req, FINANCE_POLICY_READ)
    const tenantId = context.tenantId
    const [current, pendingRow, historyRows, latest, today, frozen] = await Promise.all([
      currentOf(this.prisma, tenantId),
      this.prisma.financePolicyVersion.findFirst({ where: { tenantId, status: 'PENDING' }, select: POLICY_SELECT }),
      this.prisma.financePolicyVersion.findMany({ where: { tenantId, status: { not: 'PENDING' } }, orderBy: { versionNo: 'desc' }, take: FINANCE_POLICY_HISTORY_LIMIT + 1, select: POLICY_SELECT }),
      this.prisma.financePolicyVersion.findFirst({ where: { tenantId }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } }),
      tenantToday(this.prisma, tenantId),
      loadFrozenPeriods(this.prisma, tenantId),
    ])
    const truncated = historyRows.length > FINANCE_POLICY_HISTORY_LIMIT
    const shown = historyRows.slice(0, FINANCE_POLICY_HISTORY_LIMIT)
    const names = await memberNames(this.prisma, tenantId, [...shown.flatMap(row => [row.createdBy, row.decidedBy]), pendingRow?.createdBy, pendingRow?.decidedBy])
    const pending = pendingRow ? viewOf(pendingRow, names, context.userId) : null
    return {
      current,
      pending,
      history: shown.map(row => viewOf(row, names, context.userId)),
      historyTruncated: truncated,
      latestVersionNo: latest?.versionNo ?? 0,
      fields: fieldInfos(),
      today,
      actions: policyActionsOf({ canWrite: hasPermission(context.permissions, FINANCE_POLICY_WRITE), pending, userId: context.userId }),
      frozenPeriodCount: frozen.length,
    }
  }
}
