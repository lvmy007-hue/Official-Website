import { BOX_LABEL_KIND, EXPORT_CONTENT_TYPE, ITEM_LABEL_KIND, exportFileName, parseBoxLabelJob, parseItemLabelJob } from '@nova/api-contracts'
import type { TenantObjectStore } from '@nova/storage'
import type { ExportJob, Prisma, PrismaClient } from '@prisma/client'
import type { Readable } from 'node:stream'
import { buildBoxLabelPdf } from '../labels/box-label-pdf'
import { LabelError } from '../labels/errors'
import { buildItemLabelPdf } from '../labels/item-label-pdf'
import { EXPORT_MAX_FILE_BYTES, ExportFailure } from './failure'

// 文档类导出（PDF）的生成：自定义箱标签与商品标签（P6-12）。任务内容是发起时存下的快照（filterJson），
// 这里只读取亚马逊箱标签文件、按快照排版成 PDF、写进对象存储；权限与店铺范围已由 run-export 按发起人此刻的权限复核，这里再核对计划所属店铺。

export interface LabelExportResult {
  rows: number
  bytes: number
  key: string
  /** 成功后与任务状态同一个事务写入的“生成记录”。 */
  log: Prisma.LabelPrintLogUncheckedCreateInput
}

const BASE_MAX_BYTES = 100 * 1024 * 1024

async function readAll(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > max) {
      stream.destroy()
      throw new LabelError('LABEL_BASE_INVALID', '亚马逊箱标签文件超过大小上限，无法处理')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

export function isLabelKind(kind: string) {
  return kind === BOX_LABEL_KIND || kind === ITEM_LABEL_KIND
}

export async function renderLabelExport(input: {
  db: PrismaClient
  store: TenantObjectStore
  tenantId: string
  job: ExportJob
  storeIds: string[] | null
  now: Date
  fontPath: string | undefined
}): Promise<LabelExportResult> {
  try {
    return await render(input)
  } catch (error) {
    // 标签生成的可预期失败带着原因码，落到任务上给用户看；其余异常按未知错误处理
    if (error instanceof LabelError) throw new ExportFailure(error.code, error.message)
    throw error
  }
}

async function render(input: {
  db: PrismaClient
  store: TenantObjectStore
  tenantId: string
  job: ExportJob
  storeIds: string[] | null
  now: Date
  fontPath: string | undefined
}): Promise<LabelExportResult> {
  const { db, store, tenantId, job, now } = input
  const fileName = exportFileName(job.kind === BOX_LABEL_KIND ? '自定义箱标签' : '商品标签', 'PDF', now)
  const put = async (bytes: Uint8Array) => {
    const stored = await store.put({ domain: 'exports', name: 'labels.pdf', date: now }, Buffer.from(bytes), {
      contentType: EXPORT_CONTENT_TYPE.PDF,
      contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      maxBytes: EXPORT_MAX_FILE_BYTES,
    })
    return { key: stored.key, bytes: stored.sizeBytes }
  }
  const planOf = async (planId: string) => {
    const plan = await db.fbaInboundPlan.findFirst({ where: { id: planId, tenantId }, select: { id: true, sellerAccountId: true } })
    if (!plan) throw new LabelError('LABEL_JOB_INVALID', '入仓计划已不存在')
    if (input.storeIds !== null && !input.storeIds.includes(plan.sellerAccountId)) throw new LabelError('LABEL_SCOPE_DENIED', '发起人当前没有这个计划所属店铺的数据权限')
    return plan
  }

  if (job.kind === BOX_LABEL_KIND) {
    const payload = parseBoxLabelJob(job.filterJson)
    if (!payload) throw new LabelError('LABEL_JOB_INVALID', '标签任务内容不完整，请回到入仓计划重新发起')
    const plan = await planOf(payload.planId)
    const shipment = await db.fbaInboundShipment.findFirst({ where: { id: payload.shipmentRowId, planId: plan.id }, select: { id: true } })
    if (!shipment) throw new LabelError('LABEL_JOB_INVALID', '货件已不存在')
    const baseJob = await db.labelPrintJob.findFirst({ where: { id: payload.baseLabelJobId, tenantId, planId: plan.id, kind: 'BOX', status: 'READY' }, select: { objectKey: true } })
    if (!baseJob?.objectKey) throw new LabelError('LABEL_BASE_MISSING', '作为底的亚马逊箱标签文件不存在或已被清理，请到“标签”页签重新获取箱标签后再生成')
    const base = await store.read(baseJob.objectKey).then(
      stream => readAll(stream, BASE_MAX_BYTES),
      (error: unknown) => {
        if (error instanceof LabelError) throw error
        throw new LabelError('LABEL_BASE_MISSING', '作为底的亚马逊箱标签文件已被清理，请到“标签”页签重新获取箱标签后再生成')
      },
    )
    const built = await buildBoxLabelPdf({ base, job: payload, fontPath: input.fontPath, generatedAt: now })
    const stored = await put(built.bytes)
    const template = payload.templateId ? await db.labelTemplate.findFirst({ where: { id: payload.templateId, tenantId }, select: { id: true } }) : null
    return {
      rows: built.boxes,
      ...stored,
      log: { tenantId, planId: plan.id, shipmentId: shipment.id, templateId: template?.id ?? null, kind: 'BOX_CUSTOM', labelCount: built.boxes, exportJobId: job.id, printedBy: job.requestedBy },
    }
  }

  const payload = parseItemLabelJob(job.filterJson)
  if (!payload) throw new LabelError('LABEL_JOB_INVALID', '标签任务内容不完整，请回到入仓计划重新发起')
  const plan = await planOf(payload.planId)
  const shipment = payload.shipmentRowId ? await db.fbaInboundShipment.findFirst({ where: { id: payload.shipmentRowId, planId: plan.id }, select: { id: true } }) : null
  const built = await buildItemLabelPdf({ job: payload, fontPath: input.fontPath })
  const stored = await put(built.bytes)
  return {
    rows: built.labels,
    ...stored,
    log: { tenantId, planId: plan.id, shipmentId: shipment?.id ?? null, templateId: null, kind: 'ITEM', labelCount: built.labels, exportJobId: job.id, printedBy: job.requestedBy },
  }
}
