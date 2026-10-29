import { createHash } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { ATTACHMENT_MAX_BYTES, AttachmentConfirmBodySchema, AttachmentTicketBodySchema, type AttachmentLink, type AttachmentRow, type AttachmentTicket } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ObjectStorageService, storageAppError } from '../../platform/storage'
import { AuditWriter } from '../../platform/write'
import { ContextService } from '../auth'
import { isoText, isUniqueViolation, PO_READ, PO_WRITE, SUPPLIER_READ, SUPPLIER_WRITE } from './procurement-common'

export type AttachmentEntityType = 'PURCHASE_ORDER' | 'SUPPLIER' | 'FIRST_MILE' | 'INBOUND_SHIPMENT' | 'REIMBURSEMENT_CASE'
type EntityType = AttachmentEntityType

const RULES: Record<EntityType, { read: string; write: string; label: string; resourceType: string }> = {
  PURCHASE_ORDER: { read: PO_READ, write: PO_WRITE, label: '采购单', resourceType: 'PurchaseOrder' },
  SUPPLIER: { read: SUPPLIER_READ, write: SUPPLIER_WRITE, label: '供应商', resourceType: 'Supplier' },
  FIRST_MILE: { read: 'firstmile.read', write: 'firstmile.write', label: '头程运单', resourceType: 'FirstMileShipment' },
  // 入仓货件的证据附件（P2a-13）：装箱单、提单、签收证明；货件在成员数据范围内由调用方（入仓模块）先校验
  INBOUND_SHIPMENT: { read: 'inbound.read', write: 'inbound.plan.write', label: '入仓货件', resourceType: 'FbaInboundShipment' },
  // 赔付案件的证据附件（P2b-03）：平台后台截图、亚马逊回复、签收证明；案件在成员数据范围内由调用方（赔付模块）先校验
  REIMBURSEMENT_CASE: { read: 'reimbursements.read', write: 'reimbursements.write', label: '赔付案件', resourceType: 'ReimbursementCase' },
}
const LINK_TTL_SECONDS = 300

