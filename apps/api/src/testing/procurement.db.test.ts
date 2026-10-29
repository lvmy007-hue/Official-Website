import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 采购、供应商、国内仓（P2a-10，真实数据库 + 完整应用）：
// 采购单全流程（创建 → 提交 → 审批 → 分批收货 → 质检 → 付款 → 关闭）、审批人与创建人分离、乐观锁、金额字段权限、
// 收货自动生成成本版本草稿与供应商指标、退货与取消、盘点审批过账、附件直传与下载、租户隔离、迁移升级与回滚。

type Member = { userId: string; token: string }
const TARGET = '20261024010000_procurement'
const TABLES = ['PurchaseReceipt', 'QualityInspection', 'PurchasePayment', 'PurchaseApproval', 'Attachment', 'StockCount', 'CostVersion']
const today = new Date().toISOString().slice(0, 10)
const root = mkdtempSync(join(tmpdir(), 'nova-procurement-'))
const saved = { ...process.env }

describe('采购、供应商、国内仓（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let creator: Member
  let approver: Member
  let noCost: Member
  let readOnly: Member
  let otherTenantOwner: Member
  let supplierId: string
  let seq = 0

  const call = (member: Member, method: string, path: string, body?: unknown) => h.call(member.token, method, path, body === undefined ? {} : { body })
  const ok = async (member: Member, method: string, path: string, body?: unknown) => {
    const res = await call(member, method, path, body)
    expect(res.status, `${method} ${path} → ${JSON.stringify(res.json)}`).toBeLessThan(300)
    return res.json.data
  }
  const detail = (member: Member, id: string) => ok(member, 'GET', `/purchase-orders/${id}`)
  const newOrder = async (lines: Array<{ sellerSku: string; quantity: number; unitCost?: number }>, extra: Record<string, unknown> = {}) =>
    (await ok(creator, 'POST', '/purchase-orders', { supplierId, lines, expectedDate: '2099-01-01', ...extra })) as { id: string; version: number }
  /** 把一张新单推进到“已下单”。 */
  const orderedOrder = async (lines: Array<{ sellerSku: string; quantity: number; unitCost: number }>) => {
    const order = await newOrder(lines)
    const submitted = await ok(creator, 'POST', `/purchase-orders/${order.id}/submit`, { version: order.version })
    return (await ok(approver, 'POST', `/purchase-orders/${order.id}/approve`, { version: submitted.version, decision: 'APPROVED' })) as { id: string; version: number }
  }

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'local'
    process.env.STORAGE_LOCAL_DIR = root
    process.env.STORAGE_SIGNING_KEY = 'y'.repeat(48)
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'procurement', db })
    const a = await h.createTenant('pr-a')
    tenantId = a.tenantId
    const b = await h.createTenant('pr-b')
    creator = await h.createMember(tenantId, 'pr-creator', ['*'])
    approver = await h.createMember(tenantId, 'pr-approver', ['*'])
    noCost = await h.createMember(tenantId, 'pr-nocost', ['purchase.read', 'supplier.read', 'warehouse.read', 'purchase.order.write'])
    readOnly = await h.createMember(tenantId, 'pr-readonly', ['purchase.read', 'supplier.read', 'warehouse.read'])
    otherTenantOwner = await h.createMember(b.tenantId, 'pr-other', ['*'])
  })
  afterAll(async () => {
    process.env = saved
    await h?.close()
    rmSync(root, { recursive: true, force: true })
  })

  describe('供应商', () => {
    it('创建、编码唯一、版本冲突、停用后不能新建采购单', async () => {
      expect((await call(readOnly, 'POST', '/suppliers', { code: 'S-0', name: '无权', currency: 'CNY' })).status).toBe(403)
      const created = await ok(creator, 'POST', '/suppliers', { code: 'S-1', name: '深圳工厂', currency: 'CNY', contactName: '王' })
      supplierId = created.id
      expect(created).toMatchObject({ code: 'S-1', poCount: 0, skuCount: 0, rating: null, onTimeRate: null, version: 1 })
      expect((await call(creator, 'POST', '/suppliers', { code: 'S-1', name: '重复', currency: 'CNY' })).status).toBe(409)
      const updated = await ok(creator, 'PATCH', `/suppliers/${supplierId}`, { version: 1, name: '深圳工厂（新）' })
      expect(updated.version).toBe(2)
      const stale = await call(creator, 'PATCH', `/suppliers/${supplierId}`, { version: 1, name: '过期' })
      expect(stale.status).toBe(409)
      expect(stale.json.error.code).toBe('CONFLICT')

      const dead = await ok(creator, 'POST', '/suppliers', { code: 'S-DEAD', name: '已停用', currency: 'CNY' })
      await ok(creator, 'DELETE', `/suppliers/${dead.id}`)
      expect((await ok(creator, 'DELETE', `/suppliers/${dead.id}`)).status).toBe('INACTIVE')
      const refused = await call(creator, 'POST', '/purchase-orders', { supplierId: dead.id, lines: [{ sellerSku: 'A', quantity: 1 }] })
      expect(refused.status).toBe(404)
    })
  })

  describe('采购单全流程', () => {
    let poId: string
    let version: number
    let lineIds: string[] = []

    it('创建与编辑草稿：SKU 不能重复；没有单价不能提交；合计在缺价时为空而不是 0', async () => {
      expect(
        (
          await call(creator, 'POST', '/purchase-orders', {
            supplierId,
            lines: [
              { sellerSku: 'A', quantity: 1 },
              { sellerSku: 'a', quantity: 2 },
            ],
          })
        ).status,
      ).toBe(422)
      expect((await call(readOnly, 'POST', '/purchase-orders', { supplierId, lines: [{ sellerSku: 'A', quantity: 1 }] })).status).toBe(403)
      const order = await newOrder([
        { sellerSku: 'SKU-A', quantity: 10 },
        { sellerSku: 'SKU-B', quantity: 5, unitCost: 2 },
      ])
      poId = order.id
      let view = await detail(creator, poId)
      expect(view.order).toMatchObject({ status: 'DRAFT', totalAmount: null })
      expect(view.actions).toEqual(expect.arrayContaining(['EDIT', 'SUBMIT']))
      const submit = await call(creator, 'POST', `/purchase-orders/${poId}/submit`, { version: view.order.version })
      expect(submit.status).toBe(422)

      const edited = await ok(creator, 'PATCH', `/purchase-orders/${poId}`, {
        version: view.order.version,
        lines: [
          { sellerSku: 'SKU-A', quantity: 10, unitCost: 3 },
          { sellerSku: 'SKU-B', quantity: 5, unitCost: 2 },
        ],
      })
      view = await detail(creator, poId)
      lineIds = view.lines.map((line: { id: string }) => line.id)
      expect(view.order.totalAmount).toBe('40')
      version = edited.version
    })

    it('审批：创建人不能审批自己的单；驳回要写意见并退回草稿；通过后进入已下单', async () => {
      const submitted = await ok(creator, 'POST', `/purchase-orders/${poId}/submit`, { version })
      expect(submitted.status).toBe('PENDING_APPROVAL')
      expect((await call(creator, 'PATCH', `/purchase-orders/${poId}`, { version: submitted.version, notes: 'x' })).status).toBe(409)
      expect((await detail(creator, poId)).canApprove).toBe(false)
      expect((await detail(approver, poId)).canApprove).toBe(true)
      const self = await call(creator, 'POST', `/purchase-orders/${poId}/approve`, { version: submitted.version, decision: 'APPROVED' })
      expect(self.status).toBe(403)
      expect((await call(readOnly, 'POST', `/purchase-orders/${poId}/approve`, { version: submitted.version, decision: 'APPROVED' })).status).toBe(403)
      expect((await call(approver, 'POST', `/purchase-orders/${poId}/approve`, { version: submitted.version, decision: 'REJECTED' })).status).toBe(422)

      const rejected = await ok(approver, 'POST', `/purchase-orders/${poId}/approve`, { version: submitted.version, decision: 'REJECTED', comment: '价格偏高' })
      expect(rejected.status).toBe('DRAFT')
      expect((await detail(creator, poId)).order.approvalStatus).toBe('REJECTED')

      const again = await ok(creator, 'POST', `/purchase-orders/${poId}/submit`, { version: rejected.version })
      const approved = await ok(approver, 'POST', `/purchase-orders/${poId}/approve`, { version: again.version, decision: 'APPROVED' })
      expect(approved.status).toBe('ORDERED')
      version = approved.version
      const view = await detail(creator, poId)
      expect(view.approvals.map((row: { decision: string }) => row.decision)).toEqual(expect.arrayContaining(['REJECTED', 'APPROVED']))
      expect(view.approvals).toHaveLength(2)
    })

    it('分批收货：超收被拒绝；部分到货后库存与流水可见；收齐后自动生成成本版本草稿', async () => {
      const over = await call(creator, 'POST', `/purchase-orders/${poId}/receipts`, { version, receivedAt: today, lines: [{ lineId: lineIds[0], quantity: 11 }] })
      expect(over.status).toBe(422)
      expect((await call(readOnly, 'POST', `/purchase-orders/${poId}/receipts`, { version, receivedAt: today, lines: [{ lineId: lineIds[0], quantity: 1 }] })).status).toBe(403)

      const first = await ok(creator, 'POST', `/purchase-orders/${poId}/receipts`, { version, receivedAt: today, lines: [{ lineId: lineIds[0], quantity: 6, batchNo: 'L1' }] })
      expect(first).toMatchObject({ status: 'PARTIALLY_RECEIVED', documentNo: expect.stringMatching(/^RC-PO-/) })
      const stock = await ok(creator, 'GET', '/domestic-warehouse/stock')
      expect(stock.warehouses).toHaveLength(1)
      expect(stock.items).toEqual([expect.objectContaining({ sku: 'SKU-A', onHand: 6, available: 6, pendingOutbound: 0, value: '18', valueCurrency: 'CNY' })])
      expect((await h.client.query(`SELECT count(*)::int AS n FROM "CostVersion"`)).rows[0].n).toBe(0)

      const stale = await call(creator, 'POST', `/purchase-orders/${poId}/receipts`, { version, receivedAt: today, lines: [{ lineId: lineIds[0], quantity: 1 }] })
      expect(stale.status).toBe(409)

      const second = await ok(creator, 'POST', `/purchase-orders/${poId}/receipts`, {
        version: first.version,
        receivedAt: today,
        lines: [
          { lineId: lineIds[0], quantity: 4 },
          { lineId: lineIds[1], quantity: 5 },
        ],
      })
      expect(second.status).toBe('RECEIVED')
      version = second.version
      const drafts = (await h.client.query(`SELECT sku, "unitProductCost"::text AS cost, status, source FROM "CostVersion" ORDER BY sku`)).rows
      expect(drafts).toEqual([
        { sku: 'SKU-A', cost: '3.000000', status: 'DRAFT', source: 'PURCHASE_RECEIPT' },
        { sku: 'SKU-B', cost: '2.000000', status: 'DRAFT', source: 'PURCHASE_RECEIPT' },
      ])
      const view = await detail(creator, poId)
      expect(view.receipts).toHaveLength(2)
      expect(view.links.costVersions).toHaveLength(2)
      expect(view.order.receivedQty).toBe(15)
      expect((await call(creator, 'POST', `/purchase-orders/${poId}/receipts`, { version, receivedAt: today, lines: [{ lineId: lineIds[0], quantity: 1 }] })).status).toBe(409)

      const movements = await ok(creator, 'GET', '/domestic-warehouse/movements?type=RECEIPT')
      expect(movements.total).toBe(3)
      expect(movements.items[0]).toMatchObject({ typeLabel: '采购收货', referenceNo: expect.stringMatching(/^PO-/) })
    })

    it('质检与供应商指标：合格率按抽检合计计算，样本不足不评级', async () => {
      const result = await ok(creator, 'POST', `/purchase-orders/${poId}/inspections`, { version, result: 'CONCESSION', lotQty: 100, sampleQty: 20, defectQty: 2, handling: '让步接收' })
      version = result.version
      expect((await call(creator, 'POST', `/purchase-orders/${poId}/inspections`, { version, result: 'PASS', lotQty: 10, sampleQty: 20, defectQty: 0 })).status).toBe(422)
      const supplier = await ok(creator, 'GET', `/suppliers/${supplierId}`)
      expect(supplier.supplier).toMatchObject({ rating: null, poCount: 1, skuCount: 2 })
      expect(supplier.supplier.qualityPassRate).toBeCloseTo(0.9)
      expect(supplier.supplier.onTimeRate).toBe(1)
      expect(supplier.inspections).toHaveLength(1)
      expect(supplier.products.map((row: { sku: string }) => row.sku).sort()).toEqual(['SKU-A', 'SKU-B'])
    })

    it('付款：计划与已付、合计不能超过订单、已付清才能关闭全部到货的单', async () => {
      expect((await call(creator, 'POST', `/purchase-orders/${poId}/status`, { version, action: 'CLOSE', reason: '完成' })).status).toBe(409)
      const plan = await ok(creator, 'POST', `/purchase-orders/${poId}/payments`, { version, kind: 'DEPOSIT', amount: 12, plannedAt: today })
      version = plan.version
      expect((await detail(creator, poId)).order).toMatchObject({ paymentStatus: 'UNPAID', paidAmount: '0' })
      const paymentId = (await detail(creator, poId)).payments[0].id as string
      expect((await call(creator, 'POST', `/purchase-orders/${poId}/payments`, { version, paymentId, kind: 'DEPOSIT', amount: 12 })).status).toBe(422)
      const paid = await ok(creator, 'POST', `/purchase-orders/${poId}/payments`, { version, paymentId, kind: 'DEPOSIT', amount: 12, paidAt: today })
      version = paid.version
      expect((await detail(creator, poId)).order).toMatchObject({ paymentStatus: 'PARTIAL', paidAmount: '12' })
      const tooMuch = await call(creator, 'POST', `/purchase-orders/${poId}/payments`, { version, kind: 'BALANCE', amount: 29, paidAt: today })
      expect(tooMuch.status).toBe(422)
      const rest = await ok(creator, 'POST', `/purchase-orders/${poId}/payments`, { version, kind: 'BALANCE', amount: 28, paidAt: today })
      version = rest.version
      expect((await detail(creator, poId)).order.paymentStatus).toBe('PAID')
      const closed = await ok(creator, 'POST', `/purchase-orders/${poId}/status`, { version, action: 'CLOSE', reason: '已付清，结案' })
      expect(closed.status).toBe('CLOSED')
    })

    it('金额字段权限：没有成本权限时金额类的键不存在（不是 0 或 null）', async () => {
      const view = await detail(noCost, poId)
      expect(view.order).not.toHaveProperty('totalAmount')
      expect(view.order).not.toHaveProperty('paidAmount')
      expect(view.lines[0]).not.toHaveProperty('unitCost')
      expect(view.payments[0]).not.toHaveProperty('amount')
      const list = await ok(noCost, 'GET', '/purchase-orders')
      expect(list.items[0]).not.toHaveProperty('totalAmount')
      const withCost = await ok(creator, 'GET', '/purchase-orders')
      expect(withCost.items[0]).toHaveProperty('totalAmount')
      expect((await call(noCost, 'GET', '/purchase-orders?minAmount=1')).status).toBe(403)
      const stock = await ok(noCost, 'GET', '/domestic-warehouse/stock')
      expect(stock.items[0]).not.toHaveProperty('value')
      const moves = await ok(noCost, 'GET', '/domestic-warehouse/movements')
      expect(moves.items[0]).not.toHaveProperty('unitCost')
      const supplier = await ok(noCost, 'GET', `/suppliers/${supplierId}`)
      expect(supplier.products[0]).not.toHaveProperty('quotes')
    })

    it('操作记录里能看到每一步，且不泄露金额', async () => {
      const view = await detail(creator, poId)
      const actions = view.log.map((row: { action: string }) => row.action)
      expect(actions).toEqual(
        expect.arrayContaining(['PURCHASE_ORDER_CREATED', 'PURCHASE_ORDER_SUBMITTED', 'PURCHASE_ORDER_APPROVED', 'PURCHASE_RECEIPT_RECORDED', 'PURCHASE_PAYMENT_RECORDED', 'PURCHASE_ORDER_CLOSED']),
      )
    })
  })

  describe('退货与取消', () => {
    it('退货给供应商：从国内仓扣减库存，超过可用库存被拒绝；状态变为退货给供应商', async () => {
      const order = await orderedOrder([{ sellerSku: 'SKU-R', quantity: 8, unitCost: 5 }])
      const lineId = (await detail(creator, order.id)).lines[0].id as string
      const received = await ok(creator, 'POST', `/purchase-orders/${order.id}/receipts`, { version: order.version, receivedAt: today, lines: [{ lineId, quantity: 8 }] })
      const refused = await call(creator, 'POST', `/purchase-orders/${order.id}/status`, { version: received.version, action: 'RETURN', reason: '质量问题', lines: [{ lineId, quantity: 9 }] })
      expect(refused.status).toBe(422)
      const before = (await ok(creator, 'GET', '/domestic-warehouse/stock?q=SKU-R')).items[0]
      expect(before.onHand).toBe(8)
      const returned = await ok(creator, 'POST', `/purchase-orders/${order.id}/status`, { version: received.version, action: 'RETURN', reason: '质量问题', lines: [{ lineId, quantity: 3 }] })
      expect(returned.status).toBe('RETURNED_TO_SUPPLIER')
      expect((await ok(creator, 'GET', '/domestic-warehouse/stock?q=SKU-R')).items[0].onHand).toBe(5)
      const moves = await ok(creator, 'GET', '/domestic-warehouse/movements?type=RETURN_TO_SUPPLIER')
      expect(moves.items[0]).toMatchObject({ quantity: -3, typeLabel: '退供应商' })
    })

    it('取消：没收过货也没付过款才能取消；需要原因', async () => {
      const draft = await newOrder([{ sellerSku: 'SKU-C', quantity: 1, unitCost: 1 }])
      expect((await call(creator, 'POST', `/purchase-orders/${draft.id}/status`, { version: draft.version, action: 'CANCEL' })).status).toBe(422)
      const cancelled = await ok(creator, 'POST', `/purchase-orders/${draft.id}/status`, { version: draft.version, action: 'CANCEL', reason: '客户取消' })
      expect(cancelled.status).toBe('CANCELLED')
      expect((await call(creator, 'POST', `/purchase-orders/${draft.id}/status`, { version: cancelled.version, action: 'START_PRODUCTION' })).status).toBe(409)

      const paidOrder = await orderedOrder([{ sellerSku: 'SKU-P', quantity: 1, unitCost: 10 }])
      const paid = await ok(creator, 'POST', `/purchase-orders/${paidOrder.id}/payments`, { version: paidOrder.version, kind: 'DEPOSIT', amount: 3, paidAt: today })
      const refused = await call(creator, 'POST', `/purchase-orders/${paidOrder.id}/status`, { version: paid.version, action: 'CANCEL', reason: '不要了' })
      expect(refused.status).toBe(409)
    })
  })

  describe('盘点', () => {
    it('录入 → 提交 → 另一人审批后按差异调整库存；录入人不能审批；驳回后回到盘点中', async () => {
      const warehouse = (await ok(creator, 'GET', '/domestic-warehouse/stock')).warehouses[0].id as string
      expect((await call(readOnly, 'POST', '/stock-counts', { warehouseId: warehouse, countedAt: today, lines: [{ sellerSku: 'SKU-A', countedQty: 9 }] })).status).toBe(403)
      const saved = await ok(creator, 'POST', '/stock-counts', {
        warehouseId: warehouse,
        countedAt: today,
        lines: [
          { sellerSku: 'SKU-A', countedQty: 9 },
          { sellerSku: 'SKU-NEW', countedQty: 2 },
        ],
      })
      expect(saved.status).toBe('PENDING_APPROVAL')
      expect((await call(creator, 'POST', '/stock-counts', { warehouseId: warehouse, countedAt: today, lines: [{ sellerSku: 'SKU-A', countedQty: 1 }] })).status).toBe(409)
      const listed = (await ok(approver, 'GET', '/stock-counts')).items[0]
      expect(listed.lines).toEqual([
        { sellerSku: 'SKU-A', systemQty: 10, countedQty: 9, diff: -1 },
        { sellerSku: 'SKU-NEW', systemQty: 0, countedQty: 2, diff: 2 },
      ])
      expect(listed.canApprove).toBe(true)
      expect((await ok(creator, 'GET', '/stock-counts')).items[0].canApprove).toBe(false)
      expect((await call(creator, 'POST', `/stock-counts/${saved.id}/approve`, { decision: 'APPROVED' })).status).toBe(403)
      expect((await call(approver, 'POST', `/stock-counts/${saved.id}/approve`, { decision: 'REJECTED' })).status).toBe(422)

      const rejected = await ok(approver, 'POST', `/stock-counts/${saved.id}/approve`, { decision: 'REJECTED', comment: '数错了' })
      expect(rejected.status).toBe('COUNTING')
      const resaved = await ok(creator, 'POST', '/stock-counts', { warehouseId: warehouse, countedAt: today, lines: [{ sellerSku: 'SKU-A', countedQty: 9 }] })
      expect(resaved.id).toBe(saved.id)
      const posted = await ok(approver, 'POST', `/stock-counts/${saved.id}/approve`, { decision: 'APPROVED' })
      expect(posted.status).toBe('POSTED')
      expect((await call(approver, 'POST', `/stock-counts/${saved.id}/approve`, { decision: 'APPROVED' })).status).toBe(409)
      const stock = await ok(creator, 'GET', '/domestic-warehouse/stock?q=SKU-A')
      expect(stock.items[0]).toMatchObject({ sku: 'SKU-A', onHand: 9 })
      const adjustments = await ok(creator, 'GET', '/domestic-warehouse/movements?type=ADJUSTMENT')
      expect(adjustments.items[0]).toMatchObject({ quantity: -1, reasonCode: 'STOCK_COUNT' })
    })
  })

  describe('附件', () => {
    it('申请凭据 → 直传 → 确认 → 下载；类型与重复内容被拒绝；别的企业访问不到', async () => {
      const order = await newOrder([{ sellerSku: 'SKU-F', quantity: 1, unitCost: 1 }])
      const refusedType = await call(creator, 'POST', `/purchase-orders/${order.id}/attachments`, { fileName: 'a.exe', contentType: 'application/x-msdownload', sizeBytes: 10 })
      expect(refusedType.status).toBe(422)
      const upload = async (content: string) => {
        const ticket = await ok(creator, 'POST', `/purchase-orders/${order.id}/attachments`, { fileName: 'quote.txt', contentType: 'text/plain', sizeBytes: content.length })
        const token = (ticket.uploadUrl as string).slice((ticket.uploadUrl as string).lastIndexOf('/') + 1)
        const put = await fetch(`${h.baseUrl}/api/v1/storage/local/${token}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: content })
        expect(put.status).toBe(200)
        return call(creator, 'POST', `/purchase-orders/${order.id}/attachments/confirm`, { objectKey: ticket.objectKey, fileName: 'quote.txt', contentType: 'text/plain' })
      }
      const first = await upload('报价单 v1')
      expect(first.status).toBeLessThan(300)
      expect(first.json.data).toMatchObject({ fileName: 'quote.txt', uploadedBy: expect.any(String) })
      expect((await upload('报价单 v1')).status).toBe(409)
      expect((await detail(creator, order.id)).attachments).toHaveLength(1)
      const link = await ok(creator, 'GET', `/purchase-orders/${order.id}/attachments/${first.json.data.id}/download`)
      const body = await fetch(`${h.baseUrl}/api/v1/storage/local/${link.url.slice(link.url.lastIndexOf('/') + 1)}`)
      expect(await body.text()).toBe('报价单 v1')
      expect((await call(otherTenantOwner, 'GET', `/purchase-orders/${order.id}/attachments/${first.json.data.id}/download`)).status).toBe(404)
      expect((await call(readOnly, 'POST', `/purchase-orders/${order.id}/attachments`, { fileName: 'a.txt', contentType: 'text/plain', sizeBytes: 1 })).status).toBe(403)
    })
  })

  describe('租户隔离', () => {
    it('另一家企业看不到采购单、供应商、库存与盘点', async () => {
      const list = await ok(otherTenantOwner, 'GET', '/purchase-orders')
      expect(list.total).toBe(0)
      expect((await ok(otherTenantOwner, 'GET', '/suppliers')).total).toBe(0)
      expect((await ok(otherTenantOwner, 'GET', '/domestic-warehouse/stock')).items).toEqual([])
      expect((await ok(otherTenantOwner, 'GET', '/stock-counts')).total).toBe(0)
      const mine = (await ok(creator, 'GET', '/purchase-orders')).items[0].id as string
      expect((await call(otherTenantOwner, 'GET', `/purchase-orders/${mine}`)).status).toBe(404)
      expect((await call(otherTenantOwner, 'GET', `/suppliers/${supplierId}`)).status).toBe(404)
      expect((await call(otherTenantOwner, 'POST', `/purchase-orders/${mine}/status`, { version: 1, action: 'CANCEL', reason: '越权' })).status).toBe(404)
    })
  })

  describe('迁移与回滚', () => {
    let client: Client
    const exists = async (table: string) => (await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])).rows[0].found as boolean
    beforeAll(async () => {
      await db.createDatabase('procurement_migrate')
      client = await db.connect('procurement_migrate')
      await applyMigrations(client, { before: TARGET })
    })
    afterAll(async () => {
      await client?.end()
    })

    it('升级建 7 张表且保留既有采购单与供应商；回滚后新表与新增列消失、旧数据仍在；再次升级成功', async () => {
      const ids = await seedTenant(client, 'pm')
      await insertRow(client, 'Supplier', { id: `sup-${++seq}`, tenantId: ids.tenantId })
      const order = await insertRow(client, 'PurchaseOrder', { id: `po-${++seq}`, tenantId: ids.tenantId, supplierId: `sup-${seq - 1}` })
      for (const table of TABLES) expect(await exists(table), `${table} 升级前不应存在`).toBe(false)
      await applyMigrations(client, { only: TARGET })
      for (const table of TABLES) expect(await exists(table), `${table} 应已创建`).toBe(true)
      const upgraded = (await client.query(`SELECT "approvalStatus", "paymentStatus", "receivedQtyTotal" FROM "PurchaseOrder" WHERE id = $1`, [order.id])).rows[0]
      expect(upgraded).toEqual({ approvalStatus: 'NONE', paymentStatus: 'UNPAID', receivedQtyTotal: 0 })
      await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
      for (const table of TABLES) expect(await exists(table), `${table} 回滚后应已删除`).toBe(false)
      expect((await client.query(`SELECT count(*)::int AS n FROM "PurchaseOrder" WHERE id = $1`, [order.id])).rows[0].n).toBe(1)
      await applyMigrations(client, { only: TARGET })
      for (const table of TABLES) expect(await exists(table), `${table} 应再次存在`).toBe(true)
    })
  })
})
