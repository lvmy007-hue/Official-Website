import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// P2a-12 验收（M-P2a-12）：入仓计划新增的 12 张表与计划、货件新增的列：迁移、回滚、唯一键、检查约束、级联删除与行级安全。
// 装箱与贴标责任固定为卖家、阶段与操作取值、数量大于 0 都由数据库保证；这里直接用 SQL 验证，不经过应用层。

const TARGET = '20261024030000_inbound_plan'
const TABLES = [
  'InboundPlanItem',
  'InboundEligibilityCheck',
  'PackingOption',
  'PackingGroup',
  'InboundBox',
  'PlacementOption',
  'TransportOption',
  'DeliveryWindow',
  'ShipmentItem',
  'TrackingEvent',
  'LabelPrintJob',
  'InboundOperation',
] as const

// insertRow 给文本列补的占位值是固定的，同表多行会撞唯一键：这里给每一行补一个唯一编号
let seq = 0
const put = (client: Client, table: string, values: Record<string, unknown>) => insertRow(client, table, { id: `ib-${++seq}`, ...values })

async function exists(client: Client, table: string) {
  const { rows } = await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])
  return rows[0].found as boolean
}
async function hasColumn(client: Client, table: string, column: string) {
  const { rows } = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, column])
  return rows.length > 0
}
const count = async (client: Client, table: string, where = 'true') => (await client.query(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`)).rows[0].n as number

describe('入仓计划表（P2a-12）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  describe('迁移与回滚', () => {
    let client: Client
    beforeAll(async () => {
      await db.createDatabase('inbound_migrate')
      client = await db.connect('inbound_migrate')
      await applyMigrations(client, { before: TARGET })
    })
    afterAll(async () => {
      await client?.end()
    })

    it('升级建 12 张表与新列且不动既有计划；回滚全部删除；再次升级闭环成功', async () => {
      const ids = await seedTenant(client, 'mig')
      await put(client, 'FbaInboundPlan', { id: 'old-plan', tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, status: 'CREATED' })
      for (const table of TABLES) expect(await exists(client, table), `${table} 升级前不应存在`).toBe(false)
      expect(await hasColumn(client, 'FbaInboundPlan', 'stage')).toBe(false)
      await applyMigrations(client, { only: TARGET })
      for (const table of TABLES) expect(await exists(client, table), `${table} 应已创建`).toBe(true)
      expect(await hasColumn(client, 'FbaInboundPlan', 'stage')).toBe(true)
      expect(await hasColumn(client, 'FbaInboundShipment', 'trackingJson')).toBe(true)
      // 旧计划保留：旧状态列不变，新阶段列取默认值，装箱与贴标责任默认卖家
      const old = (await client.query(`SELECT status, stage, "prepOwner", "labelOwner", version FROM "FbaInboundPlan" WHERE id = 'old-plan'`)).rows[0]
      expect(old).toMatchObject({ status: 'CREATED', stage: 'DRAFT', prepOwner: 'SELLER', labelOwner: 'SELLER', version: 1 })
      await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
      for (const table of TABLES) expect(await exists(client, table), `${table} 回滚后应已删除`).toBe(false)
      expect(await hasColumn(client, 'FbaInboundPlan', 'stage')).toBe(false)
      expect(await count(client, 'FbaInboundPlan', `id = 'old-plan'`)).toBe(1)
      await applyMigrations(client, { only: TARGET })
      for (const table of TABLES) expect(await exists(client, table), `${table} 应再次存在`).toBe(true)
    })
  })

  describe('唯一键与检查约束', () => {
    let client: Client
    let ids: Awaited<ReturnType<typeof seedTenant>>
    let other: Awaited<ReturnType<typeof seedTenant>>
    const base = () => ({ tenantId: ids.tenantId, planId: 'plan-1' })
    const plan = (over: Record<string, unknown> = {}) => put(client, 'FbaInboundPlan', { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, ...over })

    beforeAll(async () => {
      await db.createDatabase('inbound_fresh')
      client = await db.connect('inbound_fresh')
      await applyMigrations(client)
      ids = await seedTenant(client, 'ib')
      other = await seedTenant(client, 'ib-other')
      await plan({ id: 'plan-1' })
    })
    afterAll(async () => {
      await client?.end()
    })

    it('计划：阶段、来源只接受约定取值；装箱与贴标责任只能是卖家；版本号从 1 起；自理成本不能为负', async () => {
      await expect(plan({ stage: 'WHATEVER' })).rejects.toMatchObject({ code: '23514' })
      await expect(plan({ sourceType: 'GUESS' })).rejects.toMatchObject({ code: '23514' })
      await expect(plan({ prepOwner: 'AMAZON' })).rejects.toMatchObject({ code: '23514' })
      await expect(plan({ labelOwner: 'AMAZON' })).rejects.toMatchObject({ code: '23514' })
      await expect(plan({ shippingMode: 'AIR' })).rejects.toMatchObject({ code: '23514' })
      await expect(plan({ version: 0 })).rejects.toMatchObject({ code: '23514' })
      await expect(plan({ prepCost: -1 })).rejects.toMatchObject({ code: '23514' })
      const created = await plan({ stage: 'TRANSPORT_CONFIRMED', shippingMode: 'SPD', sourceType: 'REPLENISHMENT' })
      expect(created).toMatchObject({ stage: 'TRANSPORT_CONFIRMED', prepOwner: 'SELLER', labelOwner: 'SELLER', pendingOp: null, prepCost: null })
    })

    it('商品行：同计划同 SKU 只有一行；数量必须大于 0', async () => {
      await put(client, 'InboundPlanItem', { ...base(), sku: 'SKU-1', quantity: 5 })
      await expect(put(client, 'InboundPlanItem', { ...base(), sku: 'SKU-1', quantity: 1 })).rejects.toMatchObject({ code: '23505' })
      await expect(put(client, 'InboundPlanItem', { ...base(), sku: 'SKU-2', quantity: 0 })).rejects.toMatchObject({ code: '23514' })
    })

    it('装箱方案与分仓方案：方案编号按计划唯一；状态受限；费用不能为负，装箱方案的费用可为空（没报的不是 0）', async () => {
      await put(client, 'PackingOption', { ...base(), packingOptionId: 'PO-1', status: 'OFFERED' })
      await expect(put(client, 'PackingOption', { ...base(), packingOptionId: 'PO-1', status: 'OFFERED' })).rejects.toMatchObject({ code: '23505' })
      await expect(put(client, 'PackingOption', { ...base(), packingOptionId: 'PO-2', status: 'CHOSEN' })).rejects.toMatchObject({ code: '23514' })
      await expect(put(client, 'PackingOption', { ...base(), packingOptionId: 'PO-3', status: 'OFFERED', fees: -1 })).rejects.toMatchObject({ code: '23514' })
      expect((await client.query(`SELECT fees FROM "PackingOption" WHERE "packingOptionId" = 'PO-1'`)).rows[0].fees).toBeNull()
      await put(client, 'PlacementOption', { ...base(), placementOptionId: 'PL-1', status: 'OFFERED' })
      await expect(put(client, 'PlacementOption', { ...base(), placementOptionId: 'PL-1', status: 'OFFERED' })).rejects.toMatchObject({ code: '23505' })
      await expect(put(client, 'PlacementOption', { ...base(), placementOptionId: 'PL-2', status: 'OFFERED', fees: -5 })).rejects.toMatchObject({ code: '23514' })
    })

    it('箱子：箱号按计划唯一；数量、重量、尺寸必须大于 0；贴标状态受限', async () => {
      const box = { ...base(), boxId: 'BOX-001', quantity: 1, weightLb: 10, lengthIn: 10, widthIn: 10, heightIn: 10 }
      await put(client, 'InboundBox', box)
      await expect(put(client, 'InboundBox', box)).rejects.toMatchObject({ code: '23505' })
      for (const [index, over] of [{ quantity: 0 }, { weightLb: 0 }, { lengthIn: -1 }, { widthIn: 0 }, { heightIn: 0 }, { labelStatus: 'PRINTED' }].entries())
        await expect(put(client, 'InboundBox', { ...box, boxId: `BOX-${index + 2}`, ...over }), JSON.stringify(over)).rejects.toMatchObject({ code: '23514' })
    })

    it('运输方案、送达时间窗、货件明细、追踪事件、标签任务的唯一键与检查', async () => {
      await put(client, 'TransportOption', { ...base(), shipmentId: 'SH-1', transportOptionId: 'T-1', status: 'OFFERED' })
      await expect(put(client, 'TransportOption', { ...base(), shipmentId: 'SH-1', transportOptionId: 'T-1', status: 'OFFERED' })).rejects.toMatchObject({ code: '23505' })
      await put(client, 'TransportOption', { ...base(), shipmentId: 'SH-2', transportOptionId: 'T-1', status: 'OFFERED' })
      await expect(put(client, 'TransportOption', { ...base(), shipmentId: 'SH-1', transportOptionId: 'T-2', status: 'OFFERED', cost: -1 })).rejects.toMatchObject({ code: '23514' })
      await put(client, 'DeliveryWindow', { ...base(), shipmentId: 'SH-1', windowStart: '2026-11-01T00:00:00Z' })
      await expect(put(client, 'DeliveryWindow', { ...base(), shipmentId: 'SH-1', windowStart: '2026-11-01T00:00:00Z' })).rejects.toMatchObject({ code: '23505' })
      await put(client, 'ShipmentItem', { ...base(), shipmentId: 'SH-1', sku: 'SKU-1', shippedQty: 5 })
      await expect(put(client, 'ShipmentItem', { ...base(), shipmentId: 'SH-1', sku: 'SKU-1', shippedQty: 5 })).rejects.toMatchObject({ code: '23505' })
      await expect(put(client, 'ShipmentItem', { ...base(), shipmentId: 'SH-1', sku: 'SKU-2', shippedQty: -1 })).rejects.toMatchObject({ code: '23514' })
      await expect(put(client, 'ShipmentItem', { ...base(), shipmentId: 'SH-1', sku: 'SKU-3', shippedQty: 1, receivedQty: -1 })).rejects.toMatchObject({ code: '23514' })
      expect((await put(client, 'ShipmentItem', { ...base(), shipmentId: 'SH-1', sku: 'SKU-4', shippedQty: 1 })).receivedQty).toBeNull()
      const event = { ...base(), trackingNumber: '1Z1', milestone: 'DELIVERED', occurredAt: '2026-11-02T00:00:00Z', source: 'MANUAL' }
      await put(client, 'TrackingEvent', event)
      await expect(put(client, 'TrackingEvent', event)).rejects.toMatchObject({ code: '23505' })
      await expect(put(client, 'TrackingEvent', { ...event, milestone: 'X', source: 'GUESS' })).rejects.toMatchObject({ code: '23514' })
      await put(client, 'LabelPrintJob', { ...base(), shipmentId: 'SH-1', kind: 'BOX', status: 'QUEUED' })
      await expect(put(client, 'LabelPrintJob', { ...base(), shipmentId: 'SH-1', kind: 'PALLET', status: 'QUEUED' })).rejects.toMatchObject({ code: '23514' })
      await expect(put(client, 'LabelPrintJob', { ...base(), shipmentId: 'SH-1', kind: 'BOX', status: 'DONE' })).rejects.toMatchObject({ code: '23514' })
    })

    it('异步操作：状态与操作名称受限；亚马逊操作编号按店铺唯一，没有编号的操作可以有多条', async () => {
      const op = { ...base(), sellerAccountId: ids.sellerAccountId, operation: 'CREATE_PLAN', status: 'QUEUED' }
      await put(client, 'InboundOperation', op)
      await put(client, 'InboundOperation', op)
      await put(client, 'InboundOperation', { ...op, operationId: 'OP-1', status: 'IN_PROGRESS' })
      await expect(put(client, 'InboundOperation', { ...op, operationId: 'OP-1', status: 'IN_PROGRESS' })).rejects.toMatchObject({ code: '23505' })
      await expect(put(client, 'InboundOperation', { ...op, status: 'DONE' })).rejects.toMatchObject({ code: '23514' })
      await expect(put(client, 'InboundOperation', { ...op, operation: 'EXPLODE' })).rejects.toMatchObject({ code: '23514' })
      for (const operation of ['ELIGIBILITY', 'GENERATE_PACKING', 'CONFIRM_TRANSPORT', 'CANCEL_PLAN', 'LABELS']) await put(client, 'InboundOperation', { ...op, operation })
    })

    it('不同企业可以有相同的方案编号、箱号与操作编号（唯一键按计划与店铺）', async () => {
      await put(client, 'FbaInboundPlan', { id: 'plan-other', tenantId: other.tenantId, sellerAccountId: other.sellerAccountId })
      const otherBase = { tenantId: other.tenantId, planId: 'plan-other' }
      await put(client, 'PackingOption', { ...otherBase, packingOptionId: 'PO-1', status: 'OFFERED' })
      await put(client, 'InboundBox', { ...otherBase, boxId: 'BOX-001', quantity: 1, weightLb: 1, lengthIn: 1, widthIn: 1, heightIn: 1 })
      await put(client, 'InboundOperation', { ...otherBase, sellerAccountId: other.sellerAccountId, operation: 'CREATE_PLAN', status: 'IN_PROGRESS', operationId: 'OP-1' })
    })

    it('删除计划时，下属各表的行一并删除', async () => {
      await plan({ id: 'plan-del' })
      const child = { tenantId: ids.tenantId, planId: 'plan-del' }
      await put(client, 'InboundPlanItem', { ...child, sku: 'S', quantity: 1 })
      await put(client, 'InboundBox', { ...child, boxId: 'B1', quantity: 1, weightLb: 1, lengthIn: 1, widthIn: 1, heightIn: 1 })
      await put(client, 'InboundOperation', { ...child, sellerAccountId: ids.sellerAccountId, operation: 'ELIGIBILITY', status: 'SUCCESS' })
      await client.query(`DELETE FROM "FbaInboundPlan" WHERE id = 'plan-del'`)
      for (const table of ['InboundPlanItem', 'InboundBox', 'InboundOperation']) expect(await count(client, table, `"planId" = 'plan-del'`), table).toBe(0)
    })

    it('行级安全：12 张表都启用，租户连接账号只能看到并写入自己企业的行', async () => {
      const policies = await client.query(`SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1) AND qual LIKE '%nova_current_tenant%'`, [[...TABLES]])
      expect(policies.rows.map(row => row.tablename).sort()).toEqual([...TABLES].sort())
      const app = new Client({ connectionString: db.urlFor('inbound_fresh', 'app') })
      await app.connect()
      try {
        await app.query('BEGIN')
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [other.tenantId])
        expect(await count(app, 'InboundBox')).toBe(1)
        expect(await count(app, 'InboundBox', `"tenantId" = '${ids.tenantId}'`)).toBe(0)
        await expect(app.query(`INSERT INTO "InboundPlanItem" (id, "tenantId", "planId", sku, quantity, "updatedAt") VALUES ('x', $1, 'plan-1', 'S', 1, now())`, [ids.tenantId])).rejects.toMatchObject(
          { code: '42501' },
        )
        await app.query('ROLLBACK')
        // 没有设置企业变量时什么都看不到
        await app.query('BEGIN')
        expect(await count(app, 'InboundOperation')).toBe(0)
        await app.query('ROLLBACK')
      } finally {
        await app.end()
      }
    })
  })
})
