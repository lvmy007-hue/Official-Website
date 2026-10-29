import { describe, expect, it } from 'vitest'
import { COST_COMPONENTS, COST_COMPONENT_COLUMN, COST_COVERAGES, COST_IMPORT_COLUMNS } from './costs.js'
import { compareVersions, coverageOf, currentVersions, estimateInventory, estimateStream, landedOf, planActivation, pricingOf, toUsd, type CostLite, type StockLayer } from './costs-math.js'
import { CostActivateBodySchema, CostListQuerySchema, CostVersionCreateBodySchema, CostVersionUpdateBodySchema } from './costs-query.js'
import { COST_STALE_DAYS } from './profit-view.js'

// 商品成本（P2b-14）的纯函数与请求校验。规则与 worker 的利润计价保持一致：有入库批次只按批次，否则按价格版本。

const lite = (over: Partial<CostLite> = {}): CostLite => ({
  id: 'v1',
  versionNo: 1,
  status: 'ACTIVE',
  source: 'MANUAL',
  effectiveFrom: '2026-01-01',
  currency: 'USD',
  product: 10,
  firstMile: null,
  duty: null,
  other: null,
  quantity: null,
  ...over,
})

describe('常量', () => {
  it('成本项与数据库列一一对应；导入列别名里第一个是页面上展示的名字', () => {
    expect(COST_COMPONENTS.map(component => COST_COMPONENT_COLUMN[component])).toEqual(['unitProductCost', 'unitFirstMileCost', 'unitDutyCost', 'unitOtherCost'])
    expect(COST_COVERAGES).toEqual(['COVERED', 'STALE', 'DRAFT_ONLY', 'MISSING'])
    expect(COST_IMPORT_COLUMNS.sku[0]).toBe('SKU')
  })
})

describe('当前成本', () => {
  it('每一项取生效中、已到生效日里最新的一条；草稿、已替换、未来的不算', () => {
    const versions = [
      lite({ id: 'a', versionNo: 1, effectiveFrom: '2026-01-01', product: 10 }),
      lite({ id: 'b', versionNo: 2, effectiveFrom: '2026-03-01', product: 12 }),
      lite({ id: 'c', versionNo: 3, effectiveFrom: '2026-09-01', product: 99 }),
      lite({ id: 'd', versionNo: 4, status: 'DRAFT', effectiveFrom: '2026-04-01', product: 50 }),
      lite({ id: 'e', versionNo: 5, status: 'REPLACED', effectiveFrom: '2026-05-01', product: 60 }),
      lite({ id: 'f', versionNo: 6, source: 'FIRST_MILE_ALLOCATION', effectiveFrom: '2026-02-01', product: null, firstMile: 1.5 }),
    ]
    const now = currentVersions(versions, '2026-06-01')
    expect(now.product?.id).toBe('b')
    expect(now.firstMile?.id).toBe('f')
    expect(now.duty).toBeNull()
    expect(currentVersions(versions, '2025-12-31').product).toBeNull()
  })

  it('同一天有两个版本：版本号大的更新', () => {
    const versions = [lite({ id: 'a', versionNo: 1 }), lite({ id: 'b', versionNo: 2, product: 11 })]
    expect(currentVersions(versions, '2026-02-01').product?.id).toBe('b')
  })
})

describe('计价依据', () => {
  it('某一项只要有入库批次就只按批次，价格版本被标为不参与；没有批次按价格版本', () => {
    const versions = [
      lite({ id: 'price', product: 10 }),
      lite({ id: 'batch', source: 'PURCHASE_RECEIPT', product: 9, quantity: 100, effectiveFrom: '2026-02-01' }),
      lite({ id: 'fm', source: 'FIRST_MILE_ALLOCATION', product: null, firstMile: 1, quantity: 0 }),
      lite({ id: 'draft', status: 'DRAFT', product: 1, duty: 2 }),
    ]
    const { basis, ignored } = pricingOf(versions)
    expect(basis).toEqual({ product: 'BATCH', firstMile: 'PRICE', duty: null, other: null })
    expect(ignored.get('price')).toEqual(['product'])
    expect(ignored.has('batch')).toBe(false)
  })
})

