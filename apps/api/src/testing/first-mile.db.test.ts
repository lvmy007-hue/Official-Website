import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 头程物流（P2a-11，真实数据库 + 完整应用）：
// 货代与运单（校验、乐观锁、日期先后）、节点（手工、货代文件导入、去重）、费用与分摊（锁定、成本版本草稿、撤销）、出库（库存不足整张拒绝）、
// 实际时效统计与回写补货策略、金额字段权限、附件、租户隔离、迁移升级与回滚。

type Member = { userId: string; token: string }
const TARGET = '20261024020000_first_mile'
const TABLES = ['FreightForwarder', 'FirstMileShipment', 'FirstMileShipmentItem', 'FirstMileCost', 'FirstMileMilestone', 'LandedCostAllocation', 'TransitTimeStat']
const DAY = 86_400_000
const dayText = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10)
const root = mkdtempSync(join(tmpdir(), 'nova-first-mile-'))
const saved = { ...process.env }

const policyBody = {
  level: 'TENANT',
  levelRef: 'ALL',
  expectedVersionNo: 0,
  leadTimeDays: 30,
  awdLeadTimeDays: null,
  safetyDays: 14,
  coverageDays: 60,
  redundancyMultiplier: 1.5,
  inboundCounted: ['WORKING', 'SHIPPED'],
  agingFromDays: 271,
  changeReason: '初始策略',
  productionDays: 10,
  domesticDays: 3,
  receivingDays: 7,
  serviceLevel: 0.95,
  transportPreference: 'AUTO',
  transportOptions: [{ mode: 'SEA', transitDays: 30, unitCost: 0.5 }],
  casePackQty: 10,
  moq: 100,
  minOrderValue: null,
}

