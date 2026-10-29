import { Injectable } from '@nestjs/common'
import { SUPPORT_CONTACTS_PER_CASE_MAX, SUPPORT_READ, type SupportCaseDetailResponse } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'
import { CASE_SELECT, CONTACT_SELECT, ID_PATTERN, appointmentRows, caseRow, contactRow, supportSync } from './support-common'
import { supportLinks } from './support-links'

// 支持案件详情（07 章 7.4）：案件、预约回电、沟通记录（按时间从早到晚）、关联的赔付案件 / 货件 / 商品。只读：所有修改都在卖家后台进行。
// :id 可以是系统编号，也可以是亚马逊案件编号（多个店铺碰巧同号时取最近更新的那个，且只会在成员的数据范围内找）。
@Injectable()
export class SupportDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async detail(req: RequestWithContext, id: string): Promise<SupportCaseDetailResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, SUPPORT_READ, {})
    if (!ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '支持案件不存在')
    const tenantId = context.tenantId
    const row = await this.prisma.supportCase.findFirst({
      where: { tenantId, ...storeWhere(scope), OR: [{ id }, { caseId: id }] },
      orderBy: { amazonUpdatedAt: 'desc' },
      select: { ...CASE_SELECT, appointmentsJson: true },
    })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '支持案件不存在')
    const [contacts, links, sync] = await Promise.all([
      this.prisma.supportContact.findMany({
        where: { tenantId, supportCaseId: row.id },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take: SUPPORT_CONTACTS_PER_CASE_MAX,
        select: CONTACT_SELECT,
      }),
      supportLinks(this.prisma, tenantId, scope, context.permissions, row),
      supportSync(this.prisma, tenantId, scope),
    ])
    const synced = row.contactsForUpdatedAt !== null
    const stale = synced && row.contactsForUpdatedAt?.getTime() !== row.amazonUpdatedAt.getTime()
    const contactsState = !synced ? 'NOT_SYNCED' : contacts.length === 0 ? 'NO_DATA' : 'OK'
    const contactsNote = !synced
      ? '沟通记录尚未同步：案件刚出现，或有新的更新，下一次同步（每 2 小时）会取回'
      : contacts.length === 0
        ? '尚无记录：亚马逊没有返回这个案件的沟通记录'
        : stale
          ? '案件有新的更新，最新的沟通记录会在下一次同步取回'
          : contacts.length >= SUPPORT_CONTACTS_PER_CASE_MAX
            ? `沟通记录较多，这里只显示最早的 ${SUPPORT_CONTACTS_PER_CASE_MAX} 条`
            : null
    return {
      case: caseRow(row, links.reimbursement),
      appointments: appointmentRows(row.appointmentsJson),
      contacts: contacts.map(contactRow),
      contactsState,
      contactsNote,
      links,
      sync: sync.sync,
      freshness: sync.freshness,
    }
  }
}