describe('确认生效的替换规则', () => {
  const draft = lite({ id: 'd', versionNo: 3, status: 'DRAFT', product: 12 })

  it('同一生效日已有生效的价格版本：被替换；生效日不同或来源是入库批次：不替换', () => {
    const same = lite({ id: 'old' })
    const other = lite({ id: 'other', effectiveFrom: '2026-02-01' })
    const batch = lite({ id: 'batch', source: 'PURCHASE_RECEIPT', quantity: 5 })
    const plan = planActivation(draft, [same, other, batch])
    expect(plan).toMatchObject({ ok: true })
    expect(plan.ok && plan.replaces.map(item => item.id)).toEqual(['old'])
    const batchDraft = lite({ id: 'bd', status: 'DRAFT', source: 'PURCHASE_RECEIPT', quantity: 5 })
    expect(planActivation(batchDraft, [same])).toEqual({ ok: true, replaces: [] })
  })

  it('旧版本带有新版本没有的成本项：拒绝，不悄悄丢掉', () => {
    const old = lite({ id: 'old', firstMile: 1 })
    const plan = planActivation(draft, [old])
    expect(plan.ok).toBe(false)
    expect(!plan.ok && plan.reason).toContain('头程分摊')
    expect(planActivation(lite({ ...draft, firstMile: 2 }), [old])).toMatchObject({ ok: true })
  })

  it('只有草稿可以生效；一项成本都没有拒绝', () => {
    expect(planActivation(lite(), [])).toMatchObject({ ok: false })
    expect(planActivation(lite({ status: 'DRAFT', product: null }), [])).toMatchObject({ ok: false })
  })
})

describe('覆盖状态与折算', () => {
  it('有生效采购单价：按最新生效日距今判断过期；没有则看草稿', () => {
    expect(coverageOf({ productEffectiveFrom: '2026-06-01', hasDraft: false, today: '2026-06-02' })).toBe('COVERED')
    const stale = new Date(Date.parse('2026-06-01T00:00:00Z') + (COST_STALE_DAYS + 1) * 86_400_000).toISOString().slice(0, 10)
    expect(coverageOf({ productEffectiveFrom: '2026-06-01', hasDraft: false, today: stale })).toBe('STALE')
    expect(coverageOf({ productEffectiveFrom: null, hasDraft: true, today: stale })).toBe('DRAFT_ONLY')
    expect(coverageOf({ productEffectiveFrom: null, hasDraft: false, today: stale })).toBe('MISSING')
  })

  it('折合美元：美元不需要汇率；汇率是 1 美元折合多少外币；没有汇率不给', () => {
    expect(toUsd(10, 'USD', null)).toBe(10)
    expect(toUsd(71, 'CNY', 7.1)).toBe(10)
    expect(toUsd(71, 'CNY', null)).toBeNull()
    expect(toUsd(71, 'CNY', 0)).toBeNull()
  })

  it('到岸成本：各项折合美元相加；没有采购单价或缺汇率不给合计', () => {
    expect(landedOf({ product: { usd: 10 }, firstMile: { usd: 1.5 }, duty: null, other: { usd: 0.5 } })).toEqual({ usd: 12, state: 'OK' })
    expect(landedOf({ product: null, firstMile: { usd: 1 }, duty: null, other: null })).toEqual({ usd: null, state: 'NO_PRODUCT' })
    expect(landedOf({ product: { usd: 10 }, firstMile: { usd: null }, duty: null, other: null })).toEqual({ usd: null, state: 'NO_FX' })
    expect(landedOf({ product: null, firstMile: null, duty: null, other: null })).toEqual({ usd: null, state: 'NO_DATA' })
  })
})

describe('版本对比', () => {
  const rate = (code: string) => (code === 'CNY' ? 7 : code === 'USD' ? 1 : null)

  it('同币种给差额与百分比；某一项只有一边有也列出', () => {
    const rows = compareVersions(lite({ product: 10 }), lite({ id: 'b', versionNo: 2, product: 12.5, duty: 1 }), rate)
    expect(rows[0]).toMatchObject({ component: 'product', a: '10', b: '12.5', delta: 2.5, deltaPct: 0.25, usdDelta: 2.5 })
    expect(rows[1]).toMatchObject({ component: 'duty', a: null, b: '1', delta: null, deltaPct: null, usdDelta: null })
    expect(rows).toHaveLength(2)
  })

  it('币种不同不给差额，只给折合美元的差额', () => {
    const rows = compareVersions(lite({ product: 10 }), lite({ id: 'b', currency: 'CNY', product: 70 }), rate)
    expect(rows[0]).toMatchObject({ delta: null, deltaPct: null, usdDelta: 0 })
    expect(compareVersions(lite(), lite({ currency: 'JPY' }), rate)[0]?.usdDelta).toBeNull()
  })
})

