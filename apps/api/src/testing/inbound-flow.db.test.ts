import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { INBOUND_FLOW_STEPS, INBOUND_STAGES, boxTemplateCsv, type InboundOverview } from '@nova/api-contracts'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 入仓计划流程骨架与装箱草稿（P6-10，真实数据库 + 完整应用）：
// 五步在各阶段的状态与按钮（含作废窗口过期后不能取消）、装箱草稿保存与版本冲突、状态与权限与范围与企业隔离、
// 表格文件模板导入的正常、缺列、超行、SKU 不在计划内、重复行跳过，整份拒绝时不改任何数据。

type Member = { userId: string; token: string }
const ALL = ['inbound.read', 'inbound.plan.write']
const ADDRESS = JSON.stringify({ name: '深圳仓', addressLine1: '1 Road', city: 'Shenzhen', stateOrProvinceCode: 'GD', countryCode: 'CN', postalCode: '518000', phoneNumber: '1234567' })
const HEADER = '箱号,SKU,每箱数量,重量(磅),长(英寸),宽(英寸),高(英寸),相同箱数'

describe('入仓计划流程骨架与装箱草稿（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let storeA: string
  let storeB: string
  let mgr: Member
  let reader: Member
  let scoped: Member
  let other: Member
  let planSeq = 0

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const newPlan = async (
    over: Record<string, unknown> = {},
    skus: Array<[string, number]> = [
      ['SKU-A', 10],
      ['SKU-B', 5],
    ],
  ) => {
    const id = `flow-plan-${++planSeq}`
    await insertRow(h.client, 'FbaInboundPlan', {
      id,
      tenantId,
      sellerAccountId: storeA,
      name: `计划 ${planSeq}`,
      sourceAddress: ADDRESS,
      stage: 'PACKING_CONFIRMED',
      externalPlanId: `IP-${planSeq}`,
      ...over,
    })
    for (const [sku, quantity] of skus) await insertRow(h.client, 'InboundPlanItem', { id: `${id}-${sku}`, tenantId, planId: id, sku, quantity })
    return id
  }
  const overview = async (id: string, member: Member = mgr) => (await h.call(member.token, 'GET', `/inbound/plans/${id}`)).json.data as InboundOverview
  const version = async (id: string) => (await rows<{ version: number }>(`SELECT version FROM "FbaInboundPlan" WHERE id = $1`, [id]))[0]!.version
  const boxRows = (id: string) =>
    rows<{ boxId: string; quantity: number; contentJson: Array<{ sku: string; quantity: number }> }>(`SELECT "boxId", quantity, "contentJson" FROM "InboundBox" WHERE "planId" = $1 ORDER BY "boxId"`, [
      id,
    ])
  const put = (member: Member | null, id: string, body: unknown) => h.call(member?.token ?? null, 'PUT', `/inbound/plans/${id}/boxes`, { body })
  const importFile = (member: Member | null, id: string, body: unknown) => h.call(member?.token ?? null, 'POST', `/inbound/plans/${id}/boxes/import`, { body })
  const fileBody = async (id: string, content: string, over: Record<string, unknown> = {}) => ({ version: await version(id), kind: 'MIXED', fileName: 'boxes.csv', content, ...over })
  const box = (over: Record<string, unknown> = {}) => ({ boxId: 'B1', quantity: 2, weightLb: 20, lengthIn: 16, widthIn: 12, heightIn: 10, items: [{ sku: 'SKU-A', quantity: 5 }], ...over })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'inbound_flow' })
    const a = await h.createTenant('fl-a')
    tenantId = a.tenantId
    storeA = a.sellerAccountId
    storeB = (await insertRow(h.client, 'SellerAccount', { id: 'seller-fl-b2', tenantId, legalEntityId: a.legalEntityId, displayName: '店铺乙', sellerId: 'SELLER-FL-B2' })).id as string
    const b = await h.createTenant('fl-b')
    mgr = await h.createMember(tenantId, 'fl-mgr', ALL)
    reader = await h.createMember(tenantId, 'fl-reader', ['inbound.read'])
    scoped = await h.createMember(tenantId, 'fl-scoped', ALL, { scopes: [{ sellerAccountId: storeA }] })
    other = await h.createMember(b.tenantId, 'fl-other', ALL)
  })
  afterAll(async () => {
    await h?.close()
  })

  describe('五步流程', () => {
    const stateOf = (data: InboundOverview) => data.steps.map(step => step.state)

    it('五步固定为选品、装箱、分仓、运输、标签与发货；每步带按钮，不能点的写明原因', async () => {
      const data = await overview(await newPlan({ stage: 'CREATED' }))
      expect(data.steps.map(step => step.key)).toEqual([...INBOUND_FLOW_STEPS])
      expect(data.steps.map(step => step.label)).toEqual(['选品', '装箱', '分仓', '运输', '标签与发货'])
      const boxes = data.steps[1]!
      expect(boxes.actions.map(action => action.action)).toEqual(['GENERATE_PACKING', 'CONFIRM_PACKING', 'SAVE_BOXES', 'SUBMIT_PACKING_INFO'])
      const byAction = Object.fromEntries(boxes.actions.map(action => [action.action, action]))
      expect(byAction.GENERATE_PACKING).toMatchObject({ allowed: true, reason: null })
      expect(byAction.SAVE_BOXES.allowed).toBe(false)
      expect(byAction.SAVE_BOXES.reason).toContain('不能做这一步')
      for (const step of data.steps) for (const action of step.actions) expect(action.allowed ? action.reason === null : !!action.reason, `${step.key}.${action.action}`).toBe(true)
      // 与整体的 actions 同一份规则
      for (const step of data.steps) for (const action of step.actions) expect(data.actions[action.action]).toEqual({ allowed: action.allowed, reason: action.reason })
      expect(data.stageChain.length).toBeGreaterThan(5)
    })

    it('各阶段的步骤状态：草稿选品进行中，之后依次完成；已发货及以后全部完成', async () => {
      const expected: Record<string, string[]> = {
        DRAFT: ['IN_PROGRESS', 'NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED'],
        ELIGIBILITY: ['IN_PROGRESS', 'NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED'],
        CREATED: ['DONE', 'IN_PROGRESS', 'NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED'],
        PACKING_CONFIRMED: ['DONE', 'IN_PROGRESS', 'NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED'],
        PACKING_INFO_SUBMITTED: ['DONE', 'DONE', 'IN_PROGRESS', 'NOT_STARTED', 'NOT_STARTED'],
        PLACEMENT_CONFIRMED: ['DONE', 'DONE', 'DONE', 'IN_PROGRESS', 'NOT_STARTED'],
        TRANSPORT_CONFIRMED: ['DONE', 'DONE', 'DONE', 'DONE', 'IN_PROGRESS'],
        LABELS_PRINTED: ['DONE', 'DONE', 'DONE', 'DONE', 'IN_PROGRESS'],
        SHIPPED: ['DONE', 'DONE', 'DONE', 'DONE', 'DONE'],
        RECEIVING: ['DONE', 'DONE', 'DONE', 'DONE', 'DONE'],
        DISCREPANCY: ['DONE', 'DONE', 'DONE', 'DONE', 'DONE'],
        COMPLETED: ['DONE', 'DONE', 'DONE', 'DONE', 'DONE'],
        CANCELLED: ['NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED'],
      }
      expect(Object.keys(expected).sort()).toEqual([...INBOUND_STAGES].sort())
      for (const stage of INBOUND_STAGES) expect(stateOf(await overview(await newPlan({ stage }, []))), stage).toEqual(expected[stage])
    })

    it('装箱步骤的按钮随阶段变化：装箱方案已确认才能保存草稿与提交；提交后只剩分仓步骤的按钮', async () => {
      const allowedOf = (data: InboundOverview, key: string) =>
        data.steps
          .find(step => step.key === key)!
          .actions.filter(action => action.allowed)
          .map(action => action.action)
      expect(allowedOf(await overview(await newPlan({ stage: 'PACKING_CONFIRMED' })), 'BOXES')).toEqual(['SAVE_BOXES', 'SUBMIT_PACKING_INFO'])
      expect(allowedOf(await overview(await newPlan({ stage: 'PACKING_INFO_SUBMITTED' })), 'BOXES')).toEqual([])
      expect(allowedOf(await overview(await newPlan({ stage: 'PACKING_INFO_SUBMITTED' })), 'PLACEMENT')).toEqual(['GENERATE_PLACEMENT', 'CONFIRM_PLACEMENT'])
      expect(allowedOf(await overview(await newPlan({ stage: 'DRAFT' }, [])), 'ITEMS')).toEqual(['ELIGIBILITY'])
      expect(allowedOf(await overview(await newPlan({ stage: 'ELIGIBILITY' }, [])), 'ITEMS')).toEqual(['ELIGIBILITY', 'SUBMIT'])
      expect(allowedOf(await overview(await newPlan({ stage: 'LABELS_PRINTED' }, [])), 'LABELS_SHIP')).toEqual(['PRINT_LABELS', 'MARK_SHIPPED', 'UPDATE_TRACKING'])
    })

    it('有操作在途：该步显示亚马逊正在处理，所有按钮禁用并写明原因；失败的操作记在当前步骤并标出错', async () => {
      const busy = await overview(await newPlan({ stage: 'PACKING_INFO_SUBMITTED', pendingOp: 'GENERATE_PLACEMENT' }, []))
      expect(busy.steps[2]).toMatchObject({ state: 'IN_PROGRESS' })
      expect(busy.steps[2]!.note).toContain('亚马逊正在处理：生成分仓方案')
      for (const step of busy.steps) for (const action of step.actions) expect(action).toMatchObject({ allowed: false, reason: '有操作正在处理中，请等亚马逊返回结果' })
      const failed = await overview(await newPlan({ stage: 'CREATED', lastErrorMessage: '亚马逊拒绝：SKU-B 不能入仓' }, []))
      expect(stateOf(failed)).toEqual(['DONE', 'ERROR', 'NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED'])
      expect(failed.steps[1]!.note).toBe('亚马逊拒绝：SKU-B 不能入仓')
      // 已经完结的计划里残留的失败信息不再标出错
      expect(stateOf(await overview(await newPlan({ stage: 'COMPLETED', lastErrorMessage: '旧错误' }, [])))).toEqual(['DONE', 'DONE', 'DONE', 'DONE', 'DONE'])
    })

    it('作废窗口：窗口内可以取消计划；窗口过期、没有窗口信息、货件已发出都不能取消，并写明原因', async () => {
      const cancel = async (over: Record<string, unknown>) => (await overview(await newPlan(over, []))).actions.CANCEL
      expect(await cancel({ stage: 'TRANSPORT_CONFIRMED', voidDeadlineAt: new Date(Date.now() + 3_600_000).toISOString() })).toEqual({ allowed: true, reason: null })
      expect(await cancel({ stage: 'LABELS_PRINTED', voidDeadlineAt: new Date(Date.now() - 60_000).toISOString() })).toEqual({ allowed: false, reason: '作废窗口已过，不能取消' })
      expect(await cancel({ stage: 'TRANSPORT_CONFIRMED', voidDeadlineAt: null })).toEqual({ allowed: false, reason: '没有取到作废窗口信息，不能取消' })
      expect(await cancel({ stage: 'SHIPPED' })).toEqual({ allowed: false, reason: '货件已发出，不能取消计划' })
      expect((await cancel({ stage: 'CREATED' })).allowed).toBe(true)
    })

    it('读权限：没登录 401、没有 inbound.read 的成员 403；范围外的店铺与别的企业的计划按不存在处理', async () => {
      const id = await newPlan({ stage: 'CREATED' })
      const inB = await newPlan({ stage: 'CREATED', sellerAccountId: storeB })
      expect((await h.call(null, 'GET', `/inbound/plans/${id}`)).status).toBe(401)
      expect((await overview(id, reader)).steps).toHaveLength(5)
      expect((await h.call(scoped.token, 'GET', `/inbound/plans/${inB}`)).status).toBe(404)
      expect((await h.call(other.token, 'GET', `/inbound/plans/${id}`)).status).toBe(404)
    })
  })

  describe('装箱草稿保存', () => {
    it('保存：整体替换现有箱子，缺箱号的自动编号，带版本号，写审计；之后读回来一致', async () => {
      const id = await newPlan()
      const first = await put(mgr, id, {
        version: await version(id),
        boxes: [box({ boxId: undefined, items: [{ sku: 'SKU-A', quantity: 5 }] }), box({ boxId: 'B2', items: [{ sku: 'SKU-B', quantity: 5 }], quantity: 1 })],
      })
      expect(first.status).toBe(200)
      expect((await boxRows(id)).map(item => item.boxId)).toEqual(['B2', 'BOX-001'])
      const second = await put(mgr, id, { version: await version(id), boxes: [box({ boxId: 'ONLY' })] })
      expect(second.status).toBe(200)
      expect((await boxRows(id)).map(item => item.boxId)).toEqual(['ONLY'])
      expect(second.json.data.plan.version).toBeGreaterThan(first.json.data.plan.version)
      const read = (await h.call(mgr.token, 'GET', `/inbound/plans/${id}/boxes`)).json.data
      expect(read.boxes).toHaveLength(1)
      expect(read.validation.ok).toBe(false)
      const audits = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE action = 'FBA_INBOUND_BOXES_SAVED' AND "resourceId" = $1 AND "result" = 'SUCCEEDED'`, [id])
      expect(audits[0]!.n).toBe(2)
    })

    it('版本冲突 409：别人先改过，旧版本保存不会覆盖；原来的箱子保持不变', async () => {
      const id = await newPlan()
      const stale = await version(id)
      expect((await put(mgr, id, { version: stale, boxes: [box({ boxId: 'FIRST' })] })).status).toBe(200)
      const conflict = await put(mgr, id, { version: stale, boxes: [box({ boxId: 'SECOND' })] })
      expect(conflict.status).toBe(409)
      expect((await boxRows(id)).map(item => item.boxId)).toEqual(['FIRST'])
    })

    it('状态不对（箱内物品已提交）409；有操作在途 409；没有写权限 403；范围外与别的企业 404；校验失败 422 且不改数据', async () => {
      const submitted = await newPlan({ stage: 'PACKING_INFO_SUBMITTED' })
      expect((await put(mgr, submitted, { version: 1, boxes: [box()] })).status).toBe(409)
      const busy = await newPlan({ pendingOp: 'SUBMIT_PACKING_INFO' })
      expect((await put(mgr, busy, { version: 1, boxes: [box()] })).status).toBe(409)
      const id = await newPlan()
      expect((await put(null, id, { version: 1, boxes: [box()] })).status).toBe(401)
      expect((await put(reader, id, { version: 1, boxes: [box()] })).status).toBe(403)
      const inB = await newPlan({ sellerAccountId: storeB })
      expect((await put(scoped, inB, { version: 1, boxes: [box()] })).status).toBe(404)
      expect((await put(other, id, { version: 1, boxes: [box()] })).status).toBe(404)
      expect((await put(mgr, id, { version: 1, boxes: [] })).status).toBe(422)
      expect((await put(mgr, id, { version: 1, boxes: [box({ weightLb: 0 })] })).status).toBe(422)
      expect((await put(mgr, id, { version: 1, boxes: [box({ items: [{ sku: 'NOT-IN-PLAN', quantity: 1 }] })] })).status).toBe(422)
      expect((await put(mgr, id, { version: 1, boxes: [box({ boxId: 'D' }), box({ boxId: 'D' })] })).status).toBe(422)
      expect(await boxRows(id)).toEqual([])
    })
  })

  describe('表格文件模板', () => {
    it('模板下载：两种白名单模板；别的 kind 404；没登录 401、没有 inbound.read 403', async () => {
      const mixed = await h.call(reader.token, 'GET', '/inbound/box-templates/MIXED')
      expect(mixed.status).toBe(200)
      expect(mixed.json.data).toMatchObject({ kind: 'MIXED', fileName: '装箱导入模板-混装.csv', maxRows: 2000 })
      expect(mixed.json.data.content).toBe(boxTemplateCsv('MIXED'))
      expect((await h.call(reader.token, 'GET', '/inbound/box-templates/ORIGINAL')).json.data.columns.map((column: { label: string }) => column.label)).toContain('箱数')
      expect((await h.call(reader.token, 'GET', '/inbound/box-templates/WHATEVER')).status).toBe(404)
      expect((await h.call(null, 'GET', '/inbound/box-templates/MIXED')).status).toBe(401)
      const nobody = await h.createMember(tenantId, 'fl-nobody', [])
      expect((await h.call(nobody.token, 'GET', '/inbound/box-templates/MIXED')).status).toBe(403)
    })

    it('混装模板导入正常：同箱号多行合并成一个箱子，整体替换原有箱子，审计记文件名', async () => {
      const id = await newPlan()
      await put(mgr, id, { version: await version(id), boxes: [box({ boxId: 'OLD' })] })
      const content = [HEADER, 'BX-1,SKU-A,6,22,16,12,10,2', 'BX-1,SKU-B,2,22,16,12,10,2', 'BX-2,SKU-A,4,18,14,12,10'].join('\r\n')
      const res = await importFile(mgr, id, await fileBody(id, content))
      expect(res.status, JSON.stringify(res.json)).toBe(201)
      expect(res.json.data).toMatchObject({ state: 'SAVED', imported: { boxTypes: 2, boxes: 3, units: 6 * 2 + 2 * 2 + 4 }, skipped: [] })
      const saved = await boxRows(id)
      expect(saved.map(item => item.boxId)).toEqual(['BX-1', 'BX-2'])
      expect(saved[0]).toMatchObject({
        quantity: 2,
        contentJson: [
          { sku: 'SKU-A', quantity: 6 },
          { sku: 'SKU-B', quantity: 2 },
        ],
      })
      expect(saved[1]!.quantity).toBe(1)
      const audit = await rows<{ detail: unknown }>(`SELECT detail FROM "AuditEvent" WHERE action = 'FBA_INBOUND_BOXES_IMPORTED' AND "resourceId" = $1 AND "result" = 'SUCCEEDED'`, [id])
      expect(audit).toHaveLength(1)
      expect(JSON.stringify(audit[0]!.detail)).toContain('boxes.csv')
    })

    it('原厂包装模板导入正常：一行一种规格，自动编号；英文表头与分号分隔也认；重复行跳过并告知', async () => {
      const id = await newPlan()
      const content = ['sku;units per case;cases;weight;length;width;height', 'SKU-A;5;2;20;16;12;10', 'SKU-A;5;2;20;16;12;10', 'SKU-B;5;1;18;14;12;10'].join('\n')
      const res = await importFile(mgr, id, await fileBody(id, content, { kind: 'ORIGINAL' }))
      expect(res.status, JSON.stringify(res.json)).toBe(201)
      expect(res.json.data.imported).toMatchObject({ boxTypes: 2, boxes: 3, units: 15 })
      expect(res.json.data.skipped).toEqual([{ line: 3, message: '与第 2 行完全相同，已跳过' }])
      expect((await boxRows(id)).map(item => item.boxId)).toEqual(['BOX-001', 'BOX-002'])
      const read = (await h.call(mgr.token, 'GET', `/inbound/plans/${id}/boxes`)).json.data
      expect(read.validation.ok).toBe(true)
    })

    it('缺关键列：整份拒绝并说明缺哪列，不改数据', async () => {
      const id = await newPlan()
      await put(mgr, id, { version: await version(id), boxes: [box({ boxId: 'KEEP' })] })
      const res = await importFile(mgr, id, await fileBody(id, ['箱号,SKU,每箱数量,重量,长,宽', 'B1,SKU-A,5,20,16,12'].join('\n')))
      expect(res.status).toBe(422)
      expect(res.json.error.fieldErrors.content.join('；')).toContain('缺少“高(英寸)”列')
      expect((await boxRows(id)).map(item => item.boxId)).toEqual(['KEEP'])
    })

    it('超过 2000 行：整份拒绝；2000 行以内不超限', async () => {
      const id = await newPlan()
      const lines = (count: number) => Array.from({ length: count }, (_value, index) => `SKU-A,1,${index + 1},20,16,12,10`)
      const header = 'SKU,每箱件数,箱数,重量,长,宽,高'
      const over = await importFile(mgr, id, await fileBody(id, [header, ...lines(2001)].join('\n'), { kind: 'ORIGINAL' }))
      expect(over.status).toBe(422)
      expect(over.json.error.fieldErrors.content[0]).toContain('最多导入 2000 行')
      expect(await boxRows(id)).toEqual([])
    })

    it('SKU 不在计划内与数字不合法：逐行列出原因，整份拒绝，不改数据', async () => {
      const id = await newPlan()
      const content = [HEADER, 'B1,SKU-A,5,20,16,12,10', 'B2,GHOST,5,20,16,12,10', 'B3,SKU-B,0,20,16,12,10', 'B4,SKU-B,5,abc,16,12,10'].join('\n')
      const res = await importFile(mgr, id, await fileBody(id, content))
      expect(res.status).toBe(422)
      const lines: string[] = res.json.error.fieldErrors.content
      expect(lines.some(line => line.startsWith('第 3 行') && line.includes('GHOST 不在这个计划里'))).toBe(true)
      expect(lines.some(line => line.startsWith('第 4 行') && line.includes('每箱数量'))).toBe(true)
      expect(lines.some(line => line.startsWith('第 5 行') && line.includes('重量'))).toBe(true)
      expect(await boxRows(id)).toEqual([])
    })

    it('权限、状态与并发：没登录 401、缺写权限 403、范围外与别的企业 404、状态不对 409、旧版本 409、参数不合格 422', async () => {
      const id = await newPlan()
      const good = [HEADER, 'B1,SKU-A,5,20,16,12,10'].join('\n')
      expect((await importFile(null, id, await fileBody(id, good))).status).toBe(401)
      expect((await importFile(reader, id, await fileBody(id, good))).status).toBe(403)
      const inB = await newPlan({ sellerAccountId: storeB })
      expect((await importFile(scoped, inB, await fileBody(inB, good))).status).toBe(404)
      expect((await importFile(other, id, await fileBody(id, good))).status).toBe(404)
      const submitted = await newPlan({ stage: 'PACKING_INFO_SUBMITTED' })
      expect((await importFile(mgr, submitted, await fileBody(submitted, good))).status).toBe(409)
      expect((await importFile(mgr, id, { version: 999, kind: 'MIXED', fileName: 'a.csv', content: good })).status).toBe(409)
      expect((await importFile(mgr, id, { version: 1, kind: 'MIXED', fileName: 'a.csv', content: '' })).status).toBe(422)
      expect((await importFile(mgr, id, { version: 1, kind: 'WHATEVER', fileName: 'a.csv', content: good })).status).toBe(422)
      expect((await importFile(mgr, id, { version: 1, kind: 'MIXED', fileName: 'a.csv', content: good, extra: 1 })).status).toBe(422)
      expect(await boxRows(id)).toEqual([])
    })
  })
})
