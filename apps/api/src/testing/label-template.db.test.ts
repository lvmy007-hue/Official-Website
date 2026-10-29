import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_BOX_NO_RULE, DEFAULT_LABEL_OPTIONS, LABEL_TEMPLATE_LIMIT } from '@nova/api-contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ObjectStorageService } from '../platform/storage/object-storage.service'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 标签模板、自定义箱标签与商品标签（P6-12，真实数据库 + 完整应用）：
//   - 模板：权限、企业隔离、默认模板唯一（含并发）、同名 409、乐观锁、上限、删除后生成记录保留、数据库约束兜底；
//   - 生成：创建导出任务并保存快照、箱内内容不能确定时不印并说明原因、缺亚马逊箱标签文件与缺 FNSKU 的拦截、范围与权限、通用导出不能创建 PDF；
//   - 标签页签：按货件统计生成次数；迁移：ExportJob 增加 PDF 格式，回滚后恢复。

const TARGET = '20261214010000_label_template'
const MIGRATION = join(MIGRATIONS_DIR, TARGET)
const THERMAL = 'PackageLabel_Thermal_NonPCP'
const ALL = ['inbound.read', 'labeltemplate.manage', 'inbound.plan.write', 'export.create']

type Member = { userId: string; token: string }

describe('标签模板与标签生成（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let storeA: string
  let storeB: string
  let otherTenantId: string
  let mgr: Member
  let viewer: Member
  let noExport: Member
  let scopedB: Member // 只能看店铺 B
  let other: Member

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const templates = async (member: Member, query = '') => (await h.call(member.token, 'GET', `/label-templates${query}`)).json.data
  const create = (member: Member, body: Record<string, unknown>) =>
    h.call(member.token, 'POST', '/label-templates', { body: { name: '默认', paper: 'THERMAL_4X6', options: DEFAULT_LABEL_OPTIONS, boxNoRule: DEFAULT_BOX_NO_RULE, isDefault: false, ...body } })
  const byName = async (member: Member, name: string) => (await templates(member)).items.find((item: { name: string }) => item.name === name)

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'label_template' })
    const a = await h.createTenant('lt-a')
    tenantId = a.tenantId
    storeA = a.sellerAccountId
    storeB = (await insertRow(h.client, 'SellerAccount', { id: 'seller-lt-b2', tenantId, legalEntityId: a.legalEntityId, displayName: '店铺乙', sellerId: 'SELLER-LT2' })).id as string
    otherTenantId = (await h.createTenant('lt-b')).tenantId
    mgr = await h.createMember(tenantId, 'lt-mgr', ALL)
    viewer = await h.createMember(tenantId, 'lt-viewer', ['inbound.read'])
    noExport = await h.createMember(tenantId, 'lt-noexport', ['inbound.read', 'inbound.plan.write'])
    scopedB = await h.createMember(tenantId, 'lt-scoped', ALL, { scopes: [{ sellerAccountId: storeB }] })
    other = await h.createMember(otherTenantId, 'lt-other', ALL)
  })
  afterAll(async () => {
    await h?.close()
  })

  describe('标签模板', () => {
    it('权限：没登录 401；只读成员能看列表但新增、改、删都是 403；列表带“能否维护”与原因', async () => {
      expect((await h.call(null, 'GET', '/label-templates')).status).toBe(401)
      const list = await templates(viewer)
      expect(list).toMatchObject({ canManage: false, items: [], total: 0, summary: { total: 0, defaultName: null } })
      expect(list.manageBlockedReason).toContain('标签模板')
      expect((await create(viewer, { name: '不行' })).status).toBe(403)
      expect(
        (
          await h.call(viewer.token, 'PUT', '/label-templates/x', {
            body: { version: 1, name: 'x', paper: 'THERMAL_4X6', options: DEFAULT_LABEL_OPTIONS, boxNoRule: DEFAULT_BOX_NO_RULE, isDefault: false },
          })
        ).status,
      ).toBe(403)
      expect((await h.call(viewer.token, 'DELETE', '/label-templates/x')).status).toBe(403)
      expect((await templates(mgr)).canManage).toBe(true)
    })

    it('新增：第一个模板自动成为默认；后面的不是；写审计；名称重复 409；参数不合格 422', async () => {
      const first = await create(mgr, { name: '热敏纸标准' })
      expect(first.status).toBe(201)
      expect(first.json.data).toMatchObject({ name: '热敏纸标准', paper: 'THERMAL_4X6', isDefault: true, version: 1 })
      expect(first.json.data.options).toMatchObject({ showOrigin: true, originText: 'Made in China', appendToOriginal: false })
      const second = await create(mgr, { name: 'A4 四拼', paper: 'A4_4UP' })
      expect(second.json.data.isDefault).toBe(false)
      expect((await create(mgr, { name: '热敏纸标准' })).status).toBe(409)
      expect((await create(mgr, { name: '' })).status).toBe(422)
      expect((await create(mgr, { name: '错组合', paper: 'A4_4UP', options: { ...DEFAULT_LABEL_OPTIONS, appendToOriginal: true } })).status).toBe(422)
      const audits = await rows<{ action: string }>(`SELECT action FROM "AuditEvent" WHERE "resourceType" = 'LabelTemplate' AND "tenantId" = $1 AND result = 'SUCCEEDED' ORDER BY "occurredAt"`, [
        tenantId,
      ])
      expect(audits.map(item => item.action)).toEqual(['LABEL_TEMPLATE_CREATED', 'LABEL_TEMPLATE_CREATED'])
    })

    it('默认模板全企业只有一个：设为默认时原默认同时取消（版本号加一）；并发设默认最终也只有一个', async () => {
      const a4 = await byName(mgr, 'A4 四拼')
      const made = await h.call(mgr.token, 'PUT', `/label-templates/${a4.id}`, {
        body: { version: a4.version, name: a4.name, paper: a4.paper, options: a4.options, boxNoRule: a4.boxNoRule, isDefault: true },
      })
      expect(made.status).toBe(200)
      expect(made.json.data).toMatchObject({ isDefault: true, version: 2 })
      const thermal = await byName(mgr, '热敏纸标准')
      expect(thermal).toMatchObject({ isDefault: false, version: 2 })
      const put = (row: { id: string; version: number; name: string; paper: string; options: unknown; boxNoRule: unknown }) =>
        h.call(mgr.token, 'PUT', `/label-templates/${row.id}`, { body: { version: row.version, name: row.name, paper: row.paper, options: row.options, boxNoRule: row.boxNoRule, isDefault: true } })
      await Promise.all([put(thermal), put(await byName(mgr, 'A4 四拼'))])
      expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "LabelTemplate" WHERE "tenantId" = $1 AND "isDefault"`, [tenantId]))[0]!.n).toBe(1)
      const list = await templates(mgr)
      expect(list.summary.total).toBe(2)
      expect(list.summary.defaultName).toBe(list.items.find((item: { isDefault: boolean }) => item.isDefault).name)
    })

    it('修改整份替换并带乐观锁：过期 409 带当前版本；同一版本并发只有一个成功；改成同名 409；列表可搜索与排序', async () => {
      const row = await byName(mgr, '热敏纸标准')
      const body = (patch: Record<string, unknown> = {}) => ({
        version: row.version,
        name: row.name,
        paper: row.paper,
        options: row.options,
        boxNoRule: row.boxNoRule,
        isDefault: row.isDefault,
        ...patch,
      })
      const ok = await h.call(mgr.token, 'PUT', `/label-templates/${row.id}`, { body: body({ options: { ...row.options, showProductName: true, order: 'OURS' }, version: row.version }) })
      expect(ok.status).toBe(200)
      expect(ok.json.data.options).toMatchObject({ showProductName: true, order: 'OURS' })
      const stale = await h.call(mgr.token, 'PUT', `/label-templates/${row.id}`, { body: body({ name: '过期' }) })
      expect(stale.status).toBe(409)
      expect(stale.json.error.details).toMatchObject({ currentVersion: ok.json.data.version })
      const version = ok.json.data.version
      const [a, b] = await Promise.all([
        h.call(mgr.token, 'PUT', `/label-templates/${row.id}`, { body: body({ version, name: '并发甲' }) }),
        h.call(mgr.token, 'PUT', `/label-templates/${row.id}`, { body: body({ version, name: '并发乙' }) }),
      ])
      expect([a.status, b.status].sort()).toEqual([200, 409])
      const winner = a.status === 200 ? a : b
      expect((await h.call(mgr.token, 'PUT', `/label-templates/${row.id}`, { body: body({ version: winner.json.data.version, name: 'A4 四拼' }) })).status).toBe(409)
      expect((await h.call(mgr.token, 'PUT', `/label-templates/${row.id}`, { body: body({ version: winner.json.data.version, name: '热敏纸标准' }) })).status).toBe(200)
      expect((await templates(mgr, '?q=a4')).items.map((item: { name: string }) => item.name)).toEqual(['A4 四拼'])
      expect((await templates(mgr, '?sort=name:asc')).items.map((item: { name: string }) => item.name)).toEqual(['A4 四拼', '热敏纸标准'])
    })

    it('企业隔离：别的企业看不到、改不了、删不了；模板数量上限 50，超过 409', async () => {
      const row = await byName(mgr, '热敏纸标准')
      expect((await templates(other)).items).toEqual([])
      expect((await h.call(other.token, 'DELETE', `/label-templates/${row.id}`)).status).toBe(404)
      expect(
        (
          await h.call(other.token, 'PUT', `/label-templates/${row.id}`, {
            body: { version: row.version, name: '偷改', paper: row.paper, options: row.options, boxNoRule: row.boxNoRule, isDefault: false },
          })
        ).status,
      ).toBe(404)
      const have = (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "LabelTemplate" WHERE "tenantId" = $1`, [tenantId]))[0]!.n
      for (let index = have; index < LABEL_TEMPLATE_LIMIT; index += 1)
        await insertRow(h.client, 'LabelTemplate', { id: `lt-fill-${index}`, tenantId, name: `填充${index}`, paper: 'THERMAL_4X6', createdBy: mgr.userId })
      const refused = await create(mgr, { name: '第五十一个' })
      expect(refused.status).toBe(409)
      expect(refused.json.error.message).toContain(String(LABEL_TEMPLATE_LIMIT))
      await h.client.query(`DELETE FROM "LabelTemplate" WHERE id LIKE 'lt-fill-%'`)
    })

    it('数据库兜底：同企业不能有两个默认模板、同名、纸张不在清单里、名称为空', async () => {
      const base = { tenantId, paper: 'THERMAL_4X6', createdBy: mgr.userId }
      await expect(insertRow(h.client, 'LabelTemplate', { id: 'lt-d1', ...base, name: '兜底一', isDefault: true })).rejects.toMatchObject({ code: '23505' })
      await expect(insertRow(h.client, 'LabelTemplate', { id: 'lt-d2', ...base, name: '热敏纸标准' })).rejects.toMatchObject({ code: '23505' })
      await expect(insertRow(h.client, 'LabelTemplate', { id: 'lt-d3', ...base, name: '兜底三', paper: 'LETTER' })).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(h.client, 'LabelTemplate', { id: 'lt-d4', ...base, name: '' })).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(h.client, 'LabelPrintLog', { id: 'lp-d1', tenantId, planId: 'nope', kind: 'WEIRD', labelCount: 1, printedBy: mgr.userId })).rejects.toBeTruthy()
    })
  })

  describe('标签生成', () => {
    let plan: string
    let shipmentA: string
    let shipmentB: string

    const planRow = async (id: string, sellerAccountId: string, extra: Record<string, unknown> = {}) =>
      insertRow(h.client, 'FbaInboundPlan', { id, tenantId, sellerAccountId, name: `计划 ${id}`, externalPlanId: `wf-${id}`, ...extra })
    const shipmentRow = async (id: string, planId: string, extra: Record<string, unknown>) =>
      insertRow(h.client, 'FbaInboundShipment', { id, planId, shipmentId: `sh-${id}`, shipmentConfirmationId: `FBA-${id}`, destinationFc: 'ONT8', ...extra })
    const custom = (member: Member, shipmentRowId: string, body: Record<string, unknown> = {}) => h.call(member.token, 'POST', `/inbound/shipments/${shipmentRowId}/labels/custom`, { body })
    const items = (member: Member, planId: string, body: Record<string, unknown> = {}) =>
      h.call(member.token, 'POST', `/inbound/plans/${planId}/item-labels`, { body: { size: 'THERMAL_60X40', ...body } })

    // 每人同时最多 3 个排队中的导出任务：每个用例开始前清掉上一个用例留下的排队任务
    beforeEach(async () => {
      await h.client.query(`DELETE FROM "ExportJob" WHERE "tenantId" = $1`, [tenantId])
    })

    beforeAll(async () => {
      plan = (await planRow('lp-1', storeA)).id as string
      shipmentA = (await shipmentRow('ls-a', plan, { boxCount: 2, createdAt: new Date('2026-12-01T00:00:00Z') })).id as string
      shipmentB = (await shipmentRow('ls-b', plan, { boxCount: 3, createdAt: new Date('2026-12-02T00:00:00Z') })).id as string
      await insertRow(h.client, 'InboundPlanItem', { id: 'lpi-1', tenantId, planId: plan, sku: 'SKU-A', fnsku: 'X001AAAAAA', productName: 'Desk lamp', quantity: 120 })
      await insertRow(h.client, 'InboundPlanItem', { id: 'lpi-2', tenantId, planId: plan, sku: 'SKU-B', fnsku: null, productName: null, quantity: 30 })
      await insertRow(h.client, 'ShipmentItem', { id: 'lsi-1', tenantId, planId: plan, shipmentId: 'sh-ls-a', sku: 'SKU-A', fnsku: 'X001AAAAAA', shippedQty: 24 })
      await insertRow(h.client, 'ShipmentItem', { id: 'lsi-2', tenantId, planId: plan, shipmentId: 'sh-ls-b', sku: 'SKU-A', fnsku: 'X001AAAAAA', shippedQty: 36 })
      await insertRow(h.client, 'InboundBox', {
        id: 'lb-1',
        tenantId,
        planId: plan,
        boxId: 'b1',
        quantity: 5,
        weightLb: 10,
        lengthIn: 10,
        widthIn: 10,
        heightIn: 10,
        contentJson: JSON.stringify([{ sku: 'SKU-A', quantity: 12 }]),
      })
    })

    it('没有亚马逊箱标签文件：409，写明要先取哪种页面类型；货件没有箱数 409；货件不存在或在范围外 404', async () => {
      const thermalId = (await byName(mgr, '热敏纸标准')).id as string
      const noBase = await custom(mgr, shipmentA, { templateId: thermalId })
      expect(noBase.status).toBe(409)
      expect(noBase.json.error.message).toContain(THERMAL)
      expect(noBase.json.error.message).toContain('获取箱标签')
      const bare = (await shipmentRow('ls-bare', plan, {})).id as string
      expect((await custom(mgr, bare, { templateId: thermalId })).status).toBe(409)
      expect((await custom(mgr, 'nope')).status).toBe(404)
      expect((await custom(scopedB, shipmentA)).status).toBe(404)
      expect((await custom(other, shipmentA)).status).toBe(404)
    })

    it('权限：没有写权限或没有导出权限 403；模板不存在 404；通用导出接口不能直接建标签 PDF', async () => {
      expect((await custom(viewer, shipmentA)).status).toBe(403)
      expect((await custom(noExport, shipmentA)).status).toBe(403)
      expect((await items(noExport, plan)).status).toBe(403)
      await insertRow(h.client, 'LabelPrintJob', {
        id: 'lj-1',
        tenantId,
        planId: plan,
        shipmentId: 'sh-ls-a',
        kind: 'BOX',
        status: 'READY',
        objectKey: `tenants/${tenantId}/inbound-labels/x.pdf`,
        pageType: THERMAL,
        requestedBy: mgr.userId,
      })
      await insertRow(h.client, 'LabelPrintJob', {
        id: 'lj-2',
        tenantId,
        planId: plan,
        shipmentId: 'sh-ls-b',
        kind: 'BOX',
        status: 'READY',
        objectKey: `tenants/${tenantId}/inbound-labels/y.pdf`,
        pageType: THERMAL,
        requestedBy: mgr.userId,
      })
      expect((await custom(mgr, shipmentA, { templateId: 'gone' })).status).toBe(404)
      const direct = await h.call(mgr.token, 'POST', '/exports', { body: { kind: 'inbound-box-labels', format: 'CSV', filters: {}, filterSummary: '直接创建' } })
      expect(direct.status).toBe(422)
    })

    it('创建导出任务并保存快照：模板、箱号起始序号接着前面的货件、纸张、箱数；内容不能确定时不印并说明原因；入队与审计', async () => {
      const queued = h.queue.add.mock.calls.length
      const thermal = await byName(mgr, '热敏纸标准')
      // 货件 B 的数量改成 35（≠ 3 箱 × 每箱 12 件）：对不上，不能印 SKU 与件数
      await h.client.query(`UPDATE "ShipmentItem" SET "shippedQty" = 35 WHERE id = 'lsi-2'`)
      const made = await custom(mgr, shipmentB, { templateId: thermal.id })
      await h.client.query(`UPDATE "ShipmentItem" SET "shippedQty" = 36 WHERE id = 'lsi-2'`)
      expect(made.status).toBe(201)
      expect(made.json.data).toMatchObject({ status: 'QUEUED', kindLabel: '自定义箱标签' })
      expect(made.json.data.notes.join('')).toContain('导出中心')
      const job = (
        await rows<{ kind: string; format: string; filterJson: Record<string, any>; requestedBy: string; fieldPolicySnapshot: Record<string, any>; filterSummary: string }>(
          `SELECT * FROM "ExportJob" WHERE id = $1`,
          [made.json.data.exportId],
        )
      )[0]!
      expect(job).toMatchObject({ kind: 'inbound-box-labels', format: 'PDF', requestedBy: mgr.userId })
      expect(job.filterSummary).toContain('FBA-ls-b')
      expect(job.fieldPolicySnapshot).toMatchObject({ columns: ['pdf'], scope: { unrestricted: true } })
      // 货件 A 有 2 个箱子，货件 B 的箱号接着编：起始序号 = 模板起始 1 + 2
      expect(job.filterJson).toMatchObject({
        planId: plan,
        shipmentRowId: shipmentB,
        paper: 'THERMAL_4X6',
        boxCount: 3,
        startNumber: 3,
        baseLabelJobId: 'lj-2',
        templateName: '热敏纸标准',
        planNo: 'wf-lp-1',
      })
      // 计划里的装箱记录只有一种内容，但货件 B 的数量（35）≠ 3 箱 × 每箱 12 件：对不上，所以不印 SKU 与件数，并说明原因
      expect(job.filterJson.facts).toBeNull()
      expect(job.filterJson.notes.join('')).toContain('对不上')
      expect(h.queue.add.mock.calls.length).toBe(queued + 1)
      expect(h.queue.add.mock.calls.at(-1)).toEqual(['exports', { tenantId, exportJobId: made.json.data.exportId }, `export:${made.json.data.exportId}`])
      const audit = await rows<{ action: string }>(`SELECT action FROM "AuditEvent" WHERE "resourceId" = $1 AND "tenantId" = $2 AND result = 'SUCCEEDED' ORDER BY "occurredAt"`, [shipmentB, tenantId])
      expect(audit.map(item => item.action)).toContain('FBA_INBOUND_CUSTOM_LABELS_REQUESTED')
    })

    it('内容一致且数量核对得上：印 SKU、品名、FNSKU、每箱件数；指定起始序号覆盖自动编号；起始序号过大导致箱号超长 422', async () => {
      const thermal0 = await byName(mgr, '热敏纸标准')
      const made = await custom(mgr, shipmentA, { startNumber: 100, templateId: thermal0.id })
      expect(made.status).toBe(201)
      const job = (await rows<{ filterJson: Record<string, any> }>(`SELECT "filterJson" FROM "ExportJob" WHERE id = $1`, [made.json.data.exportId]))[0]!
      // 货件 A：2 个箱子 × 每箱 12 = 24，与货件明细一致
      expect(job.filterJson.facts).toEqual({ items: [{ sku: 'SKU-A', quantity: 12, productName: 'Desk lamp', fnsku: 'X001AAAAAA' }] })
      expect(job.filterJson).toMatchObject({ startNumber: 100, templateId: thermal0.id, templateName: '热敏纸标准' })
      expect((await custom(mgr, shipmentA, { startNumber: 99_999_999, templateId: thermal0.id })).status).toBe(201)
      await h.client.query(
        `UPDATE "LabelTemplate" SET "boxNoRule" = jsonb_build_object('prefix', 'ABCDEFGHIJKLMNOPQRST', 'suffix', 'ABCDEFGHIJKLMNOPQRST', 'joiner', '---', 'digits', 8, 'start', 0, 'includePlanNo', false) WHERE name = '热敏纸标准'`,
      )
      const thermal = await byName(mgr, '热敏纸标准')
      expect((await custom(mgr, shipmentA, { templateId: thermal.id })).status).toBe(422)
    })

    it('按模板没有任何内容可追加（勾选的都不能确定、也没有任务名称页）：409 并说明', async () => {
      const bare = await create(mgr, { name: '全关', options: { ...DEFAULT_LABEL_OPTIONS, showOrigin: false, showSku: false, showUnits: false, showBoxNo: false } })
      const refused = await custom(mgr, shipmentA, { templateId: bare.json.data.id })
      expect(refused.status).toBe(409)
      expect(refused.json.error.message).toContain('没有任何内容')
    })

    it('商品标签：按计划商品数量；缺 FNSKU 拦截并列出 SKU；跳过后在说明里列出；按货件取货件明细；总数超限 422', async () => {
      const missing = await items(mgr, plan)
      expect(missing.status).toBe(409)
      expect(missing.json.error.message).toContain('SKU-B')
      const skipped = await items(mgr, plan, { skipMissingFnsku: true, showTitle: true })
      expect(skipped.status).toBe(201)
      expect(skipped.json.data.notes.join('')).toContain('SKU-B')
      const job = (await rows<{ kind: string; filterJson: Record<string, any>; filterSummary: string }>(`SELECT * FROM "ExportJob" WHERE id = $1`, [skipped.json.data.exportId]))[0]!
      expect(job.kind).toBe('inbound-item-labels')
      expect(job.filterJson).toMatchObject({
        planId: plan,
        shipmentRowId: null,
        size: 'THERMAL_60X40',
        showTitle: true,
        lines: [{ sku: 'SKU-A', fnsku: 'X001AAAAAA', title: 'Desk lamp', quantity: 120 }],
      })
      expect(job.filterSummary).toContain('120 张')
      const perShipment = await items(mgr, plan, { shipmentId: shipmentB, size: 'A4_21' })
      expect(perShipment.status).toBe(201)
      const lines = (await rows<{ filterJson: Record<string, any> }>(`SELECT "filterJson" FROM "ExportJob" WHERE id = $1`, [perShipment.json.data.exportId]))[0]!.filterJson.lines
      expect(lines).toEqual([{ sku: 'SKU-A', fnsku: 'X001AAAAAA', title: null, quantity: 36 }])
      await h.client.query(`UPDATE "InboundPlanItem" SET quantity = 30000 WHERE id = 'lpi-1'`)
      expect((await items(mgr, plan, { skipMissingFnsku: true })).status).toBe(422)
      await h.client.query(`UPDATE "InboundPlanItem" SET quantity = 120 WHERE id = 'lpi-1'`)
      expect((await items(scopedB, plan, { skipMissingFnsku: true })).status).toBe(404)
      expect((await items(mgr, plan, { shipmentId: 'nope', skipMissingFnsku: true })).status).toBe(404)
    })

    it('标签页签按货件统计：生成成功后的次数、最近时间、箱数与已取到的纸张类型；删除模板后记录保留', async () => {
      const thermal = await byName(mgr, '热敏纸标准')
      await insertRow(h.client, 'LabelPrintLog', { id: 'lpl-1', tenantId, planId: plan, shipmentId: shipmentA, templateId: thermal.id, kind: 'BOX_CUSTOM', labelCount: 2, printedBy: mgr.userId })
      await insertRow(h.client, 'LabelPrintLog', { id: 'lpl-2', tenantId, planId: plan, shipmentId: shipmentA, kind: 'ITEM', labelCount: 24, printedBy: mgr.userId })
      await insertRow(h.client, 'LabelPrintLog', { id: 'lpl-3', tenantId, planId: plan, shipmentId: shipmentA, templateId: thermal.id, kind: 'BOX_CUSTOM', labelCount: 2, printedBy: mgr.userId })
      // 对象存储里没有真实文件：签名下载地址用桩
      vi.spyOn(h.app.get(ObjectStorageService), 'forTenant').mockReturnValue({
        signDownload: vi.fn().mockResolvedValue({ url: 'https://files.example/label.pdf', method: 'GET', headers: {}, expiresAt: new Date(Date.now() + 300_000) }),
      } as never)
      const labelsResponse = await h.call(mgr.token, 'GET', `/inbound/plans/${plan}/labels`)
      expect(labelsResponse.status).toBe(200)
      const view = labelsResponse.json.data
      expect(view.note).toContain('导出中心')
      const stat = view.printStats.find((item: { shipmentRowId: string }) => item.shipmentRowId === shipmentA)
      expect(stat).toMatchObject({ shipmentId: 'FBA-ls-a', boxes: 2, customCount: 2, itemCount: 1, readyPageTypes: [THERMAL] })
      expect(stat.lastPrintedAt).toEqual(expect.any(String))
      expect(view.printStats.find((item: { shipmentRowId: string }) => item.shipmentRowId === shipmentB)).toMatchObject({ customCount: 0, itemCount: 0, readyPageTypes: [THERMAL] })
      expect((await h.call(mgr.token, 'DELETE', `/label-templates/${thermal.id}`)).status).toBe(200)
      expect((await rows<{ templateId: string | null }>(`SELECT "templateId" FROM "LabelPrintLog" WHERE id = 'lpl-1'`))[0]).toEqual({ templateId: null })
      const deleted = await rows(`SELECT 1 FROM "AuditEvent" WHERE action = 'LABEL_TEMPLATE_DELETED' AND "resourceId" = $1 AND result = 'SUCCEEDED'`, [thermal.id])
      expect(deleted.length).toBe(1)
    })

    it('迁移：升级前的导出任务保留；升级后允许 PDF 格式；回滚删除两张表与 PDF 任务并恢复格式约束；再升级闭环成功', async () => {
      await h.db.createDatabase('label_template_mig')
      const client = await h.db.connect('label_template_mig')
      try {
        await applyMigrations(client, { before: TARGET })
        const ids = await seedTenant(client, 'mig')
        const job = {
          tenantId: ids.tenantId,
          kind: 'orders',
          sourcePage: '/app/orders',
          filterSummary: 'x',
          filterJson: '{}',
          status: 'DONE',
          requestedBy: 'u',
          expiresAt: new Date(),
          fieldPolicySnapshot: '{}',
        }
        await insertRow(client, 'ExportJob', { id: 'old-csv', ...job, format: 'CSV' })
        await expect(insertRow(client, 'ExportJob', { id: 'early-pdf', ...job, format: 'PDF' })).rejects.toMatchObject({ code: '23514' })
        await applyMigrations(client, { only: TARGET })
        await insertRow(client, 'ExportJob', { id: 'new-pdf', ...job, kind: 'inbound-box-labels', format: 'PDF' })
        await client.query(readFileSync(join(MIGRATION, 'rollback.sql'), 'utf8'))
        expect((await client.query(`SELECT id FROM "ExportJob" ORDER BY id`)).rows).toEqual([{ id: 'old-csv' }])
        expect((await client.query(`SELECT to_regclass('"LabelTemplate"') IS NOT NULL AS a, to_regclass('"LabelPrintLog"') IS NOT NULL AS b`)).rows[0]).toEqual({ a: false, b: false })
        await applyMigrations(client, { only: TARGET })
        expect((await client.query(`SELECT to_regclass('"LabelTemplate"') IS NOT NULL AS a`)).rows[0].a).toBe(true)
      } finally {
        await client.end()
      }
    })
  })
})
