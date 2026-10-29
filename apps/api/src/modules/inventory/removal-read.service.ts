import { Injectable } from '@nestjs/common'
import {
  RecommendedRemovalQuerySchema,
  RemovalListQuerySchema,
  removalReceiptState,
  removalStatusLabel,
  REMOVAL_TYPE_LABEL,
  type RecommendedRemovalResponse,
  type RemovalDetailResponse,
  type RemovalGuide,
  type RemovalListResponse,
  type RemovalOrderRow,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'
import { REMOVAL_KEYS, sourceFreshness } from './inventory-freshness'
import { buildTimeline, parseRemovalId, reconcile, removalId, removalTypeOf } from './removal-math'

const PERMISSION = 'inventory.read'
const TAKE = 5000
const asDate = (date: string) => new Date(`${date}T00:00:00Z`)
const dateText = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null)
const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))

export const REMOVAL_GUIDE: RemovalGuide = {
  title: '移除订单只能在亚马逊卖家后台创建',
  steps: [
    '登录亚马逊卖家后台，进入“库存”→“管理亚马逊物流库存”',
    '勾选要移除的商品，在“操作”里选择“创建移除订单”',
    '选择“退回”或“弃置”，确认数量与退回地址后提交',
    '提交后这里会在下一次同步（每天）出现订单；退回件到达国内仓后，在订单详情登记收货核对',
  ],
  url: 'https://sellercentral.amazon.com/',
}

