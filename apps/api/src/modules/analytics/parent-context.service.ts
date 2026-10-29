import { Injectable } from '@nestjs/common'
import { ParentAsinParamSchema, type BrRange } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { loadFamily, type Family } from './asin-analytics-load'
import type { ChildAsin } from './asin-analytics-math'
import { AsinSelectionService } from './asin-analytics-selection.service'
import { BusinessReportsAccessService, type BrAccess } from './business-reports-access.service'

// 父体详情各页签共用的准入（P4-03）：先权限（analytics.read）与数据范围，再校验父体编号，再读它在商品目录里的家族；
// 范围内没有这个父体（没有商品记录也没有父子关系）与不存在一样返回 404，不泄露它是否存在。

export interface ParentContext {
  access: BrAccess
  parentAsin: string
  family: Family
  members: ChildAsin[]
  membersTruncated: boolean
  range: BrRange
}

@Injectable()
export class ParentContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessReportsAccessService,
    private readonly selecting: AsinSelectionService,
  ) {}

  /** extra：页签数据再要求的权限（例如库存页签要 inventory.read），同样先于参数校验与查库。 */
  async resolve(req: RequestWithContext, rawQuery: Record<string, string>, rawParent: string, now = new Date(), extra: readonly string[] = []): Promise<ParentContext> {
    const access = await this.access.resolve(req, rawQuery, now)
    for (const permission of extra) if (!hasPermission(access.permissions, permission)) throw appError('TENANT_ACCESS_DENIED', '当前账号没有查看这个页签的权限')
    const parentAsin = ParentAsinParamSchema.parse(rawParent)
    const family = await loadFamily(this.prisma, access.tenantId, access.scope, parentAsin)
    if (family.products.length === 0 && family.relationOnly.length === 0) throw appError('RESOURCE_NOT_FOUND', '父体不存在或不在你的数据范围内')
    const { period } = access.periods
    const range: BrRange = { from: period.from, to: period.to, days: period.days, defaulted: access.periods.defaulted }
    const { members, truncated } = await this.selecting.membersOf(access, family, parentAsin, range)
    return { access, parentAsin, family, members, membersTruncated: truncated, range }
  }
}
