import { Injectable } from '@nestjs/common'
import { AWD_LABELS_JOB, type AwdLabelResponse } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ObjectStorageService, storageAppError } from '../../platform/storage'
import { AuditWriter } from '../../platform/write'
import { ContextService, storeWhere } from '../auth'
import { AWD_READ, labelStatusLabel } from './awd-common'
import { AwdJobService } from './awd-jobs.service'

const LABEL_LINK_TTL_SECONDS = 300

// 货件标签：亚马逊异步生成，后台任务取回 PDF 存入文件存储；这里只发起获取、查询状态、签发短时下载链接。
// 取标签是只读调用（不改变亚马逊上的任何数据），不受写入开关控制，只要求查看权限与有效的店铺授权。
@Injectable()
export class AwdLabelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly jobs: AwdJobService,
    private readonly objects: ObjectStorageService,
  ) {}

  private async shipmentOf(tenantId: string, scope: Parameters<typeof storeWhere>[0], id: string) {
    const shipment = await this.prisma.awdInboundShipment.findFirst({ where: { id, tenantId, ...storeWhere(scope) } })
    if (!shipment) throw appError('RESOURCE_NOT_FOUND', '入库货件不存在')
    return shipment
  }

  async labels(req: RequestWithContext, id: string): Promise<AwdLabelResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, AWD_READ, {})
    const shipment = await this.shipmentOf(context.tenantId, scope, id)
    const base = { shipmentId: shipment.shipmentId, labelStatus: shipment.labelStatus, labelStatusLabel: labelStatusLabel(shipment.labelStatus) }
    if (shipment.labelStatus !== 'GENERATED' || !shipment.labelObjectKey) {
      return { ...base, url: null, expiresAt: null, note: shipment.labelStatus === 'GENERATING' ? '亚马逊正在生成标签，请稍后刷新' : '还没有获取标签，点击“获取标签”向亚马逊请求' }
    }
    try {
      const signed = await this.objects.forTenant(context.tenantId).signDownload(shipment.labelObjectKey, LABEL_LINK_TTL_SECONDS)
      return { ...base, url: signed.url, expiresAt: signed.expiresAt.toISOString(), note: null }
    } catch (error) {
      throw storageAppError(error)
    }
  }

  /** 发起获取（或重新获取）标签：交给后台任务；任务内每 30 秒查一次，最多等 10 分钟。 */
  async request(req: RequestWithContext, id: string): Promise<{ state: 'QUEUED'; jobId: string }> {
    const { context, scope } = await this.context.authorizeScoped(req, AWD_READ, {})
    const shipment = await this.shipmentOf(context.tenantId, scope, id)
    if (shipment.status === 'CANCELLED') throw appError('CONFLICT', '货件已取消，没有可获取的标签')
    const connection = await this.jobs.connectionOf(context.tenantId, shipment.sellerAccountId)
    const job = await this.prisma.$transaction(async tx => {
      const created = await this.jobs.createJob(tx, {
        tenantId: context.tenantId,
        connectionId: connection.id,
        type: AWD_LABELS_JOB,
        requestId: req.requestId,
        objectId: shipment.id,
        context: { awdShipmentId: shipment.shipmentId },
      })
      await tx.awdInboundShipment.update({ where: { id: shipment.id }, data: { labelStatus: 'GENERATING' } })
      await this.audit.record(req, { action: 'AWD_LABEL_REQUESTED', resourceType: 'AwdInboundShipment', resourceId: shipment.id, detail: { shipmentId: shipment.shipmentId } }, { client: tx })
      return created
    })
    await this.jobs.dispatchLabels(req, job, { tenantId: context.tenantId, awdShipmentId: shipment.shipmentId })
    return { state: 'QUEUED', jobId: job.id }
  }
}