// 移除与弃置（06 章 6.5）：移除订单列表（按订单汇总）、亚马逊推荐移除清单、订单详情（含退回件收货核对）。
@Injectable()
export class RemovalReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  private pairs(rows: ReadonlyArray<{ sellerAccountId: string; orderId: string }>): Array<{ sellerAccountId: string; orderId: string }> {
    return rows.map(row => ({ sellerAccountId: row.sellerAccountId, orderId: row.orderId }))
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<RemovalListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PERMISSION, rawQuery)
    const query = RemovalListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const base: Prisma.RemovalOrderWhereInput = {
      tenantId,
      ...storeWhere(scope),
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: { equals: query.status, mode: 'insensitive' } } : {}),
      ...(query.from && query.to ? { requestDate: { gte: asDate(query.from), lte: asDate(query.to) } } : {}),
    }
    let where = base
    if (query.q) {
      const matched = await this.prisma.removalOrder.findMany({
        where: { ...base, OR: [{ orderId: { contains: query.q, mode: 'insensitive' } }, { sku: { contains: query.q, mode: 'insensitive' } }, { fnsku: { contains: query.q, mode: 'insensitive' } }] },
        distinct: ['sellerAccountId', 'orderId'],
        select: { sellerAccountId: true, orderId: true },
        take: TAKE,
      })
      where = { ...base, OR: matched.length ? this.pairs(matched) : [{ id: '__none__' }] }
    }
    const dir = query.sort.dir
    const [groups, all, freshness] = await Promise.all([
      this.prisma.removalOrder.groupBy({
        by: ['sellerAccountId', 'orderId'],
        where,
        _sum: { requestedQty: true, shippedQty: true, disposedQty: true, cancelledQty: true, inProcessQty: true, fee: true },
        _max: { type: true, status: true, requestDate: true, lastUpdatedDate: true, currency: true },
        orderBy: [{ _max: { requestDate: dir } }, { orderId: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.removalOrder.groupBy({ by: ['sellerAccountId', 'orderId'], where, orderBy: [{ sellerAccountId: 'asc' }, { orderId: 'asc' }], take: 20_000 }),
      sourceFreshness(this.prisma, tenantId, scope, REMOVAL_KEYS),
    ])
    const names = await this.storeNames(tenantId, scope)
    const keys = groups.map(group => ({ sellerAccountId: group.sellerAccountId, orderId: group.orderId }))
    const [lines, shipments, receipts] = keys.length
      ? await Promise.all([
          this.prisma.removalOrder.findMany({ where: { tenantId, OR: this.pairs(keys) }, select: { sellerAccountId: true, orderId: true, sku: true }, take: TAKE }),
          this.prisma.removalShipment.findMany({ where: { tenantId, OR: this.pairs(keys) }, select: { sellerAccountId: true, orderId: true, carrier: true, trackingNumber: true }, take: TAKE }),
          this.prisma.removalReceipt.groupBy({
            by: ['sellerAccountId', 'removalOrderId'],
            where: { tenantId, OR: keys.map(key => ({ sellerAccountId: key.sellerAccountId, removalOrderId: key.orderId })) },
            _sum: { receivedQty: true },
          }),
        ])
      : [[], [], []]
    const items: RemovalOrderRow[] = groups.map(group => {
      const type = removalTypeOf(group._max.type)
      const mine = (row: { sellerAccountId: string; orderId: string }) => row.sellerAccountId === group.sellerAccountId && row.orderId === group.orderId
      const received = receipts.find(row => row.sellerAccountId === group.sellerAccountId && row.removalOrderId === group.orderId)?._sum.receivedQty ?? null
      const shippedQty = group._sum.shippedQty ?? 0
      const distinct = (values: Array<string | null>) => [...new Set(values.filter((value): value is string => Boolean(value)))]
      return {
        id: removalId(group.sellerAccountId, group.orderId),
        sellerAccountId: group.sellerAccountId,
        storeName: names.get(group.sellerAccountId) ?? '',
        orderId: group.orderId,
        type,
        typeLabel: REMOVAL_TYPE_LABEL[type],
        status: group._max.status ?? '',
        statusLabel: removalStatusLabel(group._max.status ?? ''),
        requestDate: dateText(group._max.requestDate) ?? '',
        lastUpdatedDate: dateText(group._max.lastUpdatedDate),
        skuCount: new Set(lines.filter(mine).map(row => row.sku)).size,
        requestedQty: group._sum.requestedQty ?? 0,
        shippedQty,
        disposedQty: group._sum.disposedQty ?? 0,
        cancelledQty: group._sum.cancelledQty ?? 0,
        inProcessQty: group._sum.inProcessQty ?? 0,
        fee: num(group._sum.fee),
        currency: group._max.currency ?? null,
        carriers: distinct(shipments.filter(mine).map(row => row.carrier)),
        trackingNumbers: distinct(shipments.filter(mine).map(row => row.trackingNumber)),
        receiptState: removalReceiptState(type, shippedQty, received),
        receivedQty: received,
      }
    })
    return {
      state: all.length ? 'OK' : 'NO_DATA',
      note: all.length ? null : '尚无移除订单记录；移除订单报告同步后这里会列出每个订单（移除订单需要在亚马逊卖家后台创建）',
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: all.length,
      guide: REMOVAL_GUIDE,
      freshness,
    }
  }

  private async storeNames(tenantId: string, scope: ResolvedScope) {
    const rows = await this.prisma.sellerAccount.findMany({
      where: { tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) },
      select: { id: true, displayName: true },
      take: 500,
    })
    return new Map(rows.map(row => [row.id, row.displayName]))
  }

  /** 推荐移除清单：每个店铺取“推荐移除报告”最近一次写入的日期，只列推荐数量大于 0 的 SKU。 */
  async recommended(req: RequestWithContext, rawQuery: Record<string, string>): Promise<RecommendedRemovalResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PERMISSION, rawQuery)
    const query = RecommendedRemovalQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const latest = await this.prisma.inventoryPlanningSnapshot.groupBy({
      by: ['sellerAccountId'],
      where: { tenantId, ...storeWhere(scope), removalReportQty: { not: null } },
      _max: { snapshotDate: true },
    })
    const pairs = latest.flatMap(item => (item._max.snapshotDate ? [{ sellerAccountId: item.sellerAccountId, snapshotDate: item._max.snapshotDate }] : []))
    const where: Prisma.InventoryPlanningSnapshotWhereInput = {
      tenantId,
      removalReportQty: { gt: 0 },
      OR: pairs.length ? pairs : [{ id: '__none__' }],
      ...(query.q
        ? { AND: [{ OR: [{ sku: { contains: query.q, mode: 'insensitive' } }, { asin: { contains: query.q, mode: 'insensitive' } }, { fnsku: { contains: query.q, mode: 'insensitive' } }] }] }
        : {}),
    }
    const [total, rows, names, freshness] = await Promise.all([
      this.prisma.inventoryPlanningSnapshot.count({ where }),
      this.prisma.inventoryPlanningSnapshot.findMany({
        where,
        orderBy: [{ removalReportQty: query.sort.dir }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.storeNames(tenantId, scope),
      sourceFreshness(this.prisma, tenantId, scope, REMOVAL_KEYS),
    ])
    return {
      state: total ? 'OK' : 'NO_DATA',
      note: total ? null : pairs.length ? '亚马逊最近一次推荐移除报告里没有需要移除的 SKU' : '尚无推荐移除记录；推荐移除报告同步后这里会列出亚马逊建议移除的 SKU',
      items: rows.map(row => ({
        id: row.id,
        sellerAccountId: row.sellerAccountId,
        storeName: names.get(row.sellerAccountId) ?? '',
        sku: row.sku,
        fnsku: row.fnsku,
        asin: row.asin,
        productName: row.productName,
        removalQty: row.removalReportQty ?? 0,
        reason: row.removalReportReason,
        available: row.available,
        estimatedSavings: num(row.estimatedCostSavings),
        snapshotDate: row.snapshotDate.toISOString().slice(0, 10),
        reportUpdatedAt: row.removalReportUpdatedAt ? row.removalReportUpdatedAt.toISOString() : null,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      guide: REMOVAL_GUIDE,
      freshness,
    }
  }

  async detail(req: RequestWithContext, id: string): Promise<RemovalDetailResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PERMISSION, {})
    const parsed = parseRemovalId(id)
    if (!parsed) throw appError('RESOURCE_NOT_FOUND', '移除订单不存在')
    // 店铺不在可见范围内与订单不存在返回同样的 404，不泄露其他店铺有没有这个订单
    if (!scope.unrestricted && !scope.sellerAccountIds.includes(parsed.sellerAccountId)) throw appError('RESOURCE_NOT_FOUND', '移除订单不存在')
    const where = { tenantId: context.tenantId, sellerAccountId: parsed.sellerAccountId }
    const [lines, shipments, receipts, store, freshness] = await Promise.all([
      this.prisma.removalOrder.findMany({ where: { ...where, orderId: parsed.orderId }, orderBy: [{ sku: 'asc' }, { id: 'asc' }], take: 500 }),
      this.prisma.removalShipment.findMany({ where: { ...where, orderId: parsed.orderId }, orderBy: [{ shipDate: 'asc' }, { id: 'asc' }], take: 500 }),
      this.prisma.removalReceipt.findMany({ where: { ...where, removalOrderId: parsed.orderId }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take: 500 }),
      this.prisma.sellerAccount.findFirst({ where: { id: parsed.sellerAccountId, tenantId: context.tenantId }, select: { displayName: true } }),
      sourceFreshness(this.prisma, context.tenantId, scope, REMOVAL_KEYS),
    ])
    if (lines.length === 0) throw appError('RESOURCE_NOT_FOUND', '移除订单不存在')
    const names = await memberNames(
      this.prisma,
      context.tenantId,
      receipts.map(row => row.receivedBy),
    )
    const first = lines[0]
    const type = removalTypeOf(first.type)
    const sum = (pick: (line: (typeof lines)[number]) => number) => lines.reduce((total, line) => total + pick(line), 0)
    const fees = lines.map(line => num(line.fee)).filter((value): value is number => value !== null)
    const shippedQty = sum(line => line.shippedQty)
    const receiptRows = receipts.map(row => ({
      id: row.id,
      sku: row.sku,
      receivedQty: row.receivedQty,
      sellableQty: row.sellableQty,
      damagedQty: row.damagedQty,
      note: row.note,
      receivedAt: dateText(row.receivedAt) ?? '',
      receivedBy: nameOrFormer(names, row.receivedBy),
    }))
    const reconciliation = reconcile(type, lines, receipts)
    const receivedTotal = receipts.length ? receipts.reduce((total, row) => total + row.receivedQty, 0) : null
    const requestDate = lines.map(line => dateText(line.requestDate) ?? '').sort()[0]
    const updated = lines
      .map(line => dateText(line.lastUpdatedDate))
      .filter((value): value is string => Boolean(value))
      .sort()
    const status = first.status
    return {
      order: {
        id,
        sellerAccountId: parsed.sellerAccountId,
        storeName: store?.displayName ?? '',
        orderId: parsed.orderId,
        type,
        typeLabel: REMOVAL_TYPE_LABEL[type],
        status,
        statusLabel: removalStatusLabel(status),
        requestDate,
        lastUpdatedDate: updated.length ? updated[updated.length - 1] : null,
        skuCount: new Set(lines.map(line => line.sku)).size,
        requestedQty: sum(line => line.requestedQty),
        shippedQty,
        disposedQty: sum(line => line.disposedQty),
        cancelledQty: sum(line => line.cancelledQty),
        inProcessQty: sum(line => line.inProcessQty),
        fee: fees.length ? Math.round(fees.reduce((total, value) => total + value, 0) * 100) / 100 : null,
        currency: lines.find(line => line.currency)?.currency ?? null,
        receiptState: removalReceiptState(type, shippedQty, receivedTotal),
        receivedQty: receivedTotal,
        serviceSpeed: first.serviceSpeed,
      },
      lines: lines.map(line => ({
        sku: line.sku,
        fnsku: line.fnsku,
        disposition: line.disposition,
        requestedQty: line.requestedQty,
        shippedQty: line.shippedQty,
        disposedQty: line.disposedQty,
        cancelledQty: line.cancelledQty,
        inProcessQty: line.inProcessQty,
        fee: num(line.fee),
        currency: line.currency,
      })),
      shipments: shipments.map(row => ({
        shipmentId: row.shipmentId,
        sku: row.sku,
        fnsku: row.fnsku,
        disposition: row.disposition,
        carrier: row.carrier,
        trackingNumber: row.trackingNumber,
        shippedQty: row.shippedQty,
        shipDate: dateText(row.shipDate),
      })),
      timeline: buildTimeline({
        requestDate,
        requestedQty: sum(line => line.requestedQty),
        typeLabel: REMOVAL_TYPE_LABEL[type],
        status,
        lastUpdatedDate: updated.length ? updated[updated.length - 1] : null,
        shipments: shipments.map(row => ({ shipDate: dateText(row.shipDate), shippedQty: row.shippedQty, carrier: row.carrier, trackingNumber: row.trackingNumber, sku: row.sku })),
        receipts: receiptRows,
      }),
      returnAddress: { state: 'NOT_CONNECTED', note: '亚马逊的移除订单报告不包含退回地址，请在亚马逊卖家后台的移除订单详情里查看' },
      reconciliation,
      receipts: receiptRows,
      canReceive:
        type !== 'RETURN'
          ? { allowed: false, reason: '只有“退回”类移除订单有退回件需要核对；弃置订单的商品由亚马逊销毁' }
          : shippedQty <= 0
            ? { allowed: false, reason: '订单还没有发货数量，亚马逊发出退回件后才能登记收货' }
            : { allowed: true, reason: null },
      guide: REMOVAL_GUIDE,
      freshness,
    }
  }
}
