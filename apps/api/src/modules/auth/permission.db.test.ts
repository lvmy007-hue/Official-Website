import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { BASE_PERMISSIONS, FIELD_PERMISSIONS, LEGACY_PERMISSION_MAP, PRESET_ROLES } from '@nova/authz'
import { createDbTestApp, type DbTestApp } from '../../testing/db-harness'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from '../../testing/db-fixtures'
import { startTestDatabase, type TestDatabase } from '../../testing/test-database'

const TARGET = '20261021050000_permission_upgrade'
const ADDED_TO_PRESETS = [
  '20261209020000_grid_view_share_permission',
  '20261211020000_ship_from_permission',
  '20261213020000_skualias_permission',
  '20261214020000_labeltemplate_permission',
  '20261219020000_tools_permission',
  '20261220020000_profit_item_permission',
  '20261222020000_estimated_fee_permission',
  '20261223010000_business_rules_permission',
  '20261227020000_custom_report_permission',
  '20261228020000_dashboard_permission',
]

// P1-13 权限升级（真实数据库）：迁移展开旧权限、预设角色与代码一致且受保护、字段权限在接口响应中生效。
describe('权限升级（真实数据库）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  describe('迁移 M-P1-13', () => {
    let client: Client
    let tenantId: string

    beforeAll(async () => {
      await db.createDatabase('perm_migration')
      client = await db.connect('perm_migration')
      await applyMigrations(client, { before: TARGET })
      tenantId = (await seedTenant(client, 'p')).tenantId
      const roles: [string, string[]][] = [
        ['legacy-seller', ['seller.read', 'seller.write']],
        ['legacy-finance', ['finance.read', 'ads.read']],
        ['legacy-owner', ['*']],
        ['legacy-everything', Object.keys(LEGACY_PERMISSION_MAP)],
        ['custom-new', ['orders.read', 'costs.read']],
      ]
      for (const [id, permissions] of roles) {
        await insertRow(client, 'Role', { id, tenantId, name: id, permissions: JSON.stringify(permissions), resourceScope: '{}' })
      }
      await applyMigrations(client, { only: TARGET })
      // 预设角色此后新增的权限点（P6-03 grid.view.share、P6-08 shipfrom.manage、P6-11 skualias.manage、P6-12 labeltemplate.manage、P6-17 tools.read 与 tools.manage、P6-18 finance.profititem.manage、P6-20 finance.estimatedfee.write、
      // P6-31 settings.business.write、P6-32 reports.custom.write 与 reports.custom.share、
      // P6-33 dashboard.write 与 dashboard.share）由独立迁移追加；这里补上，才能与代码里的预设逐项核对
      for (const name of ADDED_TO_PRESETS) await applyMigrations(client, { only: name })
    })
    afterAll(async () => {
      await client?.end()
    })

    const permissionsOf = async (id: string) => {
      const { rows } = await client.query('SELECT "permissions", "version" FROM "Role" WHERE id = $1', [id])
      return { permissions: rows[0].permissions as string[], version: rows[0].version as number }
    }

    it('已有角色的旧权限按冻结映射展开：旧点位保留，字段权限不写进权限数组', async () => {
      const { permissions, version } = await permissionsOf('legacy-seller')
      expect(permissions).toEqual(
        expect.arrayContaining([
          'seller.read',
          'seller.write',
          'products.read',
          'inventory.read',
          'inbound.read',
          'purchase.read',
          'supplier.read',
          'warehouse.read',
          'reports.read',
          'connection.read',
          'sync.read',
          'inbound.plan.write',
          'purchase.order.write',
          'reports.create',
        ]),
      )
      expect(permissions.filter(key => key.startsWith('field.'))).toEqual([])
      expect(version).toBe(2)
    })

    it('数据库里的展开结果与代码里的映射完全一致（逐个旧点位核对）', async () => {
      const { permissions } = await permissionsOf('legacy-everything')
      const expected = new Set<string>()
      for (const [old, targets] of Object.entries(LEGACY_PERMISSION_MAP)) {
        expected.add(old)
        for (const target of targets) if (!target.startsWith('field.')) expected.add(target)
      }
      expect([...permissions].sort()).toEqual([...expected].sort())
    })

    it('仅 finance.read 映射出利润字段权限；成本与买家信息不放开', async () => {
      const { rows } = await client.query(`SELECT "roleId", "fieldKey", "allowed" FROM "FieldPermission" WHERE "roleId" LIKE 'legacy-%' OR "roleId" = 'custom-new' ORDER BY 1, 2`)
      expect(rows).toEqual([
        { roleId: 'legacy-everything', fieldKey: 'profit', allowed: true },
        { roleId: 'legacy-finance', fieldKey: 'profit', allowed: true },
      ])
    })

    it('通配角色与已是新点位的角色不被改动', async () => {
      expect(await permissionsOf('legacy-owner')).toEqual({ permissions: ['*'], version: 1 })
      expect((await permissionsOf('custom-new')).permissions).toEqual(['costs.read', 'orders.read', 'returns.read'])
    })

    it('7 个预设角色在数据库里与 @nova/authz 的定义一致（权限点与字段权限）', async () => {
      const { rows } = await client.query(`SELECT "id", "name", "permissions", "system", "tenantId" FROM "Role" WHERE "id" LIKE 'preset-%' ORDER BY "id"`)
      expect(rows).toHaveLength(7)
      const fields = await client.query(`SELECT "roleId", "fieldKey" FROM "FieldPermission" WHERE "roleId" LIKE 'preset-%' AND "allowed"`)
      for (const role of PRESET_ROLES) {
        const row = rows.find(item => item.id === role.id)!
        expect(row, role.id).toBeDefined()
        expect(row.name).toBe(role.name)
        expect(row.system).toBe(true)
        expect(row.tenantId).toBeNull()
        expect([...row.permissions].sort()).toEqual([...role.permissions].sort())
        expect(
          fields.rows
            .filter(item => item.roleId === role.id)
            .map(item => item.fieldKey)
            .sort(),
        ).toEqual([...role.fields].sort())
      }
    })

    it('预设角色不可修改、不可删除，字段权限同样不可变；复制出来的租户角色可以自由修改', async () => {
      await expect(client.query(`UPDATE "Role" SET "name" = '被改名' WHERE id = 'preset-admin'`)).rejects.toThrow(/预设角色不可修改或删除/)
      await expect(client.query(`UPDATE "Role" SET "permissions" = '[]'::jsonb WHERE id = 'preset-readonly'`)).rejects.toThrow(/预设角色不可修改或删除/)
      await expect(client.query(`DELETE FROM "Role" WHERE id = 'preset-owner'`)).rejects.toThrow(/预设角色不可修改或删除/)
      await expect(client.query(`UPDATE "FieldPermission" SET "allowed" = false WHERE "roleId" = 'preset-ops'`)).rejects.toThrow(/预设角色的字段权限不可修改或删除/)
      await expect(client.query(`DELETE FROM "FieldPermission" WHERE "roleId" = 'preset-admin'`)).rejects.toThrow(/预设角色的字段权限不可修改或删除/)
      await insertRow(client, 'Role', { id: 'copy-of-ops', tenantId, name: '运营副本', permissions: '[]', resourceScope: '{}' })
      await client.query(`UPDATE "Role" SET "name" = '运营副本二' WHERE id = 'copy-of-ops'`)
      await client.query(`DELETE FROM "Role" WHERE id = 'copy-of-ops'`)
    })

    it('字段权限的取值受检查约束；同一企业同一邮箱只允许一个待接受的邀请', async () => {
      await expect(insertRow(client, 'FieldPermission', { id: 'bad', roleId: 'custom-new', fieldKey: 'salary', allowed: true })).rejects.toThrow(/FieldPermission_fieldKey_check/)
      const base = { tenantId, email: 'new@example.com', roleId: 'preset-readonly', scopeSnapshot: '{}', invitedBy: 'u', expiresAt: '2030-01-01T00:00:00Z' }
      await insertRow(client, 'MemberInvitation', { ...base, id: 'inv-1', tokenHash: 'h1' })
      await expect(insertRow(client, 'MemberInvitation', { ...base, id: 'inv-2', tokenHash: 'h2' })).rejects.toThrow(/MemberInvitation_pending_email_key/)
      await client.query(`UPDATE "MemberInvitation" SET "status" = 'REVOKED' WHERE id = 'inv-1'`)
      await insertRow(client, 'MemberInvitation', { ...base, id: 'inv-3', tokenHash: 'h3' })
      await expect(client.query(`UPDATE "MemberInvitation" SET "status" = 'WHATEVER' WHERE id = 'inv-3'`)).rejects.toThrow(/MemberInvitation_status_check/)
    })

    it('回滚脚本可执行：新表、预设角色与触发器被移除，自建角色保留', async () => {
      await client.query(`DELETE FROM "MemberInvitation"`)
      await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
      expect((await client.query(`SELECT to_regclass('"FieldPermission"') AS t`)).rows[0].t).toBeNull()
      expect((await client.query(`SELECT to_regclass('"MemberInvitation"') AS t`)).rows[0].t).toBeNull()
      expect((await client.query(`SELECT count(*)::int AS n FROM "Role" WHERE id LIKE 'preset-%'`)).rows[0].n).toBe(0)
      expect((await client.query(`SELECT count(*)::int AS n FROM "Role" WHERE id LIKE 'legacy-%'`)).rows[0].n).toBe(4)
      expect((await client.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE '%protect_preset'`)).rows[0].n).toBe(0)
    })
  })

  describe('接口：字段权限在响应中生效', () => {
    let h: DbTestApp
    let tenant: Awaited<ReturnType<typeof seedTenant>>
    const tokens: Record<string, string> = {}

    beforeAll(async () => {
      h = await createDbTestApp({ db, database: 'perm_api' })
      tenant = await h.createTenant('a')
      const supplier = await insertRow(h.client, 'Supplier', { id: 'sup-1', tenantId: tenant.tenantId, name: '供应商甲', currency: 'USD' })
      const po = await insertRow(h.client, 'PurchaseOrder', { id: 'po-1', tenantId: tenant.tenantId, supplierId: supplier.id, number: 'PO-1', totalAmount: 400, currency: 'USD' })
      await insertRow(h.client, 'PurchaseOrderLine', { id: 'pol-1', purchaseOrderId: po.id, sellerSku: 'A', quantity: 10, unitCost: 40, currency: 'USD' })
      for (const [key, roleId] of [
        ['finance', 'preset-finance'],
        ['ops', 'preset-ops'],
        ['readonly', 'preset-readonly'],
        ['supply', 'preset-supply'],
        ['owner', 'preset-owner'],
      ]) {
        tokens[key] = (await h.createMember(tenant.tenantId, key, [], { roleId })).token
      }
    })
    afterAll(async () => {
      await h?.close()
    })

    const purchaseOrder = async (key: string) => (await h.call(tokens[key], 'GET', '/procurement/purchase-orders')).json.data[0]

    it('预设角色的字段可见性与清单一致（成本：财务、供应链、所有者可见；运营、只读不可见）', async () => {
      for (const key of ['finance', 'supply', 'owner']) {
        const order = await purchaseOrder(key)
        expect(Number(order.totalAmount), key).toBe(400)
        expect(Number(order.lines[0].unitCost), key).toBe(40)
      }
      for (const key of ['ops', 'readonly']) {
        const res = await h.call(tokens[key], 'GET', '/procurement/purchase-orders')
        // 运营没有采购读取权限（403），只读有采购读取权限但没有成本字段
        if (key === 'ops') {
          expect(res.status).toBe(403)
        } else {
          expect(res.status).toBe(200)
          expect(res.json.data[0]).not.toHaveProperty('totalAmount')
          expect(res.json.data[0].lines[0]).not.toHaveProperty('unitCost')
        }
      }
    })

    it('利润页：运营可见利润不可见成本；只读有利润读取权限之外没有该接口权限；财务两者都可见', async () => {
      const costState = (data: { bridge: { items: Array<{ key: string; state: string }> } }) => data.bridge.items.find(item => item.key === 'PRODUCT_COST')?.state
      const ops = (await h.call(tokens.ops, 'GET', '/profit/overview')).json.data
      expect(ops.summary).toHaveProperty('netProfit')
      expect(ops.summary).not.toHaveProperty('costCoverage')
      expect(costState(ops)).toBe('RESTRICTED')
      // 成本覆盖页全部是成本数据，没有 field.cost 不给
      expect((await h.call(tokens.ops, 'GET', '/profit/cost-coverage')).status).toBe(403)
      expect((await h.call(tokens.readonly, 'GET', '/profit/overview')).status).toBe(403)
      const finance = (await h.call(tokens.finance, 'GET', '/profit/overview')).json.data
      expect(finance.summary).toHaveProperty('netProfit')
      expect(finance.summary).toHaveProperty('costCoverage')
      expect(costState(finance)).not.toBe('RESTRICTED')
      expect((await h.call(tokens.finance, 'GET', '/profit/cost-coverage')).status).toBe(200)
    })

    it('/auth/me 返回有效权限：预设角色的字段权限与基础权限都在内，所有者为通配', async () => {
      const finance = (await h.call(tokens.finance, 'GET', '/auth/me')).json.data.permissions as string[]
      expect(finance).toEqual(expect.arrayContaining(['field.cost', 'field.profit', ...BASE_PERMISSIONS]))
      expect(finance).not.toContain('field.buyer')
      const owner = (await h.call(tokens.owner, 'GET', '/auth/me')).json.data.permissions as string[]
      expect(owner).toContain('*')
      const readonly = (await h.call(tokens.readonly, 'GET', '/auth/me')).json.data.permissions as string[]
      for (const key of FIELD_PERMISSIONS) expect(readonly).not.toContain(key)
    })
  })
})
