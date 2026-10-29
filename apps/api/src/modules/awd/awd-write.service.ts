import { randomBytes } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import {
  AWD_SWITCH_KEY,
  AWD_WRITE_JOB,
  AwdCancelBodySchema,
  AwdOrderCreateBodySchema,
  AwdOrderUpdateBodySchema,
  AwdVersionBodySchema,
  awdDeliveryMode,
  awdOrderActions,
  awdPackageUnits,
  awdPackagesMissingDimensions,
  type AwdActionResponse,
  type AwdOrderActionKey,
  type AwdPendingAction,
} from '@nova/api-contracts'
import { Prisma, type AwdInboundOrder } from '@prisma/client'
import { appError, RequestWithContext, type ApiContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ActionGuardService, AuditWriter, updateWithVersion } from '../../platform/write'
import { assertStoreInScope, ContextService, storeWhere } from '../auth'
import { AWD_WRITE, orderRowOf } from './awd-common'
import { AwdJobService } from './awd-jobs.service'

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const isLocal = (row: Pick<AwdInboundOrder, 'status'>) => row.status === 'LOCAL_DRAFT' || row.status === 'CREATE_FAILED'
/** 等待提交亚马逊的编辑内容放在 draftJson.pending；其余字段（草稿来源、补货批次）原样保留。 */
const withPending = (row: Pick<AwdInboundOrder, 'draftJson'>, pending: Record<string, unknown>): Prisma.InputJsonValue => ({ ...record(row.draftJson), pending }) as Prisma.InputJsonValue
const json = (value: unknown) => (value === undefined ? undefined : (value as Prisma.InputJsonValue))