describe('库存成本估算', () => {
  const batch = (date: string, qty: number, usd: number): StockLayer => ({ date, qty, usd })

  it('先进先出：库存是最新的几批；移动与月末加权：全部批次加权平均；批次件数不够的部分没有成本', () => {
    const layers = [batch('2026-01-01', 100, 8), batch('2026-03-01', 50, 12)]
    expect(estimateStream('FIFO', layers, 60, '2026-06-01')).toMatchObject({ basis: 'BATCH', value: 50 * 12 + 10 * 8, covered: 60, uncovered: 0 })
    const average = (8 * 100 + 12 * 50) / 150
    expect(estimateStream('MOVING_AVG', layers, 60, '2026-06-01').value).toBeCloseTo(60 * average, 5)
    expect(estimateStream('MONTH_AVG', layers, 60, '2026-06-01').value).toBeCloseTo(60 * average, 5)
    expect(estimateStream('FIFO', layers, 200, '2026-06-01')).toMatchObject({ covered: 150, uncovered: 50 })
  })

  it('没有批次用今天适用的价格版本单价；没有任何成本是 null 基础', () => {
    const prices: StockLayer[] = [
      { date: '2026-01-01', qty: null, usd: 10 },
      { date: '2026-03-01', qty: null, usd: 11 },
      { date: '2026-12-01', qty: null, usd: 99 },
    ]
    expect(estimateStream('FIFO', prices, 5, '2026-06-01')).toMatchObject({ basis: 'PRICE', value: 55, uncovered: 0 })
    expect(estimateStream('FIFO', [], 5, '2026-06-01')).toMatchObject({ basis: null, uncovered: 5 })
  })

  it('整体：采购单价必须有，缺它不估算；四项估值相加；库存为 0 成本为 0', () => {
    const empty = { product: [], firstMile: [], duty: [], other: [] }
    expect(estimateInventory('FIFO', { ...empty, firstMile: [{ date: '2026-01-01', qty: null, usd: 1 }] }, 10, '2026-06-01')).toEqual({ valueUsd: null, uncoveredUnits: 10, avgUnitUsd: null })
    const streams = { product: [{ date: '2026-01-01', qty: null, usd: 10 }], firstMile: [{ date: '2026-01-01', qty: null, usd: 1.5 }], duty: [], other: [] }
    expect(estimateInventory('FIFO', streams, 10, '2026-06-01')).toMatchObject({ valueUsd: 115, avgUnitUsd: 11.5 })
    expect(estimateInventory('FIFO', streams, 0, '2026-06-01')).toMatchObject({ valueUsd: 0 })
  })
})

describe('请求校验', () => {
  const body = { sku: ' SKU-1 ', effectiveFrom: '2026-05-01', currency: 'cny', unitProductCost: 12.5 }

  it('新建：去空格、币种转大写、成本四项至少一项、非负、最多六位小数、日期必须真实存在', () => {
    expect(CostVersionCreateBodySchema.parse(body)).toMatchObject({ sku: 'SKU-1', currency: 'CNY', unitProductCost: 12.5 })
    for (const bad of [
      { unitProductCost: undefined },
      { unitProductCost: -1 },
      { unitProductCost: 0.1234567 },
      { effectiveFrom: '2026-02-30' },
      { currency: 'RMB1' },
      { sku: '' },
      { extra: true },
      { note: 'x'.repeat(301) },
    ]) {
      expect(CostVersionCreateBodySchema.safeParse({ ...body, ...bad }).success).toBe(false)
    }
    expect(CostVersionCreateBodySchema.safeParse({ ...body, unitProductCost: undefined, unitDutyCost: 0 }).success).toBe(true)
    expect(CostVersionCreateBodySchema.safeParse({ ...body, unitProductCost: 0 }).success).toBe(true)
  })

  it('改草稿：必须带版本号且至少改一项；写 null 是清空', () => {
    expect(CostVersionUpdateBodySchema.safeParse({ version: 1 }).success).toBe(false)
    expect(CostVersionUpdateBodySchema.safeParse({ note: 'x' }).success).toBe(false)
    expect(CostVersionUpdateBodySchema.parse({ version: 1, unitDutyCost: null })).toEqual({ version: 1, unitDutyCost: null })
  })

  it('批量生效：一到一百个、不重复；列表的筛选与排序白名单', () => {
    expect(CostActivateBodySchema.safeParse({ items: [] }).success).toBe(false)
    expect(
      CostActivateBodySchema.safeParse({
        items: [
          { id: 'a', version: 1 },
          { id: 'a', version: 2 },
        ],
      }).success,
    ).toBe(false)
    expect(CostActivateBodySchema.safeParse({ items: [{ id: 'a', version: 1 }] }).success).toBe(true)
    expect(CostListQuerySchema.safeParse({ coverage: 'STALE', draft: 'true' }).success).toBe(true)
    expect(CostListQuerySchema.safeParse({ coverage: 'NOPE' }).success).toBe(false)
    expect(CostListQuerySchema.safeParse({ sort: 'title' }).success).toBe(false)
  })
})
