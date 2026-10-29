import {
  AUDIT_FORMER_MEMBER_LABEL,
  auditAccessModeLabel,
  auditAccessModeOfDetail,
  auditActionLabel,
  auditActorOf,
  auditFilterClauses,
  auditFiltersFromExport,
  auditResultLabel,
  auditSourceLabel,
  auditSourceOf,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import type { ExportRow, SourceContext } from './sources'

// 审计日志导出（P5-09）：筛选与审计中心列表同一套（共用契约里的 auditFilterClauses），按发生时间从新到旧；不分店铺。
// 只导出列表上有的信息加来源地址，不含修改前后的内容与浏览器信息；操作人写名字（已离开的成员写“已离开的成员”），系统任务写“系统”。

const PAGE_SIZE = 2000 // 与 sources.ts 的页大小一致；不从 sources 引入，避免两个文件互相引用

export async function* auditEvents({ db, tenantId, filters }: SourceContext): AsyncGenerator<ExportRow> {
  const where = { AND: [{ tenantId }, ...auditFilterClauses(auditFiltersFromExport(filters))] } as Prisma.AuditEventWhereInput
  const names = new Map<string, string>()
  let after: { occurredAt: Date; id: string } | undefined
  for (;;) {
    const rows = await db.auditEvent.findMany({
      where: after ? { AND: [where, { OR: [{ occurredAt: { lt: after.occurredAt } }, { occurredAt: after.occurredAt, id: { lt: after.id } }] }] } : where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE,
      select: {
        id: true,
        occurredAt: true,
        actorId: true,
        action: true,
        resourceType: true,
        resourceId: true,
        requestId: true,
        result: true,
        reason: true,
        source: true,
        page: true,
        detail: true,
        ip: true,
      },
    })
    const unknown = [...new Set(rows.flatMap(row => (row.actorId && !names.has(row.actorId) ? [row.actorId] : [])))]
    if (unknown.length > 0) {
      const members = await db.membership.findMany({
        where: { tenantId, userId: { in: unknown } },
        select: { userId: true, user: { select: { displayName: true, email: true } } },
        take: unknown.length,
      })
      for (const member of members) names.set(member.userId, member.user.displayName || member.user.email)
      // 已离开的成员也记一个名字，避免下一页重复查询
      for (const id of unknown) if (!names.has(id)) names.set(id, AUDIT_FORMER_MEMBER_LABEL)
    }
    for (const row of rows) {
      const mode = auditAccessModeOfDetail(row.detail)
      yield {
        occurredAt: row.occurredAt,
        actorName: auditActorOf(row, names).name,
        sourceLabel: auditSourceLabel(auditSourceOf(row.source, row.actorId)),
        page: row.page,
        action: row.action,
        actionLabel: auditActionLabel(row.action),
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        resultLabel: auditResultLabel(row.result),
        reason: row.reason,
        accessModeLabel: auditAccessModeLabel(mode),
        ip: row.ip,
        requestId: row.requestId,
      }
    }
    if (rows.length < PAGE_SIZE) return
    const last = rows[rows.length - 1]
    after = { occurredAt: last.occurredAt, id: last.id }
  }
}
