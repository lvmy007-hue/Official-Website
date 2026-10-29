import { describe, expect, it } from 'vitest'
import { EXPORT_KINDS } from './exports'
import { PRODUCT_EXPORT_KIND, PRODUCT_SORTS, PRODUCT_TAG_LIMITS, describeProductFilters, productFilterWhere, productMargin, productMarginState, productTagProblem } from './product-list'
import { ProductListQuerySchema, ProductMetaBatchBodySchema, ProductSyncBodySchema } from './product-list-query'

describe('productFilterWhere', () => {
  it('没有筛选时是空条件；各条件进同一个 AND', () => {
    expect(productFilterWhere({})).toEqual({})
    const where = productFilterWhere({ asin: 'b0abc', sku: 'sku-1', brand: 'Acme', status: 'ACTIVE', fulfillment: 'AFN', ownerId: 'u1', tag: '新品', parentAsin: 'B0PARENT01', category: 'Home' }) as {
      AND: unknown[]
    }
    const text = JSON.stringify(where.AND)
    expect(text).toContain('"startsWith":"B0ABC"')
    expect(text).toContain('sku-1')
    expect(text).toContain('Acme')
    expect(text).toContain('新品')
    expect(where.AND.length).toBe(9)
  })

  it('搜索：ASIN 前缀（转大写）、SKU 与 FNSKU 前缀、标题包含', () => {
    const { AND } = productFilterWhere({ q: 'abc' }) as { AND: Array<{ OR: unknown[] }> }
    expect(AND[0].OR).toHaveLength(4)
    expect(JSON.stringify(AND[0].OR)).toContain('"startsWith":"ABC"')
  })
})

describe('利润率与状态', () => {
  it('销售额不为正或利润未知时没有利润率；四舍五入到六位', () => {
    expect(productMargin(25, 100)).toBe(0.25)
    expect(productMargin(null, 100)).toBeNull()
    expect(productMargin(5, 0)).toBeNull()
    expect(productMargin(-3, -1)).toBeNull()
    expect(productMargin(1, 3)).toBe(0.333333)
  })
  it('状态：没有记录、缺成本、没有销售额、可算', () => {
    expect(productMarginState({ rows: 0, revenue: 0, profit: null })).toBe('NO_RECORD')
    expect(productMarginState({ rows: 2, revenue: 10, profit: null })).toBe('COST_MISSING')
    expect(productMarginState({ rows: 2, revenue: 0, profit: -1 })).toBe('NO_SALES')
    expect(productMarginState({ rows: 2, revenue: 10, profit: 1 })).toBe('OK')
  })
})

describe('标签与筛选摘要', () => {
  it('标签：条数、长度、逗号与控制字符', () => {
    expect(productTagProblem(['新品'])).toBeNull()
    expect(productTagProblem(Array.from({ length: PRODUCT_TAG_LIMITS.MAX_TAGS + 1 }, (_, i) => `t${i}`))).toContain('最多')
    expect(productTagProblem(['x'.repeat(PRODUCT_TAG_LIMITS.MAX_LENGTH + 1)])).toContain('超过')
    expect(productTagProblem(['a,b'])).toContain('逗号')
    expect(productTagProblem(['a，b'])).toContain('逗号')
  })
  it('摘要只写有值的条件', () => {
    expect(describeProductFilters({})).toBe('全部商品')
    expect(describeProductFilters({ brand: 'Acme', status: 'ACTIVE' })).toBe('品牌 Acme，状态 在售')
  })
})

describe('请求校验', () => {
  it('列表：默认按更新时间倒序；排序白名单；筛选取值', () => {
    expect(ProductListQuerySchema.parse({}).sort).toEqual({ field: 'updatedAt', dir: 'desc' })
    for (const field of PRODUCT_SORTS) expect(ProductListQuerySchema.safeParse({ sort: `${field}:asc` }).success, field).toBe(true)
    expect(ProductListQuerySchema.safeParse({ sort: 'password:asc' }).success).toBe(false)
    expect(ProductListQuerySchema.safeParse({ fulfillment: 'X' }).success).toBe(false)
    expect(ProductListQuerySchema.safeParse({ risk: 'HIGH', watched: 'true' }).success).toBe(true)
    expect(ProductListQuerySchema.safeParse({ risk: 'SEVERE' }).success).toBe(false)
  })

  it('批量设置：至少改一项、版本必填、最多 200 个、模式白名单、不许多余字段', () => {
    const item = { id: 'p1', version: 1 }
    expect(ProductMetaBatchBodySchema.safeParse({ items: [item], ownerId: null }).success).toBe(true)
    expect(ProductMetaBatchBodySchema.safeParse({ items: [item], tags: { mode: 'SET', values: [] } }).success).toBe(true)
    expect(ProductMetaBatchBodySchema.safeParse({ items: [item] }).success).toBe(false)
    expect(ProductMetaBatchBodySchema.safeParse({ items: [{ id: 'p1' }], ownerId: null }).success).toBe(false)
    expect(ProductMetaBatchBodySchema.safeParse({ items: Array.from({ length: 201 }, (_, i) => ({ id: `p${i}`, version: 1 })), ownerId: null }).success).toBe(false)
    expect(ProductMetaBatchBodySchema.safeParse({ items: [item], tags: { mode: 'DROP', values: [] } }).success).toBe(false)
    expect(ProductMetaBatchBodySchema.safeParse({ items: [item], ownerId: null, extra: 1 }).success).toBe(false)
  })

  it('同步：1 到 50 个店铺', () => {
    expect(ProductSyncBodySchema.safeParse({ storeIds: ['s1'] }).success).toBe(true)
    expect(ProductSyncBodySchema.safeParse({ storeIds: [] }).success).toBe(false)
    expect(ProductSyncBodySchema.safeParse({ storeIds: Array.from({ length: 51 }, (_, i) => `s${i}`) }).success).toBe(false)
  })
})

describe('导出类型', () => {
  it('商品主数据已登记：来源页与权限正确，不含销售、利润与库存列', () => {
    const spec = EXPORT_KINDS.find(item => item.kind === PRODUCT_EXPORT_KIND)
    expect(spec).toMatchObject({ sourcePage: '/app/products', permission: 'products.read' })
    const keys = spec?.columns.map(column => column.key) ?? []
    expect(keys).toEqual(expect.arrayContaining(['asin', 'sellerSku', 'ownerName', 'tags']))
    for (const forbidden of ['sales30', 'profit', 'margin', 'sellable', 'stock']) expect(keys).not.toContain(forbidden)
  })
})
