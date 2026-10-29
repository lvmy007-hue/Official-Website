import { Injectable } from '@nestjs/common'
import { hasPermission } from '@nova/authz'
import {
  SHIP_FROM_ACTIONS,
  SHIP_FROM_BLOCKED_NO_PERMISSION,
  SHIP_FROM_LIMIT_PER_STORE,
  SHIP_FROM_MANAGE,
  SHIP_FROM_READ,
  SHIP_FROM_PATH,
  ShipFromCreateBodySchema,
  ShipFromListQuerySchema,
  ShipFromUpdateBodySchema,
  shipFromSummary,
  type ShipFromListResponse,
  type ShipFromRow,
  type ShipFromStatus,
} from '@nova/api-contracts'
import type { Prisma, ShipFromAddress } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService, assertStoreInScope, storeWhere } from '../auth'

const LABEL = '发货地址'
const NAME_CONFLICT = '这个店铺里已经有同名地址，或默认地址刚被别人改过，请换个名称或刷新后重试'
const USED_MESSAGE = '这个地址已被入仓计划使用，不能删除；可以改为停用，停用后新的草稿不会再选它'
const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === 'P2002'
const isForeignKeyViolation = (error: unknown) => (error as { code?: string } | null)?.code === 'P2003'
const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const })

type Tx = Prisma.TransactionClient

/** 审计里记地址的摘要，不记电话（电话只在页面显示给有权限的人）。 */
const auditView = (row: ShipFromAddress) => ({ name: row.name, address: shipFromSummary(row), status: row.status, isDefault: row.isDefault })