// 上游仓储订单的写入。创建与编辑本地草稿只写本地；凡是要调用亚马逊的动作（提交、修改亚马逊草稿、确认、取消、运输信息）
// 都依次判断：权限 → 店铺连接 → 写入开关（服务端执行前再判断一次），通过后把订单标为“处理中”并交给后台任务；真正的结果以订单状态为准。
@Injectable()
export class AwdWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly guard: ActionGuardService,
    private readonly audit: AuditWriter,
    private readonly jobs: AwdJobService,
  ) {}

  private async load(tenantId: string, scope: Parameters<typeof storeWhere>[0], id: string): Promise<AwdInboundOrder> {
    const row = await this.prisma.awdInboundOrder.findFirst({ where: { id, tenantId, ...storeWhere(scope) } })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '入库订单不存在')
    return row
  }

  private async hasShipment(row: AwdInboundOrder): Promise<boolean> {
    if (!row.orderId) return false
    return (await this.prisma.awdInboundShipment.count({ where: { tenantId: row.tenantId, sellerAccountId: row.sellerAccountId, orderId: row.orderId, status: { not: 'CANCELLED' } } })) > 0
  }

  /** 调用亚马逊前的动作守卫；通过后返回这个店铺的卖家连接。 */
  private async gate(context: ApiContext, sellerAccountId: string) {
    await this.guard.assert(context, { permission: AWD_WRITE, connection: { provider: 'AMAZON_SP_API', sellerAccountId }, switchKey: AWD_SWITCH_KEY })
    return this.jobs.connectionOf(context.tenantId, sellerAccountId)
  }

  private allowed(row: AwdInboundOrder, actions: AwdOrderActionKey[], action: AwdOrderActionKey) {
    if (actions.includes(action)) return
    if (row.pendingAction) throw appError('CONFLICT', '这个订单有操作正在处理中，请等处理完成后再试', { details: { pendingAction: row.pendingAction } })
    throw appError('CONFLICT', `订单当前状态（${row.status}）不允许这个操作`, { details: { status: row.status } })
  }

  private response(row: AwdInboundOrder, storeName: string, jobId: string | null): AwdActionResponse {
    return { order: orderRowOf(row, storeName), state: jobId ? 'QUEUED' : 'SAVED', jobId }
  }

  private async storeName(tenantId: string, id: string) {
    return (await this.prisma.sellerAccount.findFirst({ where: { id, tenantId }, select: { displayName: true } }))?.displayName ?? ''
  }

  async create(req: RequestWithContext, rawBody: unknown): Promise<AwdActionResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, AWD_WRITE, {})
    const body = AwdOrderCreateBodySchema.parse(rawBody)
    assertStoreInScope(scope, body.sellerAccountId)
    const store = await this.prisma.sellerAccount.findFirst({ where: { id: body.sellerAccountId, tenantId: context.tenantId }, select: { id: true, displayName: true } })
    if (!store) throw appError('RESOURCE_NOT_FOUND', '店铺不存在')
    const connection = body.submit ? await this.gate(context, store.id) : null
    const packages = body.packages ?? []
    const { row, job } = await this.prisma.$transaction(async tx => {
      const created = await tx.awdInboundOrder.create({
        data: {
          tenantId: context.tenantId,
          sellerAccountId: store.id,
          externalReferenceId: `NOVA-${randomBytes(6).toString('hex').toUpperCase()}`,
          status: 'LOCAL_DRAFT',
          pendingAction: body.submit ? 'CREATE' : null,
          originAddressJson: json(body.originAddress),
          packagesJson: packages.length ? (packages as unknown as Prisma.InputJsonValue) : undefined,
          preferredRegion: body.preferredRegion,
          expectedUnits: packages.length ? awdPackageUnits(packages) : null,
          packageDeliveryMode: awdDeliveryMode(packages),
          note: body.note,
          createdBy: context.userId,
        },
      })
      const queued = connection
        ? await this.jobs.createJob(tx, {
            tenantId: context.tenantId,
            connectionId: connection.id,
            type: AWD_WRITE_JOB,
            requestId: req.requestId,
            objectId: created.id,
            context: { awdOrderId: created.id, awdAction: 'CREATE' },
          })
        : null
      await this.audit.record(
        req,
        { action: 'AWD_ORDER_CREATED', resourceType: 'AwdInboundOrder', resourceId: created.id, after: { status: created.status, submit: body.submit, units: created.expectedUnits } },
        { client: tx },
      )
      return { row: created, job: queued }
    })
    if (job && connection) await this.jobs.dispatchWrite(req, job, { tenantId: context.tenantId, connectionId: connection.id, awdOrderId: row.id, awdAction: 'CREATE' })
    return this.response(row, store.displayName, job?.id ?? null)
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<AwdActionResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, AWD_WRITE, {})
    const body = AwdOrderUpdateBodySchema.parse(rawBody)
    const row = await this.load(context.tenantId, scope, id)
    const actions = awdOrderActions(row, await this.hasShipment(row))
    const local = isLocal(row)
    let action: AwdPendingAction | null = null
    let data: Prisma.AwdInboundOrderUncheckedUpdateManyInput

    if (body.transport) {
      this.allowed(row, actions, 'TRANSPORT')
      action = 'TRANSPORT'
      data = { pendingAction: 'TRANSPORT', draftJson: withPending(row, { transport: body.transport }) }
    } else {
      this.allowed(row, actions, 'EDIT')
      if (body.submit) this.allowed(row, actions, 'SUBMIT')
      const address = body.originAddress ?? (row.originAddressJson as unknown)
      const packages = body.packages ?? (Array.isArray(row.packagesJson) ? (row.packagesJson as unknown as NonNullable<typeof body.packages>) : [])
      const touchesAmazon = body.originAddress !== undefined || body.packages !== undefined || body.preferredRegion !== undefined
      if (!touchesAmazon && body.note === undefined && !body.submit) throw appError('VALIDATION_FAILED', '没有任何要修改的内容', { fieldErrors: { body: ['请至少修改一项'] } })
      const complete = (needed: boolean) => {
        if (needed && (!address || packages.length === 0)) throw appError('VALIDATION_FAILED', '提交亚马逊前请填写发货地址并至少添加一个包装', { fieldErrors: { packages: ['发货地址与包装必填'] } })
        if (needed && awdPackagesMissingDimensions(packages) > 0) throw appError('VALIDATION_FAILED', '提交亚马逊前每个包装都要填写长宽高', { fieldErrors: { packages: ['每个包装都要填写长宽高'] } })
      }
      if (local) {
        complete(body.submit === true)
        if (body.submit) action = 'CREATE'
        data = {
          ...(body.originAddress ? { originAddressJson: body.originAddress as Prisma.InputJsonValue } : {}),
          ...(body.packages
            ? { packagesJson: body.packages as unknown as Prisma.InputJsonValue, expectedUnits: awdPackageUnits(body.packages), packageDeliveryMode: awdDeliveryMode(body.packages) }
            : {}),
          ...(body.preferredRegion ? { preferredRegion: body.preferredRegion } : {}),
          ...(body.note !== undefined ? { note: body.note } : {}),
          ...(body.submit ? { pendingAction: 'CREATE' } : {}),
        }
      } else {
        // 亚马逊侧的草稿：地址、包装、区域要整体覆盖到亚马逊（PUT）；只改备注不调用亚马逊
        if (touchesAmazon) {
          complete(true)
          action = 'UPDATE'
        }
        data = {
          ...(body.note !== undefined ? { note: body.note } : {}),
          ...(touchesAmazon
            ? {
                pendingAction: 'UPDATE',
                draftJson: withPending(row, {
                  ...(body.originAddress ? { originAddress: body.originAddress } : {}),
                  ...(body.packages ? { packages: body.packages } : {}),
                  ...(body.preferredRegion ? { preferredRegion: body.preferredRegion } : {}),
                }),
              }
            : {}),
        }
      }
    }
    return this.commit(req, context, row, { action, data, expectedVersion: body.version, audit: { action: body.transport ? 'AWD_ORDER_TRANSPORT_UPDATED' : 'AWD_ORDER_UPDATED' } })
  }

  async confirm(req: RequestWithContext, id: string, rawBody: unknown): Promise<AwdActionResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, AWD_WRITE, {})
    const body = AwdVersionBodySchema.parse(rawBody)
    const row = await this.load(context.tenantId, scope, id)
    this.allowed(row, awdOrderActions(row, await this.hasShipment(row)), 'CONFIRM')
    return this.commit(req, context, row, { action: 'CONFIRM', data: { pendingAction: 'CONFIRM' }, expectedVersion: body.version, audit: { action: 'AWD_ORDER_CONFIRMED' } })
  }

  async cancel(req: RequestWithContext, id: string, rawBody: unknown): Promise<AwdActionResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, AWD_WRITE, {})
    const body = AwdCancelBodySchema.parse(rawBody)
    const row = await this.load(context.tenantId, scope, id)
    this.allowed(row, awdOrderActions(row, await this.hasShipment(row)), 'CANCEL')
    // 还没到亚马逊的订单（本地草稿、提交失败）：只在本地取消，不调用亚马逊
    if (isLocal(row))
      return this.commit(req, context, row, {
        action: null,
        data: { status: 'CANCELLED', pendingAction: null },
        expectedVersion: body.version,
        audit: { action: 'AWD_ORDER_CANCELLED', reason: body.reason },
      })
    return this.commit(req, context, row, { action: 'CANCEL', data: { pendingAction: 'CANCEL' }, expectedVersion: body.version, audit: { action: 'AWD_ORDER_CANCELLED', reason: body.reason } })
  }

  /** 带版本号更新订单；需要调用亚马逊的动作先过守卫，更新与任务记录同一个事务，入队在提交之后。 */
  private async commit(
    req: RequestWithContext,
    context: ApiContext,
    row: AwdInboundOrder,
    input: { action: AwdPendingAction | null; data: Prisma.AwdInboundOrderUncheckedUpdateManyInput; expectedVersion: number; audit: { action: string; reason?: string } },
  ): Promise<AwdActionResponse> {
    const connection = input.action ? await this.gate(context, row.sellerAccountId) : null
    const { updated, job } = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(tx.awdInboundOrder, { id: row.id, tenantId: row.tenantId }, input.expectedVersion, input.data as Record<string, unknown>, { label: '入库订单' })
      const queued =
        connection && input.action
          ? await this.jobs.createJob(tx, {
              tenantId: row.tenantId,
              connectionId: connection.id,
              type: AWD_WRITE_JOB,
              requestId: req.requestId,
              objectId: row.id,
              context: { awdOrderId: row.id, awdAction: input.action },
            })
          : null
      await this.audit.record(
        req,
        {
          action: input.audit.action,
          resourceType: 'AwdInboundOrder',
          resourceId: row.id,
          before: { status: row.status, pendingAction: row.pendingAction },
          after: { status: next.status, pendingAction: next.pendingAction },
          ...(input.audit.reason ? { reason: input.audit.reason } : {}),
        },
        { client: tx },
      )
      return { updated: next, job: queued }
    })
    if (job && connection && input.action) await this.jobs.dispatchWrite(req, job, { tenantId: row.tenantId, connectionId: connection.id, awdOrderId: row.id, awdAction: input.action })
    return this.response(updated, await this.storeName(row.tenantId, row.sellerAccountId), job?.id ?? null)
  }
}
