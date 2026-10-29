import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 补货批次一键转入仓计划草稿（P6-08，真实数据库 + 完整应用）：
// 预览与确认一致、默认只预览不写库、按“店铺 + 地址”分组、数量与地址可改、缺地址 / 已转过 / 数量为 0 / 不在商品目录不能确认、
// 并发确认只成功一次、草稿可追溯到批次与地址、动作与批次状态同步、取消草稿后可重转、旧意向补建后自动算已解决、数据范围与企业隔离。

const ADDRESS = { addressLine1: '1 Main St', city: 'Los Angeles', stateOrProvince: 'CA', postalCode: '90001', countryCode: 'US', phone: '3105550100' }
const ALL = ['inbound.read', 'shipfrom.manage', 'inbound.plan.write', 'replenishment.read', 'replenishment.plan.create']

type Member = { userId: string; token: string }

describe('补货批次转入仓计划草稿（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let storeA: string
  let storeB: string
  let batchId: string
  let otherBatchId: string
  let mgr: Member
  let planner: Member // 没有 inbound.plan.write
  let reader: Member // 没有 replenishment.plan.create
  let scoped: Member // 只能看店铺 A
  let other: Member

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const post = (member: Member | null, body: unknown, id = batchId) => h.call(member?.token ?? null, 'POST', `/replenishment/batches/${id}/to-inbound-drafts`, { body })
  const preview = async (member: Member, items: unknown[]) => (await post(member, { items })).json.data
  const confirm = (member: Member, items: unknown[]) => post(member, { dryRun: false, items })
  const countOf = async (sql: string, params: unknown[] = []) => (await rows<{ n: number }>(sql, params))[0]!.n
  const plans = () => countOf(`SELECT count(*)::int AS n FROM "FbaInboundPlan" WHERE "sourceRefId" = $1`, [batchId])
  const doneActions = () => countOf(`SELECT count(*)::int AS n FROM "ReplenishmentAction" WHERE "batchId" = $1 AND action = 'INBOUND_DRAFT' AND status = 'DONE'`, [batchId])
  const newAddress = async (member: Member, sellerAccountId: string, name: string, extra: Record<string, unknown> = {}) => {
    const res = await h.call(member.token, 'POST', '/ship-from-addresses', { body: { sellerAccountId, name, ...ADDRESS, ...extra } })
    expect(res.status).toBe(201)
    return res.json.data as { id: string; version: number }
  }
  const detail = async (member: Member = mgr) => (await h.call(member.token, 'GET', `/replenishment/batches/${batchId}`)).json.data

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'batch_inbound' })
    const a = await h.createTenant('bi-a')
    tenantId = a.tenantId
    storeA = a.sellerAccountId
    storeB = (await insertRow(h.client, 'SellerAccount', { id: 'seller-bi-b2', tenantId, legalEntityId: a.legalEntityId, displayName: '店铺乙', sellerId: 'SELLER-B2' })).id as string
    await h.client.query(`UPDATE "SellerAccount" SET "displayName" = '店铺甲' WHERE id = $1`, [storeA])
    const b = await h.createTenant('bi-b')
    mgr = await h.createMember(tenantId, 'bi-mgr', ALL)
    planner = await h.createMember(tenantId, 'bi-planner', ['inbound.read', 'replenishment.read', 'replenishment.plan.create'])
    reader = await h.createMember(tenantId, 'bi-reader', ['inbound.read', 'inbound.plan.write', 'replenishment.read'])
    scoped = await h.createMember(tenantId, 'bi-scoped', ALL, { scopes: [{ sellerAccountId: storeA }] })
    other = await h.createMember(b.tenantId, 'bi-other', ALL)

    batchId = 'batch-1'
    otherBatchId = 'batch-other'
    const snapshot = JSON.stringify({ dataTimes: { restockSnapshotDate: null } })
    await insertRow(h.client, 'ReplenishmentBatch', {
      id: batchId,
      tenantId,
      batchNo: 'RB-2026-1',
      today: '2026-12-10',
      computedBy: mgr.userId,
      snapshotJson: snapshot,
      recommendedCount: 7,
      skuTotal: 7,
    })
    await insertRow(h.client, 'ReplenishmentBatch', { id: otherBatchId, tenantId: b.tenantId, batchNo: 'RB-OTHER', today: '2026-12-10', computedBy: other.userId, snapshotJson: snapshot })
    const rec = (id: string, sellerAccountId: string, sku: string, recommendedQty: number) =>
      insertRow(h.client, 'ReplenishmentRecommendation', {
        id,
        tenantId,
        sellerAccountId,
        batchId,
        sku,
        asin: `B0${sku}`,
        recommendedQty,
        purchaseQty: recommendedQty,
        dueDate: '2026-12-10',
        confidence: 0.9,
        calcStepsJson: JSON.stringify({ dailyDemand: 4, coverageDays: 60, steps: [] }),
        shipmentsJson: '[]',
      })
    await rec('r1', storeA, 'SKU-1', 120)
    await rec('r2', storeA, 'SKU-2', 60)
    await rec('r3', storeB, 'SKU-3', 40)
    await rec('r4', storeA, 'SKU-4', 0)
    await rec('r5', storeA, 'SKU-X', 30) // 不在商品目录
    await rec('r6', storeA, 'SKU-6', 80)
    await rec('r7', storeB, 'SKU-7', 25)
    for (const [id, store, sku] of [
      ['p1', storeA, 'SKU-1'],
      ['p2', storeA, 'SKU-2'],
      ['p3', storeB, 'SKU-3'],
      ['p4', storeA, 'SKU-4'],
      ['p6', storeA, 'SKU-6'],
      ['p7', storeB, 'SKU-7'],
    ] as const) {
      await insertRow(h.client, 'FbaProduct', { id: `bi-${id}`, tenantId, sellerAccountId: store, asin: `B0${sku}`, sellerSku: sku, fnsku: `X0${sku}`, title: `商品 ${sku}`, listingStatus: 'ACTIVE' })
    }
  })
  afterAll(async () => {
    await h?.close()
  })

  it('权限：没登录 401；缺 inbound.plan.write 或 replenishment.plan.create 都是 403（预览也一样）；参数不合格 422', async () => {
    expect((await post(null, { items: [{ recommendationId: 'r1' }] })).status).toBe(401)
    expect((await post(planner, { items: [{ recommendationId: 'r1' }] })).status).toBe(403)
    expect((await post(reader, { items: [{ recommendationId: 'r1' }] })).status).toBe(403)
    expect((await post(mgr, { items: [] })).status).toBe(422)
    expect((await post(mgr, { items: [{ recommendationId: 'r1' }, { recommendationId: 'r1' }] })).status).toBe(422)
    expect((await post(mgr, { items: [{ recommendationId: 'r1', qty: 0 }] })).status).toBe(422)
    expect((await post(mgr, { items: [{ recommendationId: 'r1' }], extra: 1 })).status).toBe(422)
    expect((await post(mgr, { items: [{ recommendationId: 'r1' }] }, 'nope')).status).toBe(404)
  })

  it('没有任何发货地址：预览（不传 dryRun 就是预览）说明原因并给出“去设置”入口，不能确认，也不写任何数据', async () => {
    const data = await preview(mgr, [{ recommendationId: 'r1' }, { recommendationId: 'r3' }])
    expect(data).toMatchObject({ dryRun: true, batchNo: 'RB-2026-1', canConfirm: false, remedy: { path: '/app/settings/ship-from' } })
    expect(data.groups.map((group: { storeName: string; address: unknown }) => [group.storeName, group.address])).toEqual([
      ['店铺甲', null],
      ['店铺乙', null],
    ])
    expect(data.blockers.join('；')).toContain('还没有可用的发货地址')
    const refused = await confirm(mgr, [{ recommendationId: 'r1' }])
    expect(refused.status).toBe(422)
    expect(refused.json.error.message).toContain('发货地址')
    expect(await plans()).toBe(0)
    expect(await doneActions()).toBe(0)
  })

  it('有默认地址后：按店铺分组，数量取建议量，预览与确认用同一份计算；缺箱规外的手改数量标记“已改”', async () => {
    const la = await newAddress(mgr, storeA, '洛杉矶仓')
    await newAddress(mgr, storeA, '新泽西仓')
    await newAddress(mgr, storeB, '乙店主仓')
    const data = await preview(mgr, [{ recommendationId: 'r1' }, { recommendationId: 'r2', qty: 55 }, { recommendationId: 'r3' }])
    expect(data.canConfirm).toBe(true)
    expect(data.blockers).toEqual([])
    const a = data.groups.find((group: { storeName: string }) => group.storeName === '店铺甲')
    expect(a).toMatchObject({ skuCount: 2, totalUnits: 175, planName: '补货批次 RB-2026-1 · 店铺甲', address: { id: la.id, name: '洛杉矶仓', isDefault: true } })
    expect(a.addressOptions.map((option: { name: string }) => option.name)).toEqual(['洛杉矶仓', '新泽西仓'])
    expect(a.items.map((item: { sku: string; quantity: number; recommendedQty: number; edited: boolean }) => [item.sku, item.quantity, item.recommendedQty, item.edited])).toEqual([
      ['SKU-1', 120, 120, false],
      ['SKU-2', 55, 60, true],
    ])
    expect(data.groups.find((group: { storeName: string }) => group.storeName === '店铺乙')).toMatchObject({ skuCount: 1, totalUnits: 40, address: { name: '乙店主仓' } })
    expect(await plans()).toBe(0)
  })

  it('同一店铺选了不同地址：分成两组，名称带上地址名；地址不属于该店铺或已停用 422', async () => {
    const options = (await preview(mgr, [{ recommendationId: 'r1' }])).groups[0].addressOptions as Array<{ id: string; name: string }>
    const nj = options.find(option => option.name === '新泽西仓')!
    const data = await preview(mgr, [{ recommendationId: 'r1' }, { recommendationId: 'r2', shipFromAddressId: nj.id }])
    expect(data.groups.map((group: { planName: string }) => group.planName).sort()).toEqual(['补货批次 RB-2026-1 · 店铺甲 · 新泽西仓', '补货批次 RB-2026-1 · 店铺甲 · 洛杉矶仓'])
    const bAddress = (await preview(mgr, [{ recommendationId: 'r3' }])).groups[0].address.id as string
    expect((await post(mgr, { items: [{ recommendationId: 'r1', shipFromAddressId: bAddress }] })).status).toBe(422)
    const njRow = (await h.call(mgr.token, 'GET', '/ship-from-addresses?q=新泽西')).json.data.items[0] as { id: string; version: number }
    await h.call(mgr.token, 'PUT', `/ship-from-addresses/${njRow.id}`, { body: { version: njRow.version, status: 'INACTIVE' } })
    expect((await post(mgr, { items: [{ recommendationId: 'r1', shipFromAddressId: nj.id }] })).status).toBe(422)
    await h.call(mgr.token, 'PUT', `/ship-from-addresses/${njRow.id}`, { body: { version: njRow.version + 1, status: 'ACTIVE' } })
  })

  it('数量为 0、不在商品目录：不能确认，逐条说明；改了数量就能确认', async () => {
    const data = await preview(mgr, [{ recommendationId: 'r4' }, { recommendationId: 'r5' }])
    expect(data.canConfirm).toBe(false)
    expect(data.blockers.join('；')).toContain('SKU-4')
    expect(data.blockers.join('；')).toContain('SKU-X')
    expect(data.blockers.join('；')).toContain('不在商品目录')
    expect((await confirm(mgr, [{ recommendationId: 'r4' }])).status).toBe(422)
    expect((await preview(mgr, [{ recommendationId: 'r4', qty: 10 }])).canConfirm).toBe(true)
    expect(await plans()).toBe(0)
  })

  it('范围外与企业外的建议当作不存在（404），不泄露是否存在；受限成员只能转自己店铺的', async () => {
    expect((await post(scoped, { items: [{ recommendationId: 'r3' }] })).status).toBe(404)
    expect((await post(scoped, { dryRun: false, items: [{ recommendationId: 'r1' }, { recommendationId: 'r3' }] })).status).toBe(404)
    expect((await post(other, { items: [{ recommendationId: 'r1' }] })).status).toBe(404)
    expect((await post(other, { items: [{ recommendationId: 'r1' }] }, otherBatchId)).status).toBe(404)
    expect((await post(mgr, { items: [{ recommendationId: 'r1' }] }, otherBatchId)).status).toBe(404)
    expect(await plans()).toBe(0)
  })

  it('确认：每个“店铺 + 地址”生成一份草稿；草稿可追溯到批次与地址、带商品信息；动作与批次状态同步；写审计', async () => {
    const res = await confirm(mgr, [{ recommendationId: 'r1' }, { recommendationId: 'r2', qty: 55 }, { recommendationId: 'r3' }])
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ dryRun: false, batchNo: 'RB-2026-1', actions: 3 })
    expect(
      res.json.data.plans
        .map((plan: { name: string; skuCount: number; totalUnits: number; shipFromAddressName: string }) => [plan.name, plan.skuCount, plan.totalUnits, plan.shipFromAddressName])
        .sort(),
    ).toEqual([
      ['补货批次 RB-2026-1 · 店铺乙', 1, 40, '乙店主仓'],
      ['补货批次 RB-2026-1 · 店铺甲', 2, 175, '洛杉矶仓'],
    ])
    const planRows = await rows<{
      id: string
      name: string
      stage: string
      status: string
      sourceType: string
      sourceRefId: string
      shipFromAddressId: string
      sourceAddress: string
      totalUnits: number
      createdBy: string
    }>(`SELECT * FROM "FbaInboundPlan" WHERE "sourceRefId" = $1 ORDER BY name`, [batchId])
    expect(planRows).toHaveLength(2)
    const planA = planRows.find(plan => plan.name.endsWith('店铺甲'))!
    expect(planA).toMatchObject({ stage: 'DRAFT', sourceType: 'REPLENISHMENT_BATCH', totalUnits: 175, createdBy: mgr.userId })
    expect(JSON.parse(planA.sourceAddress)).toMatchObject({
      name: '洛杉矶仓',
      addressLine1: '1 Main St',
      city: 'Los Angeles',
      stateOrProvinceCode: 'CA',
      postalCode: '90001',
      countryCode: 'US',
      phoneNumber: '3105550100',
    })
    const items = await rows<{ sku: string; quantity: number; asin: string; fnsku: string; productName: string }>(
      `SELECT sku, quantity, asin, fnsku, "productName" FROM "InboundPlanItem" WHERE "planId" = $1 ORDER BY sku`,
      [planA.id],
    )
    expect(items).toEqual([
      { sku: 'SKU-1', quantity: 120, asin: 'B0SKU-1', fnsku: 'X0SKU-1', productName: '商品 SKU-1' },
      { sku: 'SKU-2', quantity: 55, asin: 'B0SKU-2', fnsku: 'X0SKU-2', productName: '商品 SKU-2' },
    ])
    const actions = await rows<{ recommendationId: string; finalQty: number; targetDocType: string; targetDocId: string; actorId: string }>(
      `SELECT "recommendationId", "finalQty", "targetDocType", "targetDocId", "actorId" FROM "ReplenishmentAction" WHERE "batchId" = $1 AND status = 'DONE' ORDER BY "recommendationId"`,
      [batchId],
    )
    expect(actions.map(item => [item.recommendationId, item.finalQty, item.targetDocType])).toEqual([
      ['r1', 120, 'INBOUND_PLAN'],
      ['r2', 55, 'INBOUND_PLAN'],
      ['r3', 40, 'INBOUND_PLAN'],
    ])
    expect(actions[0]).toMatchObject({ targetDocId: planA.id, actorId: mgr.userId })
    expect((await rows<{ status: string }>(`SELECT status FROM "ReplenishmentBatch" WHERE id = $1`, [batchId]))[0]!.status).toBe('DRAFTED')
    const audits = await rows<{ action: string }>(
      `SELECT action FROM "AuditEvent" WHERE "tenantId" = $1 AND result = 'SUCCEEDED' AND action IN ('FBA_INBOUND_PLAN_CREATED', 'REPLENISHMENT_INBOUND_DRAFTED')`,
      [tenantId],
    )
    expect(audits.map(item => item.action).sort()).toEqual(['FBA_INBOUND_PLAN_CREATED', 'FBA_INBOUND_PLAN_CREATED', 'REPLENISHMENT_INBOUND_DRAFTED'])
    // 入仓计划页看得到，并带来源与地址
    const list = (await h.call(mgr.token, 'GET', '/inbound/plans')).json.data
    expect(list.items.some((item: { id: string; sourceType: string }) => item.id === planA.id && item.sourceType === 'REPLENISHMENT_BATCH')).toBe(true)
  })

  it('已转过的建议：再预览标明“已在哪份草稿”，不能确认，再确认 409，不会多出草稿；用过的地址不能删', async () => {
    const data = await preview(mgr, [{ recommendationId: 'r1' }, { recommendationId: 'r6' }])
    expect(data.canConfirm).toBe(false)
    expect(data.converted).toEqual([expect.objectContaining({ recommendationId: 'r1', sku: 'SKU-1', planStage: 'DRAFT', planName: '补货批次 RB-2026-1 · 店铺甲' })])
    expect(data.blockers.join('；')).toContain('已经转过')
    const again = await confirm(mgr, [{ recommendationId: 'r1' }, { recommendationId: 'r6' }])
    expect(again.status).toBe(409)
    expect(await plans()).toBe(2)
    expect(await doneActions()).toBe(3)
    const used = (await h.call(mgr.token, 'GET', '/ship-from-addresses?q=洛杉矶')).json.data.items[0] as { id: string; usedByPlans: number }
    expect(used.usedByPlans).toBe(1)
    expect((await h.call(mgr.token, 'DELETE', `/ship-from-addresses/${used.id}`)).status).toBe(409)
  })

  it('批次详情“执行情况”列出生成的入仓计划草稿（受数据范围约束）', async () => {
    const data = await detail()
    expect(
      data.execution.inboundPlans.map((plan: { name: string; storeName: string; skuCount: number; totalUnits: number; stage: string; stageLabel: string; shipFromAddressName: string }) => [
        plan.name,
        plan.skuCount,
        plan.totalUnits,
        plan.stage,
        plan.shipFromAddressName,
      ]),
    ).toEqual([expect.arrayContaining(['补货批次 RB-2026-1 · 店铺甲', 2, 175, 'DRAFT', '洛杉矶仓']), expect.arrayContaining(['补货批次 RB-2026-1 · 店铺乙', 1, 40, 'DRAFT', '乙店主仓'])])
    expect(data.execution.actionCounts.INBOUND_DRAFT).toBe(3)
    const mine = await detail(scoped)
    expect(mine.execution.inboundPlans.map((plan: { storeName: string }) => plan.storeName)).toEqual(['店铺甲'])
  })

  it('并发确认同一条建议：只有一个成功、一个 409，只生成一份草稿', async () => {
    const [a, b] = await Promise.all([confirm(mgr, [{ recommendationId: 'r6' }]), confirm(mgr, [{ recommendationId: 'r6' }])])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(await countOf(`SELECT count(*)::int AS n FROM "ReplenishmentAction" WHERE "recommendationId" = 'r6' AND status = 'DONE'`)).toBe(1)
    expect(await plans()).toBe(3)
  })

  it('草稿被取消后，其中的建议可以重新转', async () => {
    const planId = (await rows<{ targetDocId: string }>(`SELECT "targetDocId" FROM "ReplenishmentAction" WHERE "recommendationId" = 'r6' AND status = 'DONE'`))[0]!.targetDocId
    expect((await preview(mgr, [{ recommendationId: 'r6' }])).canConfirm).toBe(false)
    await h.client.query(`UPDATE "FbaInboundPlan" SET stage = 'CANCELLED', status = 'CANCELLED' WHERE id = $1`, [planId])
    const data = await preview(mgr, [{ recommendationId: 'r6' }])
    expect(data).toMatchObject({ canConfirm: true, converted: [] })
    const redo = await confirm(mgr, [{ recommendationId: 'r6' }])
    expect(redo.status).toBe(200)
    expect(await plans()).toBe(4)
    // 同一条建议有两条已完成的动作（旧草稿已取消），列表上只展示、不重复计数
    const second = await detail()
    expect(second.execution.inboundPlans.filter((plan: { id: string }) => plan.id === planId)).toHaveLength(1)
  })

  it('旧意向（只登记过、没生成单据）：在意向清单里按范围可见；补建草稿后自动算已解决；批次详情的“只登记”条数同步归零', async () => {
    const legacy = (id: string, recommendationId: string, finalQty: number) =>
      insertRow(h.client, 'ReplenishmentAction', { id, tenantId, batchId, recommendationId, action: 'INBOUND_DRAFT', status: 'PENDING_TARGET', finalQty, actorId: mgr.userId })
    await legacy('legacy-1', 'r7', 25)
    await legacy('legacy-2', 'r4', 10)
    const all = (await h.call(mgr.token, 'GET', '/replenishment/intents')).json.data
    expect(all.total).toBe(2)
    expect(all.items.map((item: { sku: string; qty: number; storeName: string; batchNo: string }) => [item.sku, item.qty, item.storeName, item.batchNo]).sort()).toEqual([
      ['SKU-4', 10, '店铺甲', 'RB-2026-1'],
      ['SKU-7', 25, '店铺乙', 'RB-2026-1'],
    ])
    const mine = (await h.call(scoped.token, 'GET', '/replenishment/intents')).json.data
    expect(mine.items.map((item: { sku: string }) => item.sku)).toEqual(['SKU-4'])
    expect((await h.call(other.token, 'GET', '/replenishment/intents')).json.data.total).toBe(0)
    expect((await h.call(planner.token, 'GET', '/replenishment/intents')).status).toBe(200)
    expect((await h.call(null, 'GET', '/replenishment/intents')).status).toBe(401)
    expect((await h.call(mgr.token, 'GET', `/replenishment/intents?batchId=nope`)).json.data.total).toBe(0)
    expect((await detail()).execution.pendingTargets).toBe(2)
    const done = await confirm(mgr, [{ recommendationId: 'r7' }])
    expect(done.status).toBe(200)
    const left = (await h.call(mgr.token, 'GET', '/replenishment/intents')).json.data
    expect(left.items.map((item: { sku: string }) => item.sku)).toEqual(['SKU-4'])
    const data = await detail()
    expect(data.execution.pendingTargets).toBe(1)
    const r7 = data.items.find((item: { sku: string }) => item.sku === 'SKU-7')
    expect(r7.actions.map((action: { status: string }) => action.status)).toEqual(['DONE'])
  })
})