// 采购单与供应商的附件：先申请签名直传凭据（类型与大小在这里校验），浏览器直接把文件传到对象存储，再调用“确认”登记。
// 确认时复核文件存在、大小不超限，并按内容摘要去重（同一对象下相同内容只留一份）；下载走短时签名链接，不经接口服务转发。
@Injectable()
export class AttachmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly objects: ObjectStorageService,
  ) {}

  private async assertEntity(tenantId: string, type: EntityType, id: string) {
    const where = { id, tenantId }
    const select = { id: true }
    const found =
      type === 'PURCHASE_ORDER'
        ? await this.prisma.purchaseOrder.findFirst({ where, select })
        : type === 'SUPPLIER'
          ? await this.prisma.supplier.findFirst({ where, select })
          : type === 'FIRST_MILE'
            ? await this.prisma.firstMileShipment.findFirst({ where, select })
            : type === 'REIMBURSEMENT_CASE'
              ? await this.prisma.reimbursementCase.findFirst({ where, select })
              : await this.prisma.fbaInboundShipment.findFirst({ where: { id, plan: { tenantId } }, select })
    if (!found) throw appError('RESOURCE_NOT_FOUND', `${RULES[type].label}不存在`)
  }

  async list(tenantId: string, type: EntityType, id: string): Promise<AttachmentRow[]> {
    const rows = await this.prisma.attachment.findMany({ where: { tenantId, entityType: type, entityId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 })
    const names = await memberNames(
      this.prisma,
      tenantId,
      rows.map(row => row.uploadedBy),
    )
    return rows.map(row => ({
      id: row.id,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      uploadedBy: nameOrFormer(names, row.uploadedBy),
      uploadedAt: isoText(row.createdAt) as string,
    }))
  }

  /** 申请直传凭据：校验类型与大小，路径由服务端生成（不可猜测、绑定租户）。 */
  async ticket(req: RequestWithContext, type: EntityType, id: string, rawBody: unknown): Promise<AttachmentTicket> {
    const context = await this.context.authorize(req, RULES[type].write)
    const body = AttachmentTicketBodySchema.parse(rawBody)
    await this.assertEntity(context.tenantId, type, id)
    const maxBytes = Math.min(ATTACHMENT_MAX_BYTES, this.objects.maxUploadBytes())
    if (body.sizeBytes > maxBytes) throw appError('FILE_TOO_LARGE', '文件超过大小上限', { fieldErrors: { sizeBytes: [`单个附件不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB`] } })
    try {
      const signed = await this.objects.forTenant(context.tenantId).signUpload({ domain: 'attachments', name: body.fileName }, { contentType: body.contentType, maxBytes })
      return { uploadUrl: signed.url, method: 'PUT', headers: signed.headers, objectKey: signed.key, expiresAt: signed.expiresAt.toISOString(), maxBytes }
    } catch (error) {
      throw storageAppError(error)
    }
  }

  /** 确认上传完成并登记：文件必须已经在存储里，且属于本租户。 */
  async confirm(req: RequestWithContext, type: EntityType, id: string, rawBody: unknown): Promise<AttachmentRow> {
    const context = await this.context.authorize(req, RULES[type].write)
    const body = AttachmentConfirmBodySchema.parse(rawBody)
    await this.assertEntity(context.tenantId, type, id)
    const store = this.objects.forTenant(context.tenantId)
    let sha256: string
    let sizeBytes: number
    try {
      const meta = await store.confirmUpload(body.objectKey, Math.min(ATTACHMENT_MAX_BYTES, this.objects.maxUploadBytes()))
      const hash = createHash('sha256')
      for await (const chunk of await store.read(body.objectKey)) hash.update(chunk as Buffer)
      sha256 = hash.digest('hex')
      sizeBytes = meta.sizeBytes
    } catch (error) {
      throw storageAppError(error)
    }
    const duplicate = await this.prisma.attachment.findFirst({ where: { tenantId: context.tenantId, objectKey: body.objectKey }, select: { id: true } })
    if (duplicate) throw appError('CONFLICT', '这个文件已经登记过了')
    try {
      const row = await this.prisma.$transaction(async tx => {
        const created = await tx.attachment.create({
          data: {
            tenantId: context.tenantId,
            entityType: type,
            entityId: id,
            fileName: body.fileName,
            contentType: body.contentType,
            objectKey: body.objectKey,
            sizeBytes,
            sha256,
            uploadedBy: context.userId,
          },
        })
        await this.audit.record(
          req,
          { action: 'ATTACHMENT_ADDED', resourceType: RULES[type].resourceType, resourceId: id, after: { attachmentId: created.id, fileName: body.fileName, sizeBytes } },
          { client: tx },
        )
        return created
      })
      const names = await memberNames(this.prisma, context.tenantId, [context.userId])
      return { id: row.id, fileName: row.fileName, contentType: row.contentType, sizeBytes: row.sizeBytes, uploadedBy: nameOrFormer(names, context.userId), uploadedAt: row.createdAt.toISOString() }
    } catch (error) {
      if (isUniqueViolation(error)) {
        await store.remove(body.objectKey)
        throw appError('CONFLICT', '这份附件已经上传过（内容相同的文件只保留一份）')
      }
      throw error
    }
  }

  async download(req: RequestWithContext, type: EntityType, id: string, attachmentId: string): Promise<AttachmentLink> {
    const context = await this.context.authorize(req, RULES[type].read)
    const row = await this.prisma.attachment.findFirst({ where: { id: attachmentId, tenantId: context.tenantId, entityType: type, entityId: id } })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '附件不存在')
    try {
      const signed = await this.objects.forTenant(context.tenantId).signDownload(row.objectKey, LINK_TTL_SECONDS)
      return { url: signed.url, expiresAt: signed.expiresAt.toISOString() }
    } catch (error) {
      throw storageAppError(error)
    }
  }
}
