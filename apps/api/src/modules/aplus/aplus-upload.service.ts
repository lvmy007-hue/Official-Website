import { Injectable } from '@nestjs/common'
import { APLUS_ACTIONS, APLUS_LIMITS, APLUS_WRITE, AplusUploadConfirmBodySchema, AplusUploadTicketBodySchema, type AplusUploadResult, type AplusUploadTicket } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ObjectStorageService, storageAppError } from '../../platform/storage'
import { ContextService } from '../auth'
import { AplusAcceptService } from './aplus-accept.service'
import { formatOfContentType, readImageInfo, type ImageFormat } from './aplus-image'
import { AplusWriteGate } from './aplus-write-gate.service'

type TenantStore = ReturnType<ObjectStorageService['forTenant']>
const FORMAT_LABEL: Record<ImageFormat, string> = { png: 'PNG', jpeg: 'JPG' }
const unprocessable = (message: string) => appError('VALIDATION_FAILED', message, { fieldErrors: { objectKey: [message] } })

/** 把对象读进内存（最多 maxBytes 字节，图片上限 5MB）；超出时中止，不继续读。 */
async function readAll(store: TenantStore, key: string, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of await store.read(key)) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += part.length
    if (total > maxBytes) throw appError('FILE_TOO_LARGE', '文件超过大小上限')
    chunks.push(part)
  }
  return Buffer.concat(chunks)
}

/**
 * A+ 图片上传（P4-14，05 章 5.8 “上传图片”）：先申请签名直传票据（不改库、不记写入），浏览器直接把文件传到对象存储，再调用确认。
 * 确认时服务端核对文件（大小、类型、真实的图片头与宽高），通过后登记一条“上传图片”写入记录与后台任务，由后台任务把文件传到亚马逊的上传地址。
 * 两步都按 权限 → 参数 → 店铺范围 → 连接与开关 的顺序检查。对象键在租户前缀下，带 aplus 目录与随机段。
 */
@Injectable()
export class AplusUploadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly gate: AplusWriteGate,
    private readonly accepts: AplusAcceptService,
    private readonly objects: ObjectStorageService,
  ) {}

  private maxBytes = () => Math.min(APLUS_LIMITS.imageMaxBytes, this.objects.maxUploadBytes())

  async ticket(req: RequestWithContext, rawBody: unknown): Promise<AplusUploadTicket> {
    const { context, scope } = await this.context.authorizeScoped(req, APLUS_WRITE, {})
    const body = AplusUploadTicketBodySchema.parse(rawBody)
    await this.gate.forStore(context, scope, body.storeId)
    const maxBytes = this.maxBytes()
    if (body.sizeBytes > maxBytes) throw appError('FILE_TOO_LARGE', '文件超过大小上限', { fieldErrors: { sizeBytes: [`图片不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB`] } })
    try {
      const signed = await this.objects.forTenant(context.tenantId).signUpload({ domain: 'aplus', name: body.fileName }, { contentType: body.contentType, maxBytes })
      return { uploadUrl: signed.url, method: 'PUT', headers: signed.headers, objectKey: signed.key, expiresAt: signed.expiresAt.toISOString(), maxBytes }
    } catch (error) {
      throw storageAppError(error)
    }
  }

  async confirm(req: RequestWithContext, rawBody: unknown): Promise<AplusUploadResult> {
    const { context, scope } = await this.context.authorizeScoped(req, APLUS_WRITE, {})
    const body = AplusUploadConfirmBodySchema.parse(rawBody)
    const connection = await this.gate.forStore(context, scope, body.storeId)
    const tenantId = context.tenantId
    const store = this.objects.forTenant(tenantId)
    const maxBytes = this.maxBytes()
    // 同一个对象只登记一次上传任务
    const duplicate = await this.prisma.aplusWriteRun.findFirst({ where: { tenantId, kind: 'UPLOAD', requestJson: { path: ['objectKey'], equals: body.objectKey } }, select: { id: true } })
    if (duplicate) throw appError('CONFLICT', '这个文件已经登记过上传了')
    let sizeBytes: number
    let image: Buffer
    try {
      const meta = await store.confirmUpload(body.objectKey, maxBytes)
      if (meta.contentType && meta.contentType.split(';')[0]!.trim().toLowerCase() !== body.contentType) {
        await store.remove(body.objectKey)
        throw appError('FILE_TYPE_NOT_ALLOWED', '文件类型与申请上传时约定的不一致，已丢弃')
      }
      sizeBytes = meta.sizeBytes
      image = await readAll(store, body.objectKey, maxBytes)
    } catch (error) {
      throw storageAppError(error)
    }
    const read = readImageInfo(image)
    const problem = !read.ok
      ? read.problem === 'UNKNOWN_FORMAT'
        ? '文件不是 JPG 或 PNG 图片，请重新选择'
        : '图片文件已损坏或读不出尺寸，请重新导出后再上传'
      : read.info.format !== formatOfContentType(body.contentType)
        ? `文件内容是 ${FORMAT_LABEL[read.info.format]} 图片，与声明的类型（${body.contentType}）不符，请重新选择`
        : null
    if (!read.ok || problem) {
      // 不合格的文件不留在存储里
      await store.remove(body.objectKey)
      throw unprocessable(problem ?? '图片无法识别')
    }
    const { width, height } = read.info
    const accepted = await this.accepts.accept(req, context, {
      storeId: body.storeId,
      connectionId: connection.id,
      kind: 'UPLOAD',
      contentId: null,
      requestJson: { storeId: body.storeId, objectKey: body.objectKey, fileName: body.fileName, contentType: body.contentType, sizeBytes, width, height },
      audit: { action: APLUS_ACTIONS.imageUploaded, resourceType: 'AplusWriteRun', after: { storeId: body.storeId, fileName: body.fileName, contentType: body.contentType, sizeBytes, width, height } },
    })
    return { contentId: null, runId: accepted.runId, status: 'QUEUED', version: null, queued: accepted.queued, width, height }
  }
}
