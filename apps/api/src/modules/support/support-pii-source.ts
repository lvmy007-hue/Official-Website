import { Injectable } from '@nestjs/common'
import { SUPPORT_READ } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import type { PiiRecord, PiiSource } from '../../platform/security/pii-source'
import { ContextService, storeWhere } from '../auth'
import { ID_PATTERN } from './support-common'

// 支持案件沟通内容的来源（P6-14）：在支持读权限与店铺范围内找到一条沟通记录并交出正文，不写审计（统一出口 POST /pii/reveal 负责）。
// 案件详情里的正文只给掩码版本（电话、邮箱、地址已隐藏）；完整正文要走统一出口，填理由并留下审计。
// 沟通正文是亚马逊案件消息，同步时按原文保存（没有保留期，随案件保留）。
@Injectable()
export class SupportPiiSource implements PiiSource {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async open(req: RequestWithContext, objectId: string): Promise<PiiRecord> {
    const { context, scope } = await this.context.authorizeScoped(req, SUPPORT_READ, {})
    if (!ID_PATTERN.test(objectId)) throw appError('RESOURCE_NOT_FOUND', '沟通记录不存在')
    const row = await this.prisma.supportContact.findFirst({
      where: { id: objectId, tenantId: context.tenantId, ...storeWhere(scope) },
      select: { id: true, sellerAccountId: true, body: true, supportCase: { select: { caseId: true } } },
    })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '沟通记录不存在')
    return {
      resourceType: 'SupportContact',
      resourceId: row.id,
      detail: { caseId: row.supportCase.caseId, storeId: row.sellerAccountId },
      stored: { kind: 'PLAIN', values: { body: row.body } },
      retainedUntil: null,
      notes: { EXPIRED: '这条沟通记录已不在系统里', NOT_SYNCED: '这条沟通记录没有正文' },
    }
  }
}
