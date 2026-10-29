import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 供应商装箱单匹配、外部货号映射与列映射（P6-11，真实数据库 + 完整应用）：
//   - 映射：权限、重名 409（含通用映射）、SKU 必须在商品目录、乐观锁、导入整份校验与导出再导入、企业隔离、数据库兜底、迁移回滚；
//   - 列映射：首次保存与带版本更新、冲突 409、供应商跨企业；
//   - 装箱单：预览→选择→应用，记住后下次自动匹配、未解决不能应用且不改任何数据、版本冲突整体回滚（映射也不写）、状态与权限与范围与企业隔离、XLSX。

const TARGET = '20261213010000_sku_alias'
const ALL = ['inbound.read', 'inbound.plan.write', 'skualias.manage']
const ADDRESS = JSON.stringify({ name: '深圳仓', addressLine1: '1 Road', city: 'Shenzhen', stateOrProvinceCode: 'GD', countryCode: 'CN', postalCode: '518000', phoneNumber: '1234567' })

type Member = { userId: string; token: string }

const PACKING = ['箱号,货号,品名,每箱数量,箱数,长(cm),宽(cm),高(cm),毛重(kg)', '1-2,SKU-A,蓝牙耳机 黑色,10,,40,30,20,10', '3,AB-1001,手机壳 蓝色,20,1,40,30,20,12.5', '合计,,,,3,,,,'].join('\n')

function xlsxBase64(rows: string[][]): string {
  const cell = (text: string, col: number, row: number) => `<c r="${String.fromCharCode(65 + col)}${row}" t="inlineStr"><is><t>${text}</t></is></c>`
  const sheet = `<worksheet><sheetData>${rows.map((cells, r) => `<row r="${r + 1}">${cells.map((text, c) => cell(text, c, r + 1)).join('')}</row>`).join('')}</sheetData></worksheet>`
  const files = {
    'xl/workbook.xml': '<workbook xmlns:r="x"><sheets><sheet name="装箱单" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
  }
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])))).toString('base64')
}

