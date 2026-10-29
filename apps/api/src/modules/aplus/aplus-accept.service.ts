import { randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import type { AplusRunKind } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext, type ApiContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { BUSY_STATUSES } from './aplus-common'
import { AplusJobService } from './aplus-jobs.service'

export const json = (value: unknown) => value as Prisma.InputJsonValue

export interface AcceptInput {
  storeId: string
  connectionId: string
  kind: AplusRunKind
  /** 写入记录关联的内容；上传图片没有内容。新建内容时由调用方预先分配编号。 */
  contentId: string | null
  requestJson: unknown
  /** 新建内容（与 update 二选一，上传图片两个都没有）。 */
  create?: Omit<Prisma.AplusContentUncheckedCreateInput, 'id' | 'tenantId'>
  /** 条件更新已有内容：版本必须等于 version，成功后版本加一。 */
  update?: { version: number; data: Prisma.AplusContentUncheckedUpdateManyInput }
  audit: { action: string; resourceType: string; resourceId?: string; after: Record<string, unknown> }
}
export interface Accepted {
  contentId: string | null
  runId: string
  /** 受理后的内容版本；上传图片为 null。 */
  version: number | null
  queued: boolean
}

/**
 * 受理一次 A+ 写入（P4-14）：同一个租户事务里完成 内容的创建或带版本的更新 → 写入记录（QUEUED）→ 后台任务 → 审计，提交后入队。
 * 并发保证：条件更新（where 带 version）一条语句完成“比较并更新”，同时锁住内容行；锁持有期间再查一次进行中的写入，
 * 所以同一内容的并发请求里只有一个能成功，其余得到 409（版本不一致或有进行中的写入），整个事务回滚、不留半截记录。
 */
@Injectable()
export class AplusAcceptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditWriter,
    private readonly jobs: AplusJobService,
  ) {}

  async accept(req: RequestWithContext, context: ApiContext, input: AcceptInput): Promise<Accepted> {
    const tenantId = context.tenantId
    const runId = randomUUID()
    const jobId = randomUUID()
    const { job, version } = await this.prisma.$transaction(async tx => {
      let accepted: number | null = null
      if (input.create) {
        if (!input.contentId) throw new Error('新建内容必须先分配内容编号')
        const created = await tx.aplusContent.create({ data: { ...input.create, id: input.contentId, tenantId } })
        accepted = created.version
      } else if (input.update && input.contentId) {
        const where = { id: input.contentId, tenantId, version: input.update.version }
        const updated = await tx.aplusContent.updateMany({ where, data: { ...input.update.data, version: { increment: 1 } } })
        if (updated.count === 0) {
          const current = await tx.aplusContent.findFirst({ where: { id: input.contentId, tenantId }, select: { version: true } })
          if (!current) throw appError('RESOURCE_NOT_FOUND', '内容不存在')
          throw appError('CONFLICT', '这份内容已被他人修改，请刷新后查看最新内容，再决定是否合并你的修改', { details: { currentVersion: current.version, expectedVersion: input.update.version } })
        }
        accepted = input.update.version + 1
        const busy = await tx.aplusWriteRun.count({ where: { tenantId, contentId: input.contentId, status: { in: [...BUSY_STATUSES] } } })
        if (busy > 0) throw appError('CONFLICT', '这份内容有一个写入正在处理，请等它完成后再操作', { details: { code: 'APLUS_RUN_BUSY' } })
      }
      await tx.aplusWriteRun.create({
        data: {
          id: runId,
          tenantId,
          sellerAccountId: input.storeId,
          contentId: input.contentId,
          kind: input.kind,
          status: 'QUEUED',
          requestJson: json(input.requestJson),
          requestedBy: context.userId,
          requestId: req.requestId,
          syncJobId: jobId,
        },
      })
      const created = await this.jobs.createJob(tx, { id: jobId, tenantId, connectionId: input.connectionId, requestId: req.requestId, runId, storeId: input.storeId })
      await this.audit.record(req, { ...input.audit, resourceId: input.audit.resourceId ?? runId, after: { ...input.audit.after, runId } }, { client: tx })
      return { job: created, version: accepted }
    })
    const queued = await this.jobs.dispatch(req, job, { tenantId, connectionId: input.connectionId, runId })
    return { contentId: input.contentId, runId, version, queued }
  }
}
