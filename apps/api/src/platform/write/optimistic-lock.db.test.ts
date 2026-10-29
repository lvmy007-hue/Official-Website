import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { runWithTenant } from '@nova/tenancy'
import { AppError } from '../http'
import { PrismaService } from '../prisma.service'
import { createDbTestApp, type DbTestApp } from '../../testing/db-harness'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from '../../testing/db-fixtures'
import { startTestDatabase, type TestDatabase } from '../../testing/test-database'
import { updateWithVersion } from './optimistic-lock'

const TARGET = '20261021070000_optimistic_lock'

// P1-15 乐观锁（真实数据库）：迁移保数据与回滚、并发编辑只有一个成功、冲突与不存在可区分、企业之间互不可见。
describe('乐观锁（真实数据库）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  describe('迁移 M-P1-15：保数据与回滚', () => {
    let client: Client
    beforeAll(async () => {
      await db.createDatabase('lock_migration')
      client = await db.connect('lock_migration')
      await applyMigrations(client, { before: TARGET })
      const { tenantId } = await seedTenant(client, 'm')
      await insertRow(client, 'Supplier', { id: 'sup-1', tenantId, code: 'S1', name: '供应商' })
      await insertRow(client, 'PurchaseOrder', { id: 'po-old', tenantId, supplierId: 'sup-1', number: 'PO-OLD', notes: '旧采购单' })
      await applyMigrations(client, { only: TARGET })
    })
    afterAll(async () => {
      await client?.end()
    })

    it('已有采购单保留原内容，版本号从 1 开始；新采购单默认也是 1', async () => {
      const { rows } = await client.query(`SELECT "number", "notes", "version" FROM "PurchaseOrder" WHERE id = 'po-old'`)
      expect(rows).toEqual([{ number: 'PO-OLD', notes: '旧采购单', version: 1 }])
      const tenantId = (await client.query(`SELECT "tenantId" FROM "PurchaseOrder" WHERE id = 'po-old'`)).rows[0].tenantId
      await insertRow(client, 'PurchaseOrder', { id: 'po-new', tenantId, supplierId: 'sup-1', number: 'PO-NEW' })
      expect((await client.query(`SELECT "version" FROM "PurchaseOrder" WHERE id = 'po-new'`)).rows[0].version).toBe(1)
    })

    it('回滚后版本列移除、采购单保留；可再次升级', async () => {
      await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
      const columns = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'PurchaseOrder' AND column_name = 'version'`)).rows
      expect(columns).toEqual([])
      expect((await client.query(`SELECT count(*)::int AS n FROM "PurchaseOrder"`)).rows[0].n).toBe(2)
      await applyMigrations(client, { only: TARGET })
      expect((await client.query(`SELECT "version" FROM "PurchaseOrder" WHERE id = 'po-old'`)).rows[0].version).toBe(1)
    })
  })

  describe('并发编辑', () => {
    let h: DbTestApp
    let prisma: PrismaService
    let tenantA: Awaited<ReturnType<typeof seedTenant>>
    let tenantB: Awaited<ReturnType<typeof seedTenant>>

    const newOrder = async (tenantId: string, id: string) => {
      await insertRow(h.client, 'Supplier', { id: `sup-${id}`, tenantId, code: `C-${id}`, name: '供应商' })
      await insertRow(h.client, 'PurchaseOrder', { id, tenantId, supplierId: `sup-${id}`, number: `PO-${id}` })
    }
    // 直接调用（没有请求上下文）时，显式在该租户中运行，与请求内的行为一致
    const edit = (id: string, tenantId: string, version: number, notes: string) =>
      runWithTenant(tenantId, () => updateWithVersion(prisma.purchaseOrder, { id, tenantId }, version, { notes }, { label: '采购单' }))
    const codeOf = async (promise: Promise<unknown>) => {
      try {
        await promise
        return 'OK'
      } catch (error) {
        return error instanceof AppError ? error.code : 'OTHER'
      }
    }

    beforeAll(async () => {
      h = await createDbTestApp({ db, database: 'lock_api' })
      prisma = h.app.get(PrismaService)
      tenantA = await h.createTenant('a')
      tenantB = await h.createTenant('b')
    })
    afterAll(async () => {
      await h?.close()
    })

    it('多人同时基于同一个版本保存：只有一个成功，其余收到冲突；版本只加一次，内容是成功者的', async () => {
      await newOrder(tenantA.tenantId, 'po-race')
      const outcomes = await Promise.all(Array.from({ length: 10 }, (_, index) => codeOf(edit('po-race', tenantA.tenantId, 1, `编辑人${index}`))))
      expect(outcomes.filter(code => code === 'OK')).toHaveLength(1)
      expect(outcomes.filter(code => code === 'CONFLICT')).toHaveLength(9)
      const row = (await h.client.query(`SELECT "version", "notes" FROM "PurchaseOrder" WHERE id = 'po-race'`)).rows[0]
      expect(row.version).toBe(2)
      expect(row.notes).toMatch(/^编辑人\d$/)
    })

    it('冲突后拿最新版本重新保存可以成功，版本逐次加一', async () => {
      await newOrder(tenantA.tenantId, 'po-chain')
      const first = await edit('po-chain', tenantA.tenantId, 1, '第一次')
      expect(first.version).toBe(2)
      await expect(edit('po-chain', tenantA.tenantId, 1, '过期的保存')).rejects.toMatchObject({ code: 'CONFLICT', details: { currentVersion: 2, expectedVersion: 1 } })
      const second = await edit('po-chain', tenantA.tenantId, 2, '第二次')
      expect(second).toMatchObject({ version: 3, notes: '第二次' })
    })

    it('按其他企业的编号保存：返回不存在（不是冲突），数据不变', async () => {
      await newOrder(tenantA.tenantId, 'po-isolated')
      await expect(edit('po-isolated', tenantB.tenantId, 1, '越权修改')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' })
      const row = (await h.client.query(`SELECT "version", "notes" FROM "PurchaseOrder" WHERE id = 'po-isolated'`)).rows[0]
      expect(row).toMatchObject({ version: 1, notes: null })
    })

    it('采购单列表接口返回版本号，前端据此保存', async () => {
      const viewer = await h.createMember(tenantA.tenantId, 'viewer', ['purchase.read', 'finance.read'])
      const res = await h.call(viewer.token, 'GET', '/procurement/purchase-orders')
      expect(res.status).toBe(200)
      const chain = res.json.data.find((item: { id: string }) => item.id === 'po-chain')
      expect(chain.version).toBe(3)
    })

    it('需要乐观锁的现有对象都带版本列（采购单、角色）', async () => {
      const { rows } = await h.client.query(`SELECT table_name FROM information_schema.columns WHERE column_name = 'version' AND table_name IN ('PurchaseOrder', 'Role') ORDER BY table_name`)
      expect(rows.map(row => row.table_name)).toEqual(['PurchaseOrder', 'Role'])
    })
  })
})