describe('头程物流（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let otherTenantId: string
  let sellerAccountId: string
  let owner: Member
  let noCost: Member
  let readOnly: Member
  let noPolicy: Member
  let other: Member
  let forwarderId: string
  let warehouseId: string
  let seq = 0

  const call = (member: Member, method: string, path: string, body?: unknown) => h.call(member.token, method, path, body === undefined ? {} : { body })
  const ok = async (member: Member, method: string, path: string, body?: unknown) => {
    const res = await call(member, method, path, body)
    expect(res.status, `${method} ${path} → ${JSON.stringify(res.json)}`).toBeLessThan(300)
    return res.json.data
  }
  const detail = (id: string, member: Member = owner) => ok(member, 'GET', `/first-mile/${id}`)
  const draft = (extra: Record<string, unknown> = {}) => ({
    forwarderId,
    waybillNo: `WB-${++seq}`,
    mode: 'SEA',
    customsStatus: 'NOT_STARTED',
    currency: 'USD',
    linkedInboundShipmentIds: [],
    items: [{ sku: 'SKU-A', quantity: 10 }],
    ...extra,
  })
  const create = async (extra: Record<string, unknown> = {}) => (await ok(owner, 'POST', '/first-mile', draft(extra))) as { id: string; version: number }

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'local'
    process.env.STORAGE_LOCAL_DIR = root
    process.env.STORAGE_SIGNING_KEY = 'z'.repeat(48)
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'first_mile', db })
    const a = await h.createTenant('fm-a')
    tenantId = a.tenantId
    sellerAccountId = a.sellerAccountId
    const b = await h.createTenant('fm-b')
    otherTenantId = b.tenantId
    owner = await h.createMember(tenantId, 'fm-owner', ['*'])
    noCost = await h.createMember(tenantId, 'fm-nocost', ['firstmile.read', 'firstmile.write', 'warehouse.read'])
    readOnly = await h.createMember(tenantId, 'fm-readonly', ['firstmile.read', 'field.cost'])
    noPolicy = await h.createMember(tenantId, 'fm-nopolicy', ['firstmile.read', 'firstmile.write', 'field.cost'])
    other = await h.createMember(b.tenantId, 'fm-other', ['*'])
    warehouseId = (await insertRow(h.client, 'Warehouse', { id: 'wh-fm', tenantId, code: 'WH-FM', name: '深圳仓', kind: 'DOMESTIC' })).id
  })
  afterAll(async () => {
    process.env = saved
    await h?.close()
    rmSync(root, { recursive: true, force: true })
  })

  describe('货代', () => {
    it('创建、重名冲突、乐观锁、停用后不能新建运单', async () => {
      expect((await call(readOnly, 'POST', '/freight-forwarders', { name: '无权' })).status).toBe(403)
      const created = await ok(owner, 'POST', '/freight-forwarders', { name: '海运通', contact: '李', defaultMode: 'SEA' })
      forwarderId = created.id
      expect(created).toMatchObject({ name: '海运通', status: 'ACTIVE', shipmentCount: 0, version: 1 })
      expect((await call(owner, 'POST', '/freight-forwarders', { name: '海运通' })).status).toBe(409)
      const updated = await ok(owner, 'PATCH', `/freight-forwarders/${forwarderId}`, { version: 1, contact: '李四' })
      expect(updated).toMatchObject({ contact: '李四', version: 2 })
      expect((await call(owner, 'PATCH', `/freight-forwarders/${forwarderId}`, { version: 1, contact: '过期' })).status).toBe(409)

      const dead = await ok(owner, 'POST', '/freight-forwarders', { name: '已停合作' })
      await ok(owner, 'PATCH', `/freight-forwarders/${dead.id}`, { version: 1, status: 'INACTIVE' })
      const refused = await call(owner, 'POST', '/first-mile', draft({ forwarderId: dead.id }))
      expect(refused.status).toBe(422)
      expect((await ok(owner, 'GET', '/freight-forwarders?status=ACTIVE')).items.map((row: { name: string }) => row.name)).toEqual(['海运通'])
    })
  })

  describe('运单', () => {
    it('创建：没有权限 403；日期倒挂、货代或仓库不存在、重复运单号被拒绝', async () => {
      expect((await call(readOnly, 'POST', '/first-mile', draft())).status).toBe(403)
      expect((await call(owner, 'POST', '/first-mile', draft({ shipDate: '2026-10-10', etaPort: '2026-10-01' }))).status).toBe(422)
      expect((await call(owner, 'POST', '/first-mile', draft({ forwarderId: 'nope' }))).status).toBe(422)
      expect((await call(owner, 'POST', '/first-mile', draft({ warehouseId: 'nope' }))).status).toBe(422)
      expect((await call(owner, 'POST', '/first-mile', draft({ linkedInboundShipmentIds: ['SH-NOPE'] }))).status).toBe(422)
      const first = await create({ waybillNo: 'DUP-1' })
      expect(first.version).toBe(1)
      const dup = await call(owner, 'POST', '/first-mile', draft({ waybillNo: 'DUP-1' }))
      expect(dup.status).toBe(409)
      expect(dup.json.error.code).toBe('CONFLICT')
    })

    it('关联入仓货件：同步过的能关联，详情里带出状态；未同步的在创建时就被拒绝', async () => {
      const plan = await insertRow(h.client, 'FbaInboundPlan', { id: 'plan-fm', tenantId, sellerAccountId })
      await insertRow(h.client, 'FbaInboundShipment', { id: 'ibs-fm', planId: plan.id, shipmentId: 'FBA-SHIP-1', status: 'WORKING', unitsExpected: 10 })
      const row = await create({ linkedInboundShipmentIds: ['FBA-SHIP-1'] })
      const view = await detail(row.id)
      expect(view.linkedInbound).toEqual([expect.objectContaining({ shipmentId: 'FBA-SHIP-1', found: true, status: 'WORKING', unitsExpected: 10 })])
    })

    it('明细引用采购单：详情带出采购单号，采购单的关联页签列出运单（数量相加）；没有头程读权限只写无权查看；别的企业的采购单被拒绝', async () => {
      const supplier = await insertRow(h.client, 'Supplier', { id: 'sup-fm', tenantId })
      const po = await insertRow(h.client, 'PurchaseOrder', { id: 'po-fm', tenantId, supplierId: supplier.id, number: 'PO-FM-1' })
      const row = await create({
        items: [
          { sku: 'PO-A', quantity: 3, purchaseOrderId: po.id },
          { sku: 'PO-B', quantity: 4, purchaseOrderId: po.id },
        ],
      })
      expect((await detail(row.id)).items.map((item: { purchaseOrderNo: string }) => item.purchaseOrderNo)).toEqual(['PO-FM-1', 'PO-FM-1'])
      const links = (await ok(owner, 'GET', `/purchase-orders/${po.id}`)).links
      expect(links.firstMile).toEqual([expect.objectContaining({ id: row.id, forwarderName: '海运通', quantity: 7 })])
      const poOnly = await h.createMember(tenantId, 'fm-poonly', ['purchase.read'])
      expect((await ok(poOnly, 'GET', `/purchase-orders/${po.id}`)).links.firstMile).toBe('NO_PERMISSION')
      const otherSupplier = await insertRow(h.client, 'Supplier', { id: 'sup-fm-b', tenantId: otherTenantId })
      const foreign = await insertRow(h.client, 'PurchaseOrder', { id: 'po-fm-b', tenantId: otherSupplier.tenantId, supplierId: otherSupplier.id, number: 'PO-FM-B' })
      expect((await call(owner, 'POST', '/first-mile', draft({ items: [{ sku: 'X', quantity: 1, purchaseOrderId: foreign.id }] }))).status).toBe(422)
    })

    it('采购单的入仓计划：顺着头程运单上登记的入仓货件推算；两项读权限缺一不可', async () => {
      const supplier = await insertRow(h.client, 'Supplier', { id: 'sup-ip', tenantId, code: 'SUP-IP' })
      const po = await insertRow(h.client, 'PurchaseOrder', { id: 'po-ip', tenantId, supplierId: supplier.id, number: 'PO-IP-1' })
      const plan = await insertRow(h.client, 'FbaInboundPlan', { id: 'plan-ip', tenantId, sellerAccountId, name: '10 月补货', stage: 'CREATED' })
      await insertRow(h.client, 'FbaInboundShipment', { id: 'ibs-ip-1', planId: plan.id, shipmentId: 'FBA-IP-1', status: 'WORKING' })
      await insertRow(h.client, 'FbaInboundShipment', { id: 'ibs-ip-2', planId: plan.id, shipmentId: 'FBA-IP-2', status: 'WORKING' })
      expect((await ok(owner, 'GET', `/purchase-orders/${po.id}`)).links.inboundPlans).toEqual([])
      await create({ items: [{ sku: 'IP-A', quantity: 5, purchaseOrderId: po.id }], linkedInboundShipmentIds: ['FBA-IP-1', 'FBA-IP-2'] })
      expect((await ok(owner, 'GET', `/purchase-orders/${po.id}`)).links.inboundPlans).toEqual([
        { id: 'plan-ip', name: '10 月补货', stage: 'CREATED', stageLabel: '入仓计划已创建', shipmentIds: ['FBA-IP-1', 'FBA-IP-2'] },
      ])
      const onlyFirstMile = await h.createMember(tenantId, 'ip-fm-only', ['purchase.read', 'firstmile.read'])
      expect((await ok(onlyFirstMile, 'GET', `/purchase-orders/${po.id}`)).links.inboundPlans).toBe('NO_PERMISSION')
      const onlyInbound = await h.createMember(tenantId, 'ip-in-only', ['purchase.read', 'inbound.read'])
      expect((await ok(onlyInbound, 'GET', `/purchase-orders/${po.id}`)).links.inboundPlans).toBe('NO_PERMISSION')
    })

    it('修改：乐观锁；合并后的日期仍要先后合理；整体替换明细；列表按阶段与关键字筛选', async () => {
      const row = await create({ shipDate: dayText(-5), etaPort: dayText(10), items: [{ sku: 'SKU-U', quantity: 5 }] })
      expect((await call(owner, 'PATCH', `/first-mile/${row.id}`, { version: 1, ataPort: dayText(-9) })).status).toBe(422)
      const updated = await ok(owner, 'PATCH', `/first-mile/${row.id}`, {
        version: 1,
        containerNo: 'CNT-1',
        items: [
          { sku: 'SKU-U', quantity: 8 },
          { sku: 'SKU-V', quantity: 2 },
        ],
      })
      expect(updated.version).toBe(2)
      expect((await call(owner, 'PATCH', `/first-mile/${row.id}`, { version: 1, note: '过期' })).status).toBe(409)
      const view = await detail(row.id)
      expect(view.items.map((item: { sku: string; quantity: number }) => `${item.sku}:${item.quantity}`)).toEqual(['SKU-U:8', 'SKU-V:2'])
      expect(view.shipment).toMatchObject({ containerNo: 'CNT-1', stage: 'IN_TRANSIT', totalQty: 10, itemCount: 2 })
      const transit = await ok(owner, 'GET', '/first-mile?stage=IN_TRANSIT&q=CNT-1')
      expect(transit.items.map((item: { id: string }) => item.id)).toEqual([row.id])
      expect((await ok(owner, 'GET', '/first-mile?stage=DELIVERED&q=CNT-1')).total).toBe(0)
    })
  })

  describe('节点', () => {
    it('手工录入、同一节点同一时间不能重复；只能删手工录入的；版本过期 409', async () => {
      const row = await create({ shipDate: dayText(-3) })
      const body = { version: 1, milestone: 'DEPARTED', occurredAt: `${dayText(-3)}T08:00:00Z`, location: '盐田港' }
      const added = await ok(owner, 'POST', `/first-mile/${row.id}/milestones`, body)
      expect(added.version).toBe(2)
      expect((await call(owner, 'POST', `/first-mile/${row.id}/milestones`, { ...body, version: 2 })).status).toBe(409)
      expect((await call(owner, 'POST', `/first-mile/${row.id}/milestones`, { ...body, version: 1 })).status).toBe(409)
      expect((await call(owner, 'POST', `/first-mile/${row.id}/milestones`, { ...body, version: 2, milestone: 'ARRIVED_PORT', occurredAt: new Date(Date.now() + 5 * DAY).toISOString() })).status).toBe(
        422,
      )
      expect((await call(readOnly, 'POST', `/first-mile/${row.id}/milestones`, { ...body, version: 2 })).status).toBe(403)
      const view = await detail(row.id)
      expect(view.milestones).toEqual([expect.objectContaining({ milestone: 'DEPARTED', source: 'MANUAL', location: '盐田港' })])
      const removed = await ok(owner, 'DELETE', `/first-mile/${row.id}/milestones/${view.milestones[0].id}?version=${added.version}`)
      expect(removed.version).toBe(3)
      expect((await detail(row.id)).milestones).toEqual([])
    })

    it('货代文件导入：运单号对不上、一行有错整份拒绝；成功后来源是文件导入，重复导入跳过；导入的不能手工删', async () => {
      const waybillNo = 'IMP-1'
      const row = await create({ waybillNo })
      const good = ['头程单号,节点,发生时间,地点', `${waybillNo},Departed,${dayText(-6)} 10:00,Yantian`, `${waybillNo},到港,${dayText(-2)},Los Angeles`].join('\n')
      const foreign = await call(owner, 'POST', `/first-mile/${row.id}/milestones/import`, { version: 1, fileName: 'x.csv', content: good.replaceAll(waybillNo, 'OTHER-9') })
      expect(foreign.status).toBe(422)
      const broken = await call(owner, 'POST', `/first-mile/${row.id}/milestones/import`, { version: 1, fileName: 'x.csv', content: `${good}\n${waybillNo},到港,2026-13-45,` })
      expect(broken.status).toBe(422)
      expect((await detail(row.id)).milestones).toEqual([])

      const imported = await ok(owner, 'POST', `/first-mile/${row.id}/milestones/import`, { version: 1, fileName: 'forwarder.csv', content: good })
      expect(imported).toMatchObject({ imported: 2, skippedDuplicates: 0, sourceFileName: 'forwarder.csv', version: 2 })
      const again = await ok(owner, 'POST', `/first-mile/${row.id}/milestones/import`, { version: 2, fileName: 'forwarder.csv', content: good })
      expect(again).toMatchObject({ imported: 0, skippedDuplicates: 2 })
      const view = await detail(row.id)
      expect(view.milestones.map((m: { milestone: string; source: string }) => `${m.milestone}:${m.source}`)).toEqual(['DEPARTED:FILE_IMPORT', 'ARRIVED_PORT:FILE_IMPORT'])
      expect((await call(owner, 'DELETE', `/first-mile/${row.id}/milestones/${view.milestones[0].id}?version=${again.version}`)).status).toBe(409)
    })
  })

  describe('费用与分摊', () => {
    let shipmentId: string
    const costBody = (version: number, item: string, amount: number) => ({ version, item, amount, incurredAt: dayText(-1) })

    it('费用金额必须大于 0；分摊口径缺数据时说明缺什么；没有费用不能分摊', async () => {
      const row = await create({
        items: [
          { sku: 'ALC-A', quantity: 10, volumeCbm: 1, goodsValue: 100 },
          { sku: 'ALC-B', quantity: 20, volumeCbm: 3 },
        ],
      })
      shipmentId = row.id
      expect((await call(owner, 'POST', `/first-mile/${shipmentId}/costs`, costBody(1, 'FREIGHT', 0))).status).toBe(422)
      expect((await call(owner, 'POST', `/first-mile/${shipmentId}/allocate`, { version: 1, method: 'VOLUME' })).status).toBe(409)
      const first = await ok(owner, 'POST', `/first-mile/${shipmentId}/costs`, costBody(1, 'FREIGHT', 100))
      const second = await ok(owner, 'POST', `/first-mile/${shipmentId}/costs`, costBody(first.version, 'CLEARANCE', 20.05))
      const view = await detail(shipmentId)
      expect(view.shipment.actualCost).toBe('120.05')
      expect(view.costs).toHaveLength(2)
      expect(view.actions).toEqual(expect.arrayContaining(['ADD_COST', 'ALLOCATE']))
      expect(view.allocationReady.VOLUME).toBeNull()
      expect(view.allocationReady.WEIGHT).toEqual(expect.any(String))
      expect(view.allocationReady.VALUE).toEqual(expect.any(String))
      expect(view.allocationReady.QTY).toBeNull()
      const refused = await call(owner, 'POST', `/first-mile/${shipmentId}/allocate`, { version: second.version, method: 'WEIGHT' })
      expect(refused.status).toBe(422)
      expect((await ok(owner, 'GET', `/first-mile?q=${view.shipment.waybillNo}`)).items[0].allocated).toBe(false)
    })

    it('按体积分摊：金额合计等于费用合计，生成成本版本草稿；分摊后费用、明细与币种锁定', async () => {
      const before = await detail(shipmentId)
      const allocated = await ok(owner, 'POST', `/first-mile/${shipmentId}/allocate`, { version: before.shipment.version, method: 'VOLUME' })
      expect(allocated.message).toContain('按体积')
      const view = await detail(shipmentId)
      const lines = view.allocation.lines as Array<{ sku: string; allocatedAmount: string; unitCost: string; costVersionStatus: string }>
      expect(lines.map(line => line.sku)).toEqual(['ALC-A', 'ALC-B'])
      expect(lines.reduce((sum, line) => sum + Number(line.allocatedAmount), 0)).toBeCloseTo(120.05, 6)
      expect(Number(lines[1].allocatedAmount)).toBeGreaterThan(Number(lines[0].allocatedAmount) * 2.9)
      expect(lines.every(line => line.costVersionStatus === 'DRAFT')).toBe(true)
      expect(view.actions).toContain('UNALLOCATE')
      expect(view.actions).not.toContain('ADD_COST')
      const drafts = (
        await h.client.query(`SELECT sku, source, status, "unitFirstMileCost" IS NOT NULL AS has_cost FROM "CostVersion" WHERE "tenantId" = $1 AND sku LIKE 'ALC-%' ORDER BY sku`, [tenantId])
      ).rows
      expect(drafts).toEqual([
        { sku: 'ALC-A', source: 'FIRST_MILE_ALLOCATION', status: 'DRAFT', has_cost: true },
        { sku: 'ALC-B', source: 'FIRST_MILE_ALLOCATION', status: 'DRAFT', has_cost: true },
      ])
      const v = view.shipment.version as number
      expect((await call(owner, 'POST', `/first-mile/${shipmentId}/costs`, costBody(v, 'DUTY', 5))).status).toBe(409)
      expect((await call(owner, 'POST', `/first-mile/${shipmentId}/allocate`, { version: v, method: 'QTY' })).status).toBe(409)
      expect((await call(owner, 'PATCH', `/first-mile/${shipmentId}`, { version: v, items: [{ sku: 'ALC-A', quantity: 1 }] })).status).toBe(409)
      expect((await call(owner, 'PATCH', `/first-mile/${shipmentId}`, { version: v, currency: 'EUR' })).status).toBe(422)
      expect((await call(owner, 'DELETE', `/first-mile/${shipmentId}/costs/${view.costs[0].id}?version=${v}`)).status).toBe(409)
    })

    it('撤销分摊：草稿被删除，费用可再修改；已生效的成本版本拒绝撤销', async () => {
      const view = await detail(shipmentId)
      expect((await call(readOnly, 'DELETE', `/first-mile/${shipmentId}/allocation?version=${view.shipment.version}`)).status).toBe(403)
      await h.client.query(`UPDATE "CostVersion" SET status = 'ACTIVE' WHERE "tenantId" = $1 AND sku = 'ALC-A'`, [tenantId])
      expect((await call(owner, 'DELETE', `/first-mile/${shipmentId}/allocation?version=${view.shipment.version}`)).status).toBe(409)
      await h.client.query(`UPDATE "CostVersion" SET status = 'DRAFT' WHERE "tenantId" = $1 AND sku = 'ALC-A'`, [tenantId])
      const reverted = await ok(owner, 'DELETE', `/first-mile/${shipmentId}/allocation?version=${view.shipment.version}`)
      expect(reverted.version).toBe(view.shipment.version + 1)
      expect((await h.client.query(`SELECT count(*)::int AS n FROM "CostVersion" WHERE "tenantId" = $1 AND sku LIKE 'ALC-%'`, [tenantId])).rows[0].n).toBe(0)
      expect((await h.client.query(`SELECT count(*)::int AS n FROM "LandedCostAllocation" WHERE "firstMileShipmentId" = $1`, [shipmentId])).rows[0].n).toBe(0)
      const after = await detail(shipmentId)
      expect(after.allocation).toBeNull()
      const removed = await ok(owner, 'DELETE', `/first-mile/${shipmentId}/costs/${after.costs[0].id}?version=${after.shipment.version}`)
      expect((await detail(shipmentId)).costs).toHaveLength(1)
      const byQty = await ok(owner, 'POST', `/first-mile/${shipmentId}/allocate`, { version: removed.version, method: 'QTY' })
      expect(byQty.message).toContain('按件数')
    })
  })

  describe('出库', () => {
    it('没选国内仓或库存不足整张拒绝；有库存后记出库流水；待出库数在国内仓库存里可见，出库后消失；不能重复出库', async () => {
      const noWarehouse = await create({ items: [{ sku: 'OUT-A', quantity: 5 }] })
      expect((await call(owner, 'POST', `/first-mile/${noWarehouse.id}/outbound`, { version: 1 })).status).toBe(409)

      const row = await create({
        warehouseId,
        items: [
          { sku: 'OUT-A', quantity: 5 },
          { sku: 'OUT-B', quantity: 3 },
        ],
      })
      await insertRow(h.client, 'InventoryMovement', { id: 'mv-out-a', tenantId, warehouseId, sellerSku: 'OUT-A', movementType: 'RECEIPT', quantity: 10, occurredAt: new Date() })
      const short = await call(owner, 'POST', `/first-mile/${row.id}/outbound`, { version: 1 })
      expect(short.status).toBe(422)
      expect(JSON.stringify(short.json)).toContain('OUT-B')
      expect((await h.client.query(`SELECT count(*)::int AS n FROM "InventoryMovement" WHERE "referenceId" = $1`, [row.id])).rows[0].n).toBe(0)
      expect((await detail(row.id)).shipment.outboundAt).toBeNull()

      const pending = await ok(owner, 'GET', '/domestic-warehouse/stock?q=OUT-A')
      expect(pending.items[0]).toMatchObject({ sku: 'OUT-A', onHand: 10, pendingOutbound: 5 })

      await insertRow(h.client, 'InventoryMovement', { id: 'mv-out-b', tenantId, warehouseId, sellerSku: 'OUT-B', movementType: 'RECEIPT', quantity: 3, occurredAt: new Date() })
      expect((await call(readOnly, 'POST', `/first-mile/${row.id}/outbound`, { version: 1 })).status).toBe(403)
      const done = await ok(owner, 'POST', `/first-mile/${row.id}/outbound`, { version: 1 })
      expect(done.version).toBe(2)
      const movements = (await h.client.query(`SELECT "sellerSku", quantity, "movementType" FROM "InventoryMovement" WHERE "referenceId" = $1 ORDER BY "sellerSku"`, [row.id])).rows
      expect(movements).toEqual([
        { sellerSku: 'OUT-A', quantity: -5, movementType: 'FIRST_MILE_OUT' },
        { sellerSku: 'OUT-B', quantity: -3, movementType: 'FIRST_MILE_OUT' },
      ])
      const after = await ok(owner, 'GET', '/domestic-warehouse/stock?q=OUT-A')
      expect(after.items[0]).toMatchObject({ onHand: 5, pendingOutbound: 0 })
      expect((await call(owner, 'POST', `/first-mile/${row.id}/outbound`, { version: 2 })).status).toBe(409)
      expect((await call(owner, 'PATCH', `/first-mile/${row.id}`, { version: 2, items: [{ sku: 'OUT-A', quantity: 1 }] })).status).toBe(409)
      const moves = await ok(owner, 'GET', '/domestic-warehouse/movements?type=FIRST_MILE_OUT')
      expect(moves.items[0]).toMatchObject({ referenceNo: expect.stringMatching(/^WB-/) })
    })
  })

  describe('实际时效与回写补货策略', () => {
    const deliver = (days: number) => create({ shipDate: dayText(-100), ataPort: dayText(-100 + days - 2), ataDelivery: dayText(-100 + days), etaDelivery: dayText(-100 + 22) })

    it('样本不足时只显示不建议回写', async () => {
      await deliver(20)
      await deliver(25)
      const stats = await ok(owner, 'GET', '/first-mile/transit-stats')
      expect(stats.rows).toHaveLength(1)
      expect(stats.rows[0]).toMatchObject({ sampleCount: 2, applyBlocked: expect.stringContaining('样本不足') })
    })

    it('三单以上给出 p50/p90 与月度点；没有企业级策略不能回写', async () => {
      await deliver(30)
      const stats = await ok(owner, 'GET', '/first-mile/transit-stats')
      expect(stats.rows[0]).toMatchObject({ sampleCount: 3, p50Days: 25, p90Days: 30, minDays: 20, maxDays: 30, policyTransitDays: null })
      expect(stats.rows[0].applyBlocked).toContain('补货策略')
      expect(stats.policyVersionNo).toBeNull()
      expect(stats.basis).toContain('发货日到实际交付日')
      const apply = await call(owner, 'POST', '/first-mile/transit-stats/apply', { forwarderId, mode: 'SEA', expectedVersionNo: 1 })
      expect(apply.status).toBe(409)
      const detailRow = (await ok(owner, 'GET', '/first-mile?stage=DELIVERED')).items[0]
      expect((await detail(detailRow.id)).transitHint).toMatchObject({ sampleCount: 3, p90Days: 30 })
    })

    it('回写：要有回写策略的权限；版本对不上 409；成功后生成新策略版本并带上来源说明', async () => {
      await ok(owner, 'PUT', '/replenishment/policies', policyBody)
      const stats = await ok(owner, 'GET', '/first-mile/transit-stats')
      expect(stats.policyVersionNo).toBe(1)
      expect(stats.rows[0]).toMatchObject({ applyBlocked: null, policyTransitDays: 30 })
      expect((await call(noPolicy, 'POST', '/first-mile/transit-stats/apply', { forwarderId, mode: 'SEA', expectedVersionNo: 1 })).status).toBe(403)
      expect((await call(owner, 'POST', '/first-mile/transit-stats/apply', { forwarderId, mode: 'SEA', expectedVersionNo: 7 })).status).toBe(409)
      expect((await call(owner, 'POST', '/first-mile/transit-stats/apply', { forwarderId, mode: 'AIR', expectedVersionNo: 1 })).status).toBe(409)
      const applied = await ok(owner, 'POST', '/first-mile/transit-stats/apply', { forwarderId, mode: 'SEA', expectedVersionNo: 1 })
      expect(applied).toMatchObject({ versionNo: 2, mode: 'SEA', transitDays: 30, previousDays: 30 })
      const policies = (await h.client.query(`SELECT "versionNo", "changeReason" FROM "ReplenishmentPolicy" WHERE "tenantId" = $1 AND level = 'TENANT' ORDER BY "versionNo"`, [tenantId])).rows
      expect(policies).toHaveLength(2)
      expect(policies[1].changeReason).toContain('头程实际时效回写')
      expect((await ok(owner, 'GET', '/first-mile/transit-stats')).policyVersionNo).toBe(2)
      const rows = (await h.client.query(`SELECT "sampleCount", "p90Days" FROM "TransitTimeStat" WHERE "tenantId" = $1`, [tenantId])).rows
      expect(rows.length).toBeGreaterThan(0)
    })
  })

  describe('金额字段权限', () => {
    it('没有 field.cost 看不到预估与实际费用、货值、费用明细、分摊；有权限的能看到', async () => {
      const row = await create({ estimatedCost: 300, items: [{ sku: 'SEC-A', quantity: 4, goodsValue: 40 }] })
      await ok(owner, 'POST', `/first-mile/${row.id}/costs`, { version: 1, item: 'FREIGHT', amount: 10, incurredAt: dayText(-1) })
      const hidden = await detail(row.id, noCost)
      expect(hidden.shipment).not.toHaveProperty('estimatedCost')
      expect(hidden.shipment).not.toHaveProperty('actualCost')
      expect(hidden.items[0]).not.toHaveProperty('goodsValue')
      expect(hidden).not.toHaveProperty('costs')
      expect(hidden).not.toHaveProperty('allocation')
      const listed = (await ok(noCost, 'GET', '/first-mile?q=SEC')).items
      expect(listed.length).toBeGreaterThan(0)
      for (const item of listed) {
        expect(item).not.toHaveProperty('estimatedCost')
        expect(item).not.toHaveProperty('actualCost')
      }
      const shown = await detail(row.id, readOnly)
      expect(shown.shipment).toMatchObject({ estimatedCost: '300', actualCost: '10' })
      expect(shown.costs).toHaveLength(1)
    })
  })

  describe('附件', () => {
    it('申请凭据 → 直传 → 确认 → 下载；类型被拒绝；别的企业访问不到', async () => {
      const row = await create()
      expect((await call(owner, 'POST', `/first-mile/${row.id}/attachments`, { fileName: 'a.exe', contentType: 'application/x-msdownload', sizeBytes: 10 })).status).toBe(422)
      const content = '提单 BL-001'
      const ticket = await ok(owner, 'POST', `/first-mile/${row.id}/attachments`, { fileName: 'bl.txt', contentType: 'text/plain', sizeBytes: content.length })
      const token = (ticket.uploadUrl as string).slice((ticket.uploadUrl as string).lastIndexOf('/') + 1)
      const put = await fetch(`${h.baseUrl}/api/v1/storage/local/${token}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: content })
      expect(put.status).toBe(200)
      const confirmed = await ok(owner, 'POST', `/first-mile/${row.id}/attachments/confirm`, { objectKey: ticket.objectKey, fileName: 'bl.txt', contentType: 'text/plain' })
      expect(confirmed).toMatchObject({ fileName: 'bl.txt' })
      expect((await detail(row.id)).attachments).toHaveLength(1)
      const link = await ok(owner, 'GET', `/first-mile/${row.id}/attachments/${confirmed.id}/download`)
      expect(await (await fetch(`${h.baseUrl}/api/v1/storage/local/${link.url.slice(link.url.lastIndexOf('/') + 1)}`)).text()).toBe(content)
      expect((await call(other, 'GET', `/first-mile/${row.id}/attachments/${confirmed.id}/download`)).status).toBe(404)
      expect((await call(readOnly, 'POST', `/first-mile/${row.id}/attachments`, { fileName: 'a.txt', contentType: 'text/plain', sizeBytes: 1 })).status).toBe(403)
    })
  })

  describe('租户隔离', () => {
    it('别的企业看不到运单、货代、时效统计，也不能改、不能引用', async () => {
      const mine = (await ok(owner, 'GET', '/first-mile')).items[0] as { id: string; version: number }
      expect((await ok(other, 'GET', '/first-mile')).total).toBe(0)
      expect((await ok(other, 'GET', '/freight-forwarders')).total).toBe(0)
      expect((await ok(other, 'GET', '/first-mile/transit-stats')).rows).toEqual([])
      expect((await call(other, 'GET', `/first-mile/${mine.id}`)).status).toBe(404)
      expect((await call(other, 'PATCH', `/first-mile/${mine.id}`, { version: mine.version, note: '越权' })).status).toBe(404)
      expect((await call(other, 'POST', `/first-mile/${mine.id}/costs`, { version: mine.version, item: 'FREIGHT', amount: 1, incurredAt: dayText(-1) })).status).toBe(404)
      expect((await call(other, 'POST', `/first-mile/${mine.id}/outbound`, { version: mine.version })).status).toBe(404)
      expect((await call(other, 'POST', '/first-mile', draft())).status).toBe(422)
      expect((await call(other, 'PATCH', `/freight-forwarders/${forwarderId}`, { version: 1, name: '越权' })).status).toBe(404)
    })
  })

  describe('迁移与回滚', () => {
    let client: Client
    const exists = async (table: string) => (await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])).rows[0].found as boolean
    beforeAll(async () => {
      await db.createDatabase('first_mile_migrate')
      client = await db.connect('first_mile_migrate')
      await applyMigrations(client, { before: TARGET })
    })
    afterAll(async () => {
      await client?.end()
    })

    it('升级建 7 张表且保留既有数据；回滚后新表消失、旧数据仍在；再次升级成功', async () => {
      const ids = await seedTenant(client, 'fmm')
      const warehouse = await insertRow(client, 'Warehouse', { id: 'wh-fmm', tenantId: ids.tenantId, kind: 'DOMESTIC' })
      for (const table of TABLES) expect(await exists(table), `${table} 升级前不应存在`).toBe(false)
      await applyMigrations(client, { only: TARGET })
      for (const table of TABLES) expect(await exists(table), `${table} 应已创建`).toBe(true)
      await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
      for (const table of TABLES) expect(await exists(table), `${table} 回滚后应已删除`).toBe(false)
      expect((await client.query(`SELECT count(*)::int AS n FROM "Warehouse" WHERE id = $1`, [warehouse.id])).rows[0].n).toBe(1)
      await applyMigrations(client, { only: TARGET })
      for (const table of TABLES) expect(await exists(table), `${table} 应再次存在`).toBe(true)
    })
  })
})
