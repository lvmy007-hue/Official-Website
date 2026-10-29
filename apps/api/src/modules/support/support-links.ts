import { shipmentRefsOfSubject, type OpportunityEvidence, type SupportLinks } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import type { CaseRecord } from './support-common'

// 支持案件详情里的“关联”（P2b-04）：读取时现算，不存关联列——赔付案件里的亚马逊案件编号可以随时回填或改，存下来的关联会过期。
// 关联到别的业务对象，必须同时有对方模块的读取权限，否则不给（避免借支持案件绕过权限看到赔付、货件、商品）。

const REIMBURSEMENT_STATUS_LABEL: Record<string, string> = {
  OPPORTUNITY: '待处理机会',
  DRAFT: '草稿',
  SUBMITTED: '已提交',
  APPROVED: '已批准',
  PARTIAL: '部分赔付',
  PAID: '已赔付',
  REJECTED: '被拒绝',
  CLOSED: '已关闭',
  EXPIRED: '已过期',
}

const evidenceShipments = (value: unknown): OpportunityEvidence[] =>
  (Array.isArray(value) ? (value as OpportunityEvidence[]) : []).filter(item => item && item.kind === 'SHIPMENT' && typeof item.id === 'string').slice(0, 20)

export async function supportLinks(prisma: PrismaService, tenantId: string, scope: ResolvedScope, permissions: readonly string[], row: CaseRecord): Promise<SupportLinks> {
  const mayReimbursement = hasPermission(permissions, 'reimbursements.read')
  const mayInbound = hasPermission(permissions, 'inbound.read')
  const mayProducts = hasPermission(permissions, 'products.read')
  const reimbursement = mayReimbursement
    ? await prisma.reimbursementCase.findFirst({
        where: { tenantId, ...storeWhere(scope), sellerAccountId: row.sellerAccountId, amazonCaseId: row.caseId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, caseNo: true, status: true, sku: true, evidenceRefsJson: true },
      })
    : null
  const shipments: SupportLinks['shipments'] = []
  if (mayInbound) {
    const fromEvidence = reimbursement ? evidenceShipments(reimbursement.evidenceRefsJson) : []
    const found = fromEvidence.length
      ? await prisma.fbaInboundShipment.findMany({
          where: { id: { in: fromEvidence.map(item => item.id) }, plan: { tenantId, ...storeWhere(scope) } },
          select: { id: true, shipmentId: true },
          take: 20,
        })
      : []
    for (const shipment of found) shipments.push({ ref: shipment.shipmentId, label: `货件 ${shipment.shipmentId}`, via: 'EVIDENCE' })
    const refs = shipmentRefsOfSubject(row.subject).filter(ref => !shipments.some(item => item.ref === ref))
    if (refs.length) {
      const named = await prisma.fbaInboundShipment.findMany({
        where: { OR: [{ shipmentId: { in: refs } }, { shipmentConfirmationId: { in: refs } }], plan: { tenantId, ...storeWhere(scope) } },
        select: { shipmentId: true },
        take: 10,
      })
      // 只有在我们自己的货件里确实存在的编号才给链接，不凭文字猜
      for (const shipment of named) if (!shipments.some(item => item.ref === shipment.shipmentId)) shipments.push({ ref: shipment.shipmentId, label: `货件 ${shipment.shipmentId}`, via: 'SUBJECT' })
    }
  }
  const products: SupportLinks['products'] = []
  if (mayProducts && reimbursement?.sku) {
    const product = await prisma.fbaProduct.findFirst({
      where: { tenantId, sellerAccountId: row.sellerAccountId, sellerSku: reimbursement.sku },
      select: { id: true, sellerSku: true, asin: true },
      orderBy: { id: 'asc' },
    })
    if (product) products.push({ id: product.id, sku: product.sellerSku, asin: product.asin })
  }
  return {
    reimbursement: reimbursement ? { id: reimbursement.id, caseNo: reimbursement.caseNo, statusLabel: REIMBURSEMENT_STATUS_LABEL[reimbursement.status] ?? reimbursement.status } : null,
    shipments,
    products,
  }
}
