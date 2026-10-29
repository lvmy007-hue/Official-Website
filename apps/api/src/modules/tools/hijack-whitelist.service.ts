import { createHash } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import {
  HIJACK_ACTIONS,
  HIJACK_BLOCKED_NO_PERMISSION,
  HIJACK_LIMITS,
  HIJACK_MANAGE,
  HIJACK_READ,
  HijackWhitelistBodySchema,
  HijackWhitelistQuerySchema,
  sellerHintOf,
  sellerRefOf,
  type HijackWhitelistResponse,
  type HijackWhitelistRow,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService, storeWhere } from '../auth'

/** 与 worker 的 sellerKeyOf 同一算法：sha256 取前 16 位十六进制；卖家编号原文不入库。 */
export const sellerKeyOf = (sellerId: string): string => createHash('sha256').update(sellerId).digest('hex').slice(0, 16)

/** 跟卖白名单（P6-17）：按租户生效，列出现在还能看到这个卖家的 SKU 数；新增只收卖家编号（存哈希与前后各两位提示），重复 409；删除后该卖家若仍在报价，会重新进入跟卖列表与预警。 */
@Injectable()
export class HijackWhitelistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<HijackWhitelistResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, HIJACK_READ, rawQuery)
    const query = HijackWhitelistQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const canManage = hasPermission(context.permissions, HIJACK_MANAGE)
    const [total, rows] = await Promise.all([
      this.prisma.hijackWhitelist.count({ where: { tenantId } }),
      this.prisma.hijackWhitelist.findMany({ where: { tenantId }, orderBy: [{ createdAt: query.sort.dir }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ])
    const stores = (await this.prisma.sellerAccount.findMany({ where: { tenantId, ...storeWhere(scope, 'id') }, select: { id: true }, take: 500 })).map(store => store.id)
    const grouped =
      rows.length === 0
        ? []
        : await this.prisma.offerCompetitor.groupBy({
            by: ['sellerId'],
            where: { tenantId, sellerAccountId: { in: stores }, goneAt: null, sellerId: { in: rows.map(row => row.sellerId) } },
            _count: { _all: true },
          })
    const counts = new Map(grouped.map(row => [row.sellerId, row._count._all]))
    const items: HijackWhitelistRow[] = rows.map(row => ({
      id: row.id,
      sellerKey: row.sellerId,
      sellerRef: sellerRefOf(row.sellerId),
      sellerHint: row.sellerHint,
      note: row.note,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      activeSkus: counts.get(row.sellerId) ?? 0,
    }))
    return { items, page: query.page, pageSize: query.pageSize, total, limit: HIJACK_LIMITS.whitelistMax, canManage, manageBlockedReason: canManage ? null : HIJACK_BLOCKED_NO_PERMISSION }
  }

  async add(req: RequestWithContext, rawBody: unknown): Promise<HijackWhitelistRow> {
    const context = await this.context.authorize(req, HIJACK_MANAGE)
    const body = HijackWhitelistBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const sellerKey = sellerKeyOf(body.sellerId)
    const count = await this.prisma.hijackWhitelist.count({ where: { tenantId } })
    if (count >= HIJACK_LIMITS.whitelistMax) throw appError('DATA_CONDITION_FAILED', `白名单最多 ${HIJACK_LIMITS.whitelistMax} 个卖家，请先删除一些再添加`)
    try {
      return await this.prisma.$transaction(async tx => {
        const row = await tx.hijackWhitelist.create({ data: { tenantId, sellerId: sellerKey, sellerHint: sellerHintOf(body.sellerId), note: body.note ?? null, createdBy: context.userId } })
        await this.audit.record(
          req,
          { action: HIJACK_ACTIONS.whitelistAdded, resourceType: 'HijackWhitelist', resourceId: row.id, before: null, after: { sellerHint: row.sellerHint, note: row.note } },
          { client: tx },
        )
        return {
          id: row.id,
          sellerKey: row.sellerId,
          sellerRef: sellerRefOf(row.sellerId),
          sellerHint: row.sellerHint,
          note: row.note,
          createdBy: row.createdBy,
          createdAt: row.createdAt.toISOString(),
          activeSkus: 0,
        }
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw appError('CONFLICT', '这个卖家已经在白名单里')
      throw error
    }
  }

  async remove(req: RequestWithContext, id: string): Promise<{ removed: number }> {
    const context = await this.context.authorize(req, HIJACK_MANAGE)
    const tenantId = context.tenantId
    return this.prisma.$transaction(async tx => {
      const found = await tx.hijackWhitelist.findFirst({ where: { id, tenantId }, select: { id: true, sellerHint: true, note: true } })
      if (!found) throw appError('RESOURCE_NOT_FOUND', '没有找到这条白名单记录')
      await tx.hijackWhitelist.deleteMany({ where: { id: found.id, tenantId } })
      await this.audit.record(
        req,
        { action: HIJACK_ACTIONS.whitelistRemoved, resourceType: 'HijackWhitelist', resourceId: found.id, before: { sellerHint: found.sellerHint, note: found.note }, after: null },
        { client: tx },
      )
      return { removed: 1 }
    })
  }
}