// 发货地址（P6-08，16 章第 4 节；freeze/api.md `/ship-from-addresses*`）：按店铺维护入仓用的发货方地址。
// 规则：
//   - 读取要 inbound.read（只看数据范围内店铺的地址）；新增、修改、停用、设默认、删除要 shipfrom.manage，并且店铺要在数据范围内；
//   - 每个店铺至多一个默认地址：新增、修改、设默认都在同一事务里取消原默认（数据库部分唯一索引兜底）；店铺的第一个地址自动成为默认；
//   - 停用的地址不能当默认：停用默认地址时同时取消默认（店铺回到“没有默认地址”，补货转草稿时会提示去设置）；
//   - 被入仓计划用过的地址不能删除（外键 RESTRICT 兜底），只能停用；
//   - 修改带乐观锁版本号，冲突 409；同店铺同名 409；每个店铺最多 50 个地址；写操作全部写审计。
@Injectable()
export class ShipFromService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  private async rowsOf(tenantId: string, rows: ShipFromAddress[]): Promise<ShipFromRow[]> {
    const ids = rows.map(row => row.id)
    const storeIds = [...new Set(rows.map(row => row.sellerAccountId))]
    const [stores, used] = await Promise.all([
      storeIds.length ? this.prisma.sellerAccount.findMany({ where: { tenantId, id: { in: storeIds } }, select: { id: true, displayName: true }, take: 500 }) : [],
      ids.length ? this.prisma.fbaInboundPlan.groupBy({ by: ['shipFromAddressId'], where: { tenantId, shipFromAddressId: { in: ids } }, _count: { _all: true } }) : [],
    ])
    const names = new Map(stores.map(store => [store.id, store.displayName]))
    const usage = new Map(used.map(item => [item.shipFromAddressId, item._count._all]))
    return rows.map(row => ({
      id: row.id,
      sellerAccountId: row.sellerAccountId,
      storeName: names.get(row.sellerAccountId) ?? '',
      name: row.name,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      stateOrProvince: row.stateOrProvince,
      postalCode: row.postalCode,
      countryCode: row.countryCode,
      phone: row.phone,
      isDefault: row.isDefault,
      status: row.status as ShipFromStatus,
      version: row.version,
      usedByPlans: usage.get(row.id) ?? 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }))
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<ShipFromListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, SHIP_FROM_READ, rawQuery)
    const query = ShipFromListQuerySchema.parse(rawQuery)
    const base: Prisma.ShipFromAddressWhereInput = { tenantId: context.tenantId, ...storeWhere(scope) }
    const where: Prisma.ShipFromAddressWhereInput = {
      ...base,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { OR: [{ name: contains(query.q) }, { addressLine1: contains(query.q) }, { city: contains(query.q) }, { postalCode: contains(query.q) }] } : {}),
    }
    const order: Prisma.ShipFromAddressOrderByWithRelationInput[] = [query.sort.field === 'name' ? { name: query.sort.dir } : { updatedAt: query.sort.dir }, { id: 'asc' }]
    const [rows, total, groups] = await Promise.all([
      this.prisma.shipFromAddress.findMany({ where, orderBy: order, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.shipFromAddress.count({ where }),
      this.prisma.shipFromAddress.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ])
    const count = (status: ShipFromStatus) => groups.find(group => group.status === status)?._count._all ?? 0
    const canManage = hasPermission(context.permissions, SHIP_FROM_MANAGE)
    return {
      items: await this.rowsOf(context.tenantId, rows),
      page: query.page,
      pageSize: query.pageSize,
      total,
      summary: { total: count('ACTIVE') + count('INACTIVE'), active: count('ACTIVE'), inactive: count('INACTIVE') },
      canManage,
      manageBlockedReason: canManage ? null : SHIP_FROM_BLOCKED_NO_PERMISSION,
    }
  }

  /** 供补货批次转草稿用：这些店铺里使用中的地址（默认地址排最前，每个店铺最多 50 个）。 */
  async activeByStores(tenantId: string, storeIds: readonly string[], client: Pick<Tx, 'shipFromAddress'> = this.prisma): Promise<Map<string, ShipFromAddress[]>> {
    const result = new Map<string, ShipFromAddress[]>()
    if (storeIds.length === 0) return result
    const rows = await client.shipFromAddress.findMany({
      where: { tenantId, sellerAccountId: { in: [...new Set(storeIds)] }, status: 'ACTIVE' },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      take: SHIP_FROM_LIMIT_PER_STORE * 20,
    })
    for (const row of rows) result.set(row.sellerAccountId, [...(result.get(row.sellerAccountId) ?? []), row])
    return result
  }

  /** 取消同店铺现有的默认地址（版本号加一，让手里还是旧版本的人修改时得到冲突提示）。 */
  private async clearDefault(tx: Tx, tenantId: string, sellerAccountId: string, exceptId?: string) {
    await tx.shipFromAddress.updateMany({
      where: { tenantId, sellerAccountId, isDefault: true, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      data: { isDefault: false, version: { increment: 1 } },
    })
  }

  private async load(tenantId: string, scope: Awaited<ReturnType<ContextService['authorizeScoped']>>['scope'], id: string): Promise<ShipFromAddress> {
    const row = await this.prisma.shipFromAddress.findFirst({ where: { id, tenantId, ...storeWhere(scope) } })
    if (!row) throw appError('RESOURCE_NOT_FOUND', `${LABEL}不存在`)
    return row
  }

  async create(req: RequestWithContext, rawBody: unknown): Promise<ShipFromRow> {
    const { context, scope } = await this.context.authorizeScoped(req, SHIP_FROM_MANAGE, {})
    const body = ShipFromCreateBodySchema.parse(rawBody)
    assertStoreInScope(scope, body.sellerAccountId)
    const store = await this.prisma.sellerAccount.findFirst({ where: { id: body.sellerAccountId, tenantId: context.tenantId }, select: { id: true } })
    if (!store) throw appError('RESOURCE_NOT_FOUND', '店铺不存在')
    const { sellerAccountId, isDefault, ...fields } = body
    try {
      const row = await this.prisma.$transaction(async tx => {
        const existing = await tx.shipFromAddress.count({ where: { tenantId: context.tenantId, sellerAccountId } })
        if (existing >= SHIP_FROM_LIMIT_PER_STORE) throw appError('CONFLICT', `每个店铺最多保存 ${SHIP_FROM_LIMIT_PER_STORE} 个发货地址，请先删除或合并不用的`)
        const hasDefault = (await tx.shipFromAddress.count({ where: { tenantId: context.tenantId, sellerAccountId, isDefault: true } })) > 0
        const makeDefault = isDefault || !hasDefault
        if (makeDefault) await this.clearDefault(tx, context.tenantId, sellerAccountId)
        const created = await tx.shipFromAddress.create({ data: { ...fields, tenantId: context.tenantId, sellerAccountId, isDefault: makeDefault, createdBy: context.userId } })
        await this.audit.record(
          req,
          { action: SHIP_FROM_ACTIONS.created, resourceType: 'ShipFromAddress', resourceId: created.id, after: auditView(created), detail: { sellerAccountId } },
          { client: tx },
        )
        return created
      })
      return (await this.rowsOf(context.tenantId, [row]))[0]!
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', NAME_CONFLICT, { fieldErrors: { name: ['这个店铺里已有同名地址'] } })
      throw error
    }
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<ShipFromRow> {
    const { context, scope } = await this.context.authorizeScoped(req, SHIP_FROM_MANAGE, {})
    const body = ShipFromUpdateBodySchema.parse(rawBody)
    const { version, addressLine2, ...rest } = body
    const data: Prisma.ShipFromAddressUncheckedUpdateManyInput = { ...rest, ...(addressLine2 !== undefined ? { addressLine2: addressLine2 || null } : {}) }
    if (Object.keys(data).length === 0) throw appError('VALIDATION_FAILED', '没有需要保存的修改')
    const current = await this.load(context.tenantId, scope, id)
    // 停用默认地址：同时取消默认（停用的地址不能当默认）
    if (body.status === 'INACTIVE' && current.isDefault) data.isDefault = false
    try {
      const row = await this.prisma.$transaction(async tx => {
        const next = await updateWithVersion(tx.shipFromAddress, { id: current.id, tenantId: context.tenantId }, version, data as Record<string, unknown>, { label: LABEL })
        await this.audit.record(
          req,
          {
            action: SHIP_FROM_ACTIONS.updated,
            resourceType: 'ShipFromAddress',
            resourceId: current.id,
            before: auditView(current),
            after: auditView(next),
            detail: { sellerAccountId: current.sellerAccountId },
          },
          { client: tx },
        )
        return next
      })
      return (await this.rowsOf(context.tenantId, [row]))[0]!
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', NAME_CONFLICT, { fieldErrors: { name: ['这个店铺里已有同名地址'] } })
      throw error
    }
  }

  async setDefault(req: RequestWithContext, id: string): Promise<ShipFromRow> {
    const { context, scope } = await this.context.authorizeScoped(req, SHIP_FROM_MANAGE, {})
    const current = await this.load(context.tenantId, scope, id)
    if (current.status !== 'ACTIVE') throw appError('CONFLICT', '已停用的地址不能设为默认，请先启用')
    if (current.isDefault) return (await this.rowsOf(context.tenantId, [current]))[0]!
    try {
      const row = await this.prisma.$transaction(async tx => {
        await this.clearDefault(tx, context.tenantId, current.sellerAccountId, current.id)
        await tx.shipFromAddress.updateMany({ where: { id: current.id, tenantId: context.tenantId }, data: { isDefault: true, version: { increment: 1 } } })
        const next = await tx.shipFromAddress.findFirstOrThrow({ where: { id: current.id, tenantId: context.tenantId } })
        await this.audit.record(
          req,
          {
            action: SHIP_FROM_ACTIONS.defaulted,
            resourceType: 'ShipFromAddress',
            resourceId: current.id,
            before: auditView(current),
            after: auditView(next),
            detail: { sellerAccountId: current.sellerAccountId },
          },
          { client: tx },
        )
        return next
      })
      return (await this.rowsOf(context.tenantId, [row]))[0]!
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', NAME_CONFLICT)
      throw error
    }
  }

  async remove(req: RequestWithContext, id: string): Promise<{ id: string }> {
    const { context, scope } = await this.context.authorizeScoped(req, SHIP_FROM_MANAGE, {})
    const current = await this.load(context.tenantId, scope, id)
    const used = await this.prisma.fbaInboundPlan.count({ where: { tenantId: context.tenantId, shipFromAddressId: current.id } })
    if (used > 0) throw appError('CONFLICT', USED_MESSAGE, { details: { planCount: used, remedyPath: SHIP_FROM_PATH } })
    try {
      await this.prisma.$transaction(async tx => {
        await tx.shipFromAddress.deleteMany({ where: { id: current.id, tenantId: context.tenantId } })
        await this.audit.record(
          req,
          { action: SHIP_FROM_ACTIONS.deleted, resourceType: 'ShipFromAddress', resourceId: current.id, before: auditView(current), detail: { sellerAccountId: current.sellerAccountId } },
          { client: tx },
        )
      })
    } catch (error) {
      // 删除与新计划引用同时发生：外键 RESTRICT 拦下，按“已被使用”处理
      if (isForeignKeyViolation(error)) throw appError('CONFLICT', USED_MESSAGE)
      throw error
    }
    return { id: current.id }
  }
}