describe('装箱单匹配与外部货号映射（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let storeA: string
  let storeB: string
  let otherTenantId: string
  let supplier1: string
  let supplier2: string
  let supplier3: string // 装箱单测试专用：始终没有映射
  let supplier4: string // 装箱单“记住”专用
  let otherSupplier: string
  let mgr: Member
  let writer: Member // 能写入仓计划，没有映射维护权限
  let reader: Member
  let scoped: Member // 只能看店铺 A
  let other: Member
  let planSeq = 0

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const get = async (member: Member, path: string) => h.call(member.token, 'GET', path)
  const aliases = async (member: Member, query = '') => (await get(member, `/sku-aliases${query}`)).json.data
  const addAlias = (member: Member, body: Record<string, unknown>) => h.call(member.token, 'POST', '/sku-aliases', { body })
  const newPlan = async (over: Record<string, unknown> = {}) => {
    const id = `pl-plan-${++planSeq}`
    await insertRow(h.client, 'FbaInboundPlan', {
      id,
      tenantId,
      sellerAccountId: storeA,
      name: `计划 ${planSeq}`,
      sourceAddress: ADDRESS,
      stage: 'PACKING_CONFIRMED',
      externalPlanId: `IP-PL-${planSeq}`,
      ...over,
    })
    for (const [sku, fnsku, asin, productName] of [
      ['SKU-A', 'X0AAAAAAAA', 'B0AAAAAAAA', '蓝牙耳机 黑色'],
      ['SKU-B', null, null, '手机壳 红色'],
      ['SKU-C', null, null, '手机壳 蓝色'],
    ]) {
      await insertRow(h.client, 'InboundPlanItem', { id: `${id}-${sku}`, tenantId, planId: id, sku, fnsku, asin, productName, quantity: 50 })
    }
    return id
  }
  const version = async (id: string) => (await rows<{ version: number }>(`SELECT version FROM "FbaInboundPlan" WHERE id = $1`, [id]))[0]!.version
  const boxRows = (id: string) =>
    rows<{ boxId: string; quantity: number; contentJson: Array<{ sku: string; quantity: number }> }>(`SELECT "boxId", quantity, "contentJson" FROM "InboundBox" WHERE "planId" = $1 ORDER BY "boxId"`, [
      id,
    ])
  const file = (content = PACKING, over: Record<string, unknown> = {}) => ({ fileName: '装箱单.csv', format: 'CSV', content, supplierId: supplier3, ...over })
  const parse = (member: Member | null, id: string, body: Record<string, unknown>) => h.call(member?.token ?? null, 'POST', `/inbound/plans/${id}/packing-list/parse`, { body })
  const apply = (member: Member | null, id: string, body: Record<string, unknown>) => h.call(member?.token ?? null, 'POST', `/inbound/plans/${id}/packing-list/apply`, { body })
  const aliasCount = async () => (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "SkuAlias" WHERE "tenantId" = $1`, [tenantId]))[0]!.n

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'packing_list' })
    const a = await h.createTenant('pl-a')
    tenantId = a.tenantId
    storeA = a.sellerAccountId
    storeB = (await insertRow(h.client, 'SellerAccount', { id: 'seller-pl-b2', tenantId, legalEntityId: a.legalEntityId, displayName: '店铺乙', sellerId: 'SELLER-PL-B2' })).id as string
    const b = await h.createTenant('pl-b')
    otherTenantId = b.tenantId
    for (const sku of ['SKU-A', 'SKU-B', 'SKU-C', 'SKU-OUT']) {
      await insertRow(h.client, 'FbaProduct', {
        id: `pl-p-${sku}`,
        tenantId,
        sellerAccountId: storeA,
        asin: `B0${sku.replace(/\W/g, '')}`,
        sellerSku: sku,
        fnsku: `X0${sku.replace(/\W/g, '')}`,
        title: `商品 ${sku}`,
      })
    }
    supplier1 = (await insertRow(h.client, 'Supplier', { id: 'pl-s1', tenantId, code: 'SUP-1', name: '供应商一' })).id as string
    supplier2 = (await insertRow(h.client, 'Supplier', { id: 'pl-s2', tenantId, code: 'SUP-2', name: '供应商二' })).id as string
    supplier3 = (await insertRow(h.client, 'Supplier', { id: 'pl-s3', tenantId, code: 'SUP-3', name: '供应商三' })).id as string
    supplier4 = (await insertRow(h.client, 'Supplier', { id: 'pl-s4', tenantId, code: 'SUP-4', name: '供应商四' })).id as string
    otherSupplier = (await insertRow(h.client, 'Supplier', { id: 'pl-so', tenantId: otherTenantId, code: 'SUP-1', name: '别家供应商' })).id as string
    mgr = await h.createMember(tenantId, 'pl-mgr', ALL)
    writer = await h.createMember(tenantId, 'pl-writer', ['inbound.read', 'inbound.plan.write'])
    reader = await h.createMember(tenantId, 'pl-reader', ['inbound.read'])
    scoped = await h.createMember(tenantId, 'pl-scoped', ALL, { scopes: [{ sellerAccountId: storeA }] })
    other = await h.createMember(otherTenantId, 'pl-other', ALL)
  })
  afterAll(async () => {
    await h?.close()
  })

  describe('外部货号映射', () => {
    it('权限：没登录 401；只读成员能看列表但不能改；列表带“能否维护”与原因', async () => {
      expect((await h.call(null, 'GET', '/sku-aliases')).status).toBe(401)
      const list = await aliases(reader)
      expect(list).toMatchObject({ items: [], total: 0, canManage: false, summary: { total: 0, general: 0, supplier: 0 } })
      expect(list.manageBlockedReason).toContain('外部货号映射')
      expect((await addAlias(reader, { externalCode: 'A', sku: 'SKU-A' })).status).toBe(403)
      expect((await addAlias(writer, { externalCode: 'A', sku: 'SKU-A' })).status).toBe(403)
      expect((await aliases(mgr)).canManage).toBe(true)
    })

    it('新增：通用映射与供应商映射；SKU 必须在商品目录、供应商必须存在于本企业；写审计', async () => {
      const general = await addAlias(mgr, { externalCode: 'G-1', sku: 'SKU-A' })
      expect(general.status).toBe(201)
      expect(general.json.data).toMatchObject({ supplierId: null, externalCode: 'G-1', sku: 'SKU-A', skuTitle: '商品 SKU-A', source: 'MANUAL', version: 1 })
      const scopedOne = await addAlias(mgr, { supplierId: supplier1, externalCode: 'AB-1001', sku: 'SKU-C' })
      expect(scopedOne.json.data).toMatchObject({ supplierCode: 'SUP-1', supplierName: '供应商一' })
      const noSku = await addAlias(mgr, { externalCode: 'X', sku: 'SKU-NOPE' })
      expect(noSku.status).toBe(422)
      expect(noSku.json.error.fieldErrors.sku[0]).toContain('商品目录里没有')
      expect((await addAlias(mgr, { supplierId: 'missing', externalCode: 'X', sku: 'SKU-A' })).json.error.fieldErrors.supplierId).toBeTruthy()
      expect((await addAlias(mgr, { supplierId: otherSupplier, externalCode: 'X', sku: 'SKU-A' })).status).toBe(422)
      const audits = await rows<{ action: string }>(`SELECT action FROM "AuditEvent" WHERE "resourceType" = 'SkuAlias' AND "tenantId" = $1 AND result = 'SUCCEEDED' ORDER BY "occurredAt"`, [tenantId])
      expect(audits.map(item => item.action)).toEqual(['SKU_ALIAS_CREATED', 'SKU_ALIAS_CREATED'])
    })

    it('重名 409：同供应商同货号、通用映射同货号；不同供应商可以同货号；数据库部分唯一索引兜底通用映射', async () => {
      expect((await addAlias(mgr, { supplierId: supplier1, externalCode: 'AB-1001', sku: 'SKU-B' })).status).toBe(409)
      expect((await addAlias(mgr, { externalCode: 'G-1', sku: 'SKU-B' })).status).toBe(409)
      expect((await addAlias(mgr, { supplierId: supplier2, externalCode: 'AB-1001', sku: 'SKU-B' })).status).toBe(201)
      await expect(insertRow(h.client, 'SkuAlias', { id: 'pl-dup', tenantId, supplierId: null, externalCode: 'G-1', sku: 'SKU-A', createdBy: mgr.userId })).rejects.toMatchObject({ code: '23505' })
      await expect(insertRow(h.client, 'SkuAlias', { id: 'pl-bad', tenantId, supplierId: null, externalCode: '', sku: 'SKU-A', createdBy: mgr.userId })).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(h.client, 'SkuAlias', { id: 'pl-bad2', tenantId, supplierId: null, externalCode: 'Z', sku: 'SKU-A', source: 'WEIRD', createdBy: mgr.userId })).rejects.toMatchObject({
        code: '23514',
      })
    })

    it('修改带乐观锁：过期 409 带当前版本；同版本并发只有一个成功；改成同名 409；供应商不能改；没改任何项 422', async () => {
      const list = await aliases(mgr, '?q=AB-1001&supplierId=' + supplier1)
      const row = list.items[0]
      const ok = await h.call(mgr.token, 'PUT', `/sku-aliases/${row.id}`, { body: { version: row.version, sku: 'SKU-B' } })
      expect(ok.json.data).toMatchObject({ sku: 'SKU-B', version: row.version + 1, supplierCode: 'SUP-1' })
      const stale = await h.call(mgr.token, 'PUT', `/sku-aliases/${row.id}`, { body: { version: row.version, sku: 'SKU-A' } })
      expect(stale.status).toBe(409)
      expect(stale.json.error.details).toMatchObject({ currentVersion: row.version + 1 })
      const next = row.version + 1
      const [a, b] = await Promise.all([
        h.call(mgr.token, 'PUT', `/sku-aliases/${row.id}`, { body: { version: next, sku: 'SKU-A' } }),
        h.call(mgr.token, 'PUT', `/sku-aliases/${row.id}`, { body: { version: next, sku: 'SKU-C' } }),
      ])
      expect([a.status, b.status].sort()).toEqual([200, 409])
      const current = (await aliases(mgr, '?q=AB-1001&supplierId=' + supplier1)).items[0]
      expect((await h.call(mgr.token, 'PUT', `/sku-aliases/${row.id}`, { body: { version: current.version, externalCode: 'AB-1001', sku: 'SKU-NOPE' } })).status).toBe(422)
      const general = (await aliases(mgr, '?supplierId=GENERAL')).items[0]
      expect((await h.call(mgr.token, 'PUT', `/sku-aliases/${row.id}`, { body: { version: current.version, externalCode: general.externalCode } })).status).toBe(200)
      expect((await h.call(mgr.token, 'PUT', `/sku-aliases/${row.id}`, { body: { version: current.version + 1, supplierId: supplier2 } })).status).toBe(422)
      await h.call(mgr.token, 'PUT', `/sku-aliases/${row.id}`, { body: { version: current.version + 1, externalCode: 'AB-1001', sku: 'SKU-C' } })
    })

    it('列表：筛选供应商与通用、搜索、排序、分页，统计不受筛选影响；删除写审计；别的企业看不到也删不了', async () => {
      const all = await aliases(mgr)
      expect(all.summary).toEqual({ total: 3, general: 1, supplier: 2 })
      expect((await aliases(mgr, '?supplierId=GENERAL')).items.map((item: { externalCode: string }) => item.externalCode)).toEqual(['G-1'])
      const searched = await aliases(mgr, '?q=sku-c')
      expect(searched.items.map((item: { externalCode: string }) => item.externalCode)).toEqual(['AB-1001'])
      expect(searched.summary.total).toBe(3)
      const sorted = await aliases(mgr, '?sort=externalCode:asc&pageSize=2')
      expect(sorted.items.map((item: { externalCode: string }) => item.externalCode)).toEqual(['AB-1001', 'AB-1001'])
      expect(sorted.total).toBe(3)
      expect((await aliases(other)).items).toEqual([])
      const victim = all.items[0]
      expect((await h.call(other.token, 'DELETE', `/sku-aliases/${victim.id}`)).status).toBe(404)
      expect((await h.call(other.token, 'PUT', `/sku-aliases/${victim.id}`, { body: { version: victim.version, sku: 'SKU-A' } })).status).toBe(404)
      const temp = (await addAlias(mgr, { externalCode: 'TEMP-1', sku: 'SKU-A' })).json.data
      expect((await h.call(mgr.token, 'DELETE', `/sku-aliases/${temp.id}`)).status).toBe(200)
      expect((await rows(`SELECT 1 FROM "SkuAlias" WHERE id = $1`, [temp.id])).length).toBe(0)
      expect((await rows(`SELECT 1 FROM "AuditEvent" WHERE action = 'SKU_ALIAS_DELETED' AND "resourceId" = $1 AND result = 'SUCCEEDED'`, [temp.id])).length).toBe(1)
      expect((await h.call(mgr.token, 'DELETE', `/sku-aliases/${temp.id}`)).status).toBe(404)
    })

    it('导入：新增与更新分别计数；有任何错误整份不导入（含未知供应商、目录里没有的 SKU）；导出的文件可以直接再导入', async () => {
      const before = await aliasCount()
      const good = await h.call(mgr.token, 'POST', '/sku-aliases/import', {
        body: { fileName: 'a.csv', content: ['供应商编码,外部货号,SKU', 'SUP-1,AB-1001,SKU-C', 'SUP-1,NEW-1,SKU-A', ',NEW-2,SKU-B', 'SUP-2,NEW-1,SKU-B'].join('\n') },
      })
      expect(good.json.data).toEqual({ total: 4, created: 3, updated: 0 })
      const again = await h.call(mgr.token, 'POST', '/sku-aliases/import', { body: { fileName: 'a.csv', content: ['外部货号,SKU,供应商编码', 'NEW-1,SKU-C,SUP-1', 'NEW-2,SKU-B,'].join('\n') } })
      expect(again.json.data).toEqual({ total: 2, created: 0, updated: 1 })
      expect((await aliases(mgr, '?q=NEW-1&supplierId=' + supplier1)).items[0]).toMatchObject({ sku: 'SKU-C', source: 'IMPORT', version: 2 })
      expect(await aliasCount()).toBe(before + 3)

      const bad = await h.call(mgr.token, 'POST', '/sku-aliases/import', {
        body: { fileName: 'b.csv', content: ['供应商编码,外部货号,SKU', 'SUP-1,OK-1,SKU-A', 'NOPE,OK-2,SKU-A', 'SUP-1,OK-3,SKU-NOPE'].join('\n') },
      })
      expect(bad.status).toBe(422)
      expect(bad.json.error.fieldErrors.content).toEqual(['第 3 行：供应商编码 NOPE 不存在', '第 4 行：商品目录里没有 SKU SKU-NOPE'])
      expect(await aliasCount()).toBe(before + 3)
      expect((await h.call(mgr.token, 'POST', '/sku-aliases/import', { body: { fileName: 'c.csv', content: '供应商编码,外部货号,SKU\nSUP-1,OK-1,SKU-A' } })).status).toBe(200)
      expect((await h.call(writer.token, 'POST', '/sku-aliases/import', { body: { fileName: 'c.csv', content: '外部货号,SKU\nX,SKU-A' } })).status).toBe(403)
      // 另一家企业的供应商编码 SUP-1 也叫 SUP-1，但只认本企业的
      expect((await h.call(other.token, 'POST', '/sku-aliases/import', { body: { fileName: 'd.csv', content: '供应商编码,外部货号,SKU\nSUP-1,O-1,SKU-A' } })).status).toBe(422)

      const exportRes = await get(reader, '/sku-aliases/export')
      expect(exportRes.status, JSON.stringify(exportRes.json)).toBe(200)
      const exported = exportRes.json.data
      expect(exported).toMatchObject({ truncated: false, rows: before + 4 })
      expect(exported.content.startsWith('\uFEFF供应商编码,外部货号,SKU')).toBe(true)
      const round = await h.call(mgr.token, 'POST', '/sku-aliases/import', { body: { fileName: exported.fileName, content: exported.content } })
      expect(round.json.data).toMatchObject({ total: before + 4, created: 0, updated: 0 })
      expect((await get(other, '/sku-aliases/export')).json.data.rows).toBe(0)
    })

    it('迁移：回滚后两张表移除，再升级闭环成功', async () => {
      await h.db.createDatabase('packing_list_mig')
      const client = await h.db.connect('packing_list_mig')
      try {
        await applyMigrations(client, { before: TARGET })
        await seedTenant(client, 'mig')
        await applyMigrations(client, { only: TARGET })
        expect((await client.query(`SELECT to_regclass('"SkuAlias"') IS NOT NULL AND to_regclass('"PackingListMapping"') IS NOT NULL AS found`)).rows[0].found).toBe(true)
        await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
        expect((await client.query(`SELECT to_regclass('"SkuAlias"') IS NOT NULL OR to_regclass('"PackingListMapping"') IS NOT NULL AS found`)).rows[0].found).toBe(false)
        await applyMigrations(client, { only: TARGET })
        expect((await client.query(`SELECT to_regclass('"SkuAlias"') IS NOT NULL AS found`)).rows[0].found).toBe(true)
      } finally {
        await client.end()
      }
    })
  })

  describe('装箱单列映射', () => {
    const body = { columns: { code: '供应商货号', perBox: '每箱' }, units: { length: 'CM', weight: 'KG' } }
    it('首次保存不带版本；已有映射必须带版本；过期 409；读取、删除；权限；跨企业供应商当作不存在', async () => {
      const first = await h.call(mgr.token, 'PUT', `/packing-list-mappings/${supplier2}`, { body })
      expect(first.status).toBe(200)
      expect(first.json.data).toMatchObject({ supplierCode: 'SUP-2', columns: { code: '供应商货号', perBox: '每箱' }, units: { length: 'CM', weight: 'KG' }, version: 1 })
      const noVersion = await h.call(mgr.token, 'PUT', `/packing-list-mappings/${supplier2}`, { body })
      expect(noVersion.status).toBe(409)
      const second = await h.call(mgr.token, 'PUT', `/packing-list-mappings/${supplier2}`, { body: { ...body, version: 1, units: null, columns: { code: '货号' } } })
      expect(second.json.data).toMatchObject({ version: 2, units: null, columns: { code: '货号' } })
      expect((await h.call(mgr.token, 'PUT', `/packing-list-mappings/${supplier2}`, { body: { ...body, version: 1 } })).status).toBe(409)
      expect((await h.call(mgr.token, 'PUT', `/packing-list-mappings/${supplier1}`, { body: { ...body, version: 3 } })).status).toBe(409)
      const one = (await get(reader, `/packing-list-mappings/${supplier2}`)).json.data
      expect(one).toMatchObject({ supplier: { code: 'SUP-2' }, mapping: { version: 2 }, canManage: false })
      expect((await get(reader, `/packing-list-mappings/${supplier1}`)).json.data.mapping).toBeNull()
      expect((await get(reader, '/packing-list-mappings')).json.data.items.map((item: { supplierCode: string }) => item.supplierCode)).toEqual(['SUP-2'])
      expect((await h.call(writer.token, 'PUT', `/packing-list-mappings/${supplier1}`, { body })).status).toBe(403)
      expect((await h.call(other.token, 'PUT', `/packing-list-mappings/${supplier2}`, { body })).status).toBe(404)
      expect((await get(other, `/packing-list-mappings/${supplier2}`)).status).toBe(404)
      expect((await get(other, '/packing-list-mappings')).json.data.items).toEqual([])
      expect((await h.call(other.token, 'DELETE', `/packing-list-mappings/${supplier2}`)).status).toBe(404)
      expect((await h.call(mgr.token, 'DELETE', `/packing-list-mappings/${supplier2}`)).status).toBe(200)
      expect((await h.call(mgr.token, 'DELETE', `/packing-list-mappings/${supplier2}`)).status).toBe(404)
      const audits = await rows<{ action: string }>(`SELECT action FROM "AuditEvent" WHERE "resourceType" = 'PackingListMapping' AND "tenantId" = $1 AND result = 'SUCCEEDED' ORDER BY "occurredAt"`, [
        tenantId,
      ])
      expect(audits.map(item => item.action)).toEqual(['PACKING_LIST_MAPPING_SAVED', 'PACKING_LIST_MAPPING_SAVED', 'PACKING_LIST_MAPPING_DELETED'])
    })

    it('数据库兜底：columns 必须是对象；删除供应商时映射一起删除', async () => {
      await expect(insertRow(h.client, 'PackingListMapping', { id: 'pl-m-bad', tenantId, supplierId: supplier1, columns: JSON.stringify([]), updatedBy: mgr.userId })).rejects.toMatchObject({
        code: '23514',
      })
      await insertRow(h.client, 'Supplier', { id: 'pl-s-tmp', tenantId, code: 'TMP', name: '临时' })
      await h.client.query(`INSERT INTO "PackingListMapping" (id, "tenantId", "supplierId", columns, "updatedBy", "updatedAt") VALUES ('pl-m-tmp', $1, 'pl-s-tmp', '{}', 'u', now())`, [tenantId])
      await h.client.query(`DELETE FROM "Supplier" WHERE id = 'pl-s-tmp'`)
      expect((await rows(`SELECT 1 FROM "PackingListMapping" WHERE id = 'pl-m-tmp'`)).length).toBe(0)
    })
  })

  describe('装箱单预览与应用', () => {
    it('预览：不改任何数据；货号对应不上的给候选；带出能否应用与能否记住；已有箱子数', async () => {
      const id = await newPlan()
      await insertRow(h.client, 'InboundBox', {
        id: `${id}-b`,
        tenantId,
        planId: id,
        boxId: 'OLD',
        quantity: 1,
        weightLb: 1,
        lengthIn: 1,
        widthIn: 1,
        heightIn: 1,
        contentJson: JSON.stringify([{ sku: 'SKU-A', quantity: 1 }]),
      })
      const before = await version(id)
      const res = await parse(writer, id, file())
      expect(res.status).toBe(200)
      expect(res.json.data).toMatchObject({
        headerLine: 1,
        canApply: true,
        existingBoxTypes: 1,
        canRemember: false,
        savedMapping: false,
        supplier: { code: 'SUP-3' },
        units: { length: 'CM', weight: 'KG' },
        summary: { rows: 2, matched: 1, unmatched: 0 },
      })
      expect(res.json.data.rows[0]).toMatchObject({ line: 2, status: 'MATCHED', basis: 'SKU', sku: 'SKU-A', boxCount: 2 })
      expect(res.json.data.rows[1].status).not.toBe('MATCHED')
      expect(res.json.data.rows[1].candidates.map((item: { sku: string }) => item.sku)).toContain('SKU-C')
      expect(res.json.data.rememberBlockedReason).toContain('外部货号映射')
      expect(await version(id)).toBe(before)
      expect((await boxRows(id)).map(box => box.boxId)).toEqual(['OLD'])
      expect((await parse(mgr, id, file())).json.data.canRemember).toBe(true)
    })

    it('应用：还有行没解决时 422，逐条写明原因，不改箱子、不改版本、不写映射', async () => {
      const id = await newPlan()
      const before = await version(id)
      const aliasesBefore = await aliasCount()
      const res = await apply(mgr, id, { ...file(), version: before, decisions: [] })
      expect(res.status).toBe(422)
      expect(res.json.error.fieldErrors.content[0]).toContain('第 3 行')
      expect(await boxRows(id)).toEqual([])
      expect(await version(id)).toBe(before)
      expect(await aliasCount()).toBe(aliasesBefore)
    })

    it('应用：选 SKU 并记住后箱子整体替换、版本加一、映射写入（同一事务）、审计带记住的条数；下次同一供应商自动匹配', async () => {
      const id = await newPlan()
      const before = await version(id)
      const aliasesBefore = await aliasCount()
      const done = await apply(mgr, id, { ...file(PACKING, { supplierId: supplier4 }), version: before, decisions: [{ line: 3, sku: 'SKU-C', remember: true }] })
      expect(done.status).toBe(201)
      expect(done.json.data).toMatchObject({ state: 'SAVED', imported: { boxTypes: 2, boxes: 3, units: 40 }, ignored: 0, remembered: 1 })
      expect(done.json.data.plan.version).toBe(before + 1)
      const boxes = await boxRows(id)
      expect(boxes).toHaveLength(2)
      expect(boxes.map(box => box.quantity).sort()).toEqual([1, 2])
      expect(await aliasCount()).toBe(aliasesBefore + 1)
      const created = await rows<{ supplierId: string; sku: string; source: string }>(`SELECT "supplierId", sku, source FROM "SkuAlias" WHERE "externalCode" = 'AB-1001' AND "supplierId" = $1`, [
        supplier4,
      ])
      expect(created).toEqual([{ supplierId: supplier4, sku: 'SKU-C', source: 'MANUAL' }])
      const audit = await rows<{ detail: { aliasCreated: number; ignoredRows: number; fileName: string } }>(
        `SELECT detail FROM "AuditEvent" WHERE action = 'FBA_INBOUND_PACKING_LIST_APPLIED' AND "resourceId" = $1 AND result = 'SUCCEEDED'`,
        [id],
      )
      expect(audit[0]!.detail).toMatchObject({ aliasCreated: 1, ignoredRows: 0, fileName: '装箱单.csv' })

      const next = await newPlan()
      const again = await parse(writer, next, file(PACKING, { supplierId: supplier4 }))
      expect(again.json.data.rows[1]).toMatchObject({ status: 'MATCHED', basis: 'ALIAS', sku: 'SKU-C' })
      expect(again.json.data.summary).toMatchObject({ matched: 2, unmatched: 0 })
      // 另一个供应商不受影响
      const third = await parse(writer, next, file(PACKING, { supplierId: null }))
      expect(third.json.data.rows[1].status).not.toBe('MATCHED')
      // 没有映射维护权限也能应用已经全部匹配的文件
      const ok = await apply(writer, next, { ...file(PACKING, { supplierId: supplier4 }), version: await version(next), decisions: [] })
      expect(ok.status).toBe(201)
      expect(ok.json.data.remembered).toBe(0)
    })

    it('没有映射维护权限时不能“记住”（403），箱子也不写；忽略的行不装箱', async () => {
      const id = await newPlan()
      const before = await version(id)
      const refused = await apply(writer, id, { ...file(), version: before, decisions: [{ line: 3, sku: 'SKU-B', remember: true }] })
      expect(refused.status).toBe(403)
      expect(await boxRows(id)).toEqual([])
      const ignored = await apply(writer, id, { ...file(), version: before, decisions: [{ line: 3, ignore: true }] })
      expect(ignored.json.data).toMatchObject({ imported: { boxTypes: 1, boxes: 2 }, ignored: 1, remembered: 0 })
    })

    it('版本过期 409：箱子与映射都不写（同一事务）；状态不允许 409；决定里的 SKU 不在计划里 422', async () => {
      const id = await newPlan()
      const before = await version(id)
      const aliasesBefore = await aliasCount()
      const stale = await apply(mgr, id, { ...file(), version: before + 5, decisions: [{ line: 3, sku: 'SKU-B', remember: true }] })
      expect(stale.status).toBe(409)
      expect(await boxRows(id)).toEqual([])
      expect(await aliasCount()).toBe(aliasesBefore)
      const unresolved = await apply(mgr, id, { ...file(), version: before, decisions: [] })
      expect(unresolved.status).toBe(422)
      const wrongSku = await apply(mgr, id, { ...file(), version: before, decisions: [{ line: 3, sku: 'SKU-OUT' }] })
      expect(wrongSku.status).toBe(422)
      expect(wrongSku.json.error.fieldErrors.content[0]).toContain('SKU-OUT 不在这个计划里')
      const early = await newPlan({ stage: 'CREATED' })
      const blocked = await apply(mgr, early, { ...file(), version: await version(early), decisions: [{ line: 3, sku: 'SKU-B' }] })
      expect(blocked.status).toBe(409)
      expect((await parse(mgr, early, file())).json.data).toMatchObject({ canApply: false })
    })

    it('权限、数据范围与企业隔离：只读 403；范围外店铺的计划与别的企业的计划都当作不存在；别的企业的供应商 422', async () => {
      const id = await newPlan()
      const inB = await newPlan({ sellerAccountId: storeB })
      expect((await parse(null, id, file())).status).toBe(401)
      expect((await parse(reader, id, file())).status).toBe(403)
      expect((await apply(reader, id, { ...file(), version: 1, decisions: [] })).status).toBe(403)
      expect((await parse(scoped, id, file())).status).toBe(200)
      expect((await parse(scoped, inB, file())).status).toBe(404)
      expect((await apply(scoped, inB, { ...file(), version: 1, decisions: [] })).status).toBe(404)
      expect((await parse(other, id, file())).status).toBe(404)
      const crossSupplier = await parse(mgr, id, file(PACKING, { supplierId: otherSupplier }))
      expect(crossSupplier.status).toBe(422)
      expect(crossSupplier.json.error.fieldErrors.supplierId).toBeTruthy()
    })

    it('列映射自动套用：保存了列映射的供应商，表头换了写法也能认出；手动指定的列优先', async () => {
      const id = await newPlan()
      await h.call(mgr.token, 'PUT', `/packing-list-mappings/${supplier1}`, { body: { columns: { code: '工厂编号', perBox: '装箱量', boxCount: '件' }, units: { length: 'IN', weight: 'LB' } } })
      const csv = ['工厂编号,装箱量,件,备注', 'SKU-A,12,5,x'].join('\n')
      const res = await parse(mgr, id, file(csv, { supplierId: supplier1 }))
      expect(res.json.data).toMatchObject({ savedMapping: true, unitsSource: 'SAVED', units: { length: 'IN', weight: 'LB' }, columnSources: { code: 'SAVED', perBox: 'SAVED', boxCount: 'SAVED' } })
      expect(res.json.data.rows[0]).toMatchObject({ sku: 'SKU-A', perBox: 12, boxCount: 5 })
      const manual = await parse(mgr, id, file(csv, { supplierId: supplier1, columns: { code: 3 } }))
      expect(manual.json.data.columnSources.code).toBe('REQUEST')
      const needSpec = await apply(mgr, id, { ...file(csv, { supplierId: supplier1 }), version: await version(id), decisions: [] })
      expect(needSpec.status).toBe(422)
      expect(needSpec.json.error.fieldErrors.content.join('')).toContain('箱规')
      const withDefaults = await apply(mgr, id, {
        ...file(csv, { supplierId: supplier1 }),
        defaults: { weightLb: 20, lengthIn: 16, widthIn: 12, heightIn: 10 },
        version: await version(id),
        decisions: [],
      })
      expect(withDefaults.json.data.imported).toEqual({ boxTypes: 1, boxes: 5, units: 60 })
      await h.call(mgr.token, 'DELETE', `/packing-list-mappings/${supplier1}`)
    })

    it('XLSX：读取第一个工作表，行号与表里一致；坏文件、类型选错、非 base64 都是 422', async () => {
      const id = await newPlan()
      const content = xlsxBase64([
        ['装箱单', '', ''],
        ['货号', '每箱数量', '箱数'],
        ['SKU-B', '8', '3'],
      ])
      const res = await parse(mgr, id, file(content, { format: 'XLSX', fileName: '装箱单.xlsx' }))
      expect(res.status).toBe(200)
      expect(res.json.data).toMatchObject({ headerLine: 2, sheet: '装箱单', sheets: ['装箱单'], format: 'XLSX' })
      expect(res.json.data.rows[0]).toMatchObject({ line: 3, sku: 'SKU-B', perBox: 8, boxCount: 3 })
      expect((await parse(mgr, id, file('PK\u0003\u0004nonsense', { format: 'CSV' }))).status).toBe(422)
      expect((await parse(mgr, id, file('不是base64!!', { format: 'XLSX' }))).status).toBe(422)
      expect((await parse(mgr, id, file(Buffer.from('PK\u0003\u0004nonsense').toString('base64'), { format: 'XLSX' }))).status).toBe(422)
      expect((await parse(mgr, id, file(content, { format: 'XLSX', sheet: '不存在' }))).json.error.fieldErrors.content[0]).toContain('找不到工作表')
    })

    it('一次 2000 行也只做固定次数的查询，不会逐行查库', async () => {
      const id = await newPlan()
      const lines = ['货号,数量', ...Array.from({ length: 2000 }, (_, index) => `ITEM-${index},${index + 1}`)]
      const started = Date.now()
      const res = await parse(mgr, id, file(lines.join('\n')))
      expect(res.status).toBe(200)
      expect(res.json.data.summary).toMatchObject({ rows: 2000, matched: 0 })
      expect(Date.now() - started).toBeLessThan(8000)
      const tooMany = await parse(mgr, id, file([...lines, 'ITEM-X,1'].join('\n')))
      expect(tooMany.json.data.fatal).toContain('一次最多处理 2000 行')
    })
  })
})
