import { describe, expect, it } from 'vitest'
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, PageParamsSchema, ScopeQuerySchema, canonicalize, cursorListQuery, formatSortParam, pageListQuery, parseSortParam, queryConditions } from './query.js'
import { US_MARKETPLACE_ID } from './scope-search.js'

describe('范围参数', () => {
  it('缺省值：美国站、不对比、美元口径', () => {
    expect(ScopeQuerySchema.parse({})).toEqual({ marketplaceId: US_MARKETPLACE_ID, compare: 'none', displayCurrency: 'USD' })
  })

  it('站点只接受美国站', () => {
    const result = ScopeQuerySchema.safeParse({ marketplaceId: 'A1F83G8C2ARO7P' })
    expect(result.success).toBe(false)
  })

  it('多选编号按逗号拆分，拒绝非法字符与超量', () => {
    expect(ScopeQuerySchema.parse({ storeIds: 's1, s2,,s3' }).storeIds).toEqual(['s1', 's2', 's3'])
    expect(ScopeQuerySchema.safeParse({ storeIds: 's1;drop table' }).success).toBe(false)
    const many = Array.from({ length: 101 }, (_, i) => `s${i}`).join(',')
    expect(ScopeQuerySchema.safeParse({ storeIds: many }).success).toBe(false)
  })

  it('时间范围：成对出现、顺序正确、日期真实存在、不超上限', () => {
    expect(ScopeQuerySchema.safeParse({ from: '2026-01-01' }).success).toBe(false)
    expect(ScopeQuerySchema.safeParse({ from: '2026-02-01', to: '2026-01-01' }).success).toBe(false)
    expect(ScopeQuerySchema.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success).toBe(false)
    expect(ScopeQuerySchema.safeParse({ from: '2020-01-01', to: '2026-01-01' }).success).toBe(false)
    expect(ScopeQuerySchema.safeParse({ from: '2026-01-01', to: '2026-01-31' }).success).toBe(true)
  })

  it('对比期：自定义需要日期，非自定义不允许带日期，对比前需有时间范围', () => {
    const base = { from: '2026-01-01', to: '2026-01-31' }
    expect(ScopeQuerySchema.safeParse({ ...base, compare: 'custom' }).success).toBe(false)
    expect(ScopeQuerySchema.safeParse({ ...base, compare: 'custom', compareFrom: '2025-01-01', compareTo: '2025-01-31' }).success).toBe(true)
    expect(ScopeQuerySchema.safeParse({ ...base, compare: 'previous', compareFrom: '2025-01-01', compareTo: '2025-01-31' }).success).toBe(false)
    expect(ScopeQuerySchema.safeParse({ compare: 'yoy' }).success).toBe(false)
    expect(ScopeQuerySchema.safeParse({ ...base, compare: 'yoy' }).success).toBe(true)
  })

  it('未知参数被拒绝', () => {
    expect(ScopeQuerySchema.safeParse({ unknown: '1' }).success).toBe(false)
  })
})

describe('页码分页', () => {
  it('默认 50，上限 200', () => {
    expect(PageParamsSchema.parse({})).toEqual({ page: 1, pageSize: PAGE_SIZE_DEFAULT })
    expect(PageParamsSchema.parse({ pageSize: String(PAGE_SIZE_MAX) }).pageSize).toBe(200)
    expect(PageParamsSchema.safeParse({ pageSize: '201' }).success).toBe(false)
    expect(PageParamsSchema.safeParse({ pageSize: '0' }).success).toBe(false)
    expect(PageParamsSchema.safeParse({ page: '0' }).success).toBe(false)
    expect(PageParamsSchema.safeParse({ page: '1.5' }).success).toBe(false)
  })
})

describe('排序参数', () => {
  it('解析与还原', () => {
    expect(parseSortParam('createdAt:desc')).toEqual({ field: 'createdAt', dir: 'desc' })
    expect(parseSortParam('name')).toEqual({ field: 'name', dir: 'asc' })
    expect(parseSortParam('name:up')).toBeNull()
    expect(parseSortParam('a;b')).toBeNull()
    expect(formatSortParam({ field: 'name', dir: 'desc' })).toBe('name:desc')
  })
})

describe('列表查询构造器', () => {
  const schema = pageListQuery({
    sortable: ['createdAt', 'name'] as const,
    defaultSort: { field: 'createdAt', dir: 'desc' },
    filters: {
      status: { type: 'enum', values: ['OPEN', 'CLOSED'] },
      tags: { type: 'enum', values: ['A', 'B', 'C'], multiple: true },
      onlyActive: { type: 'bool' },
      minQty: { type: 'number', min: 0 },
    },
  })

  it('缺省值与类型转换', () => {
    const parsed = schema.parse({ status: 'OPEN', tags: 'A,B', onlyActive: 'true', minQty: '3', sort: 'name:asc', q: ' abc ' })
    expect(parsed).toMatchObject({ page: 1, pageSize: 50, status: 'OPEN', tags: ['A', 'B'], onlyActive: true, minQty: 3, q: 'abc', sort: { field: 'name', dir: 'asc' } })
    expect(schema.parse({}).sort).toEqual({ field: 'createdAt', dir: 'desc' })
  })

  it('排序字段不在白名单被拒绝', () => {
    const result = schema.safeParse({ sort: 'secret:asc' })
    expect(result.success).toBe(false)
  })

  it('筛选取值非法、未知参数、范围不合法都被拒绝', () => {
    expect(schema.safeParse({ status: 'DELETED' }).success).toBe(false)
    expect(schema.safeParse({ tags: 'A,Z' }).success).toBe(false)
    expect(schema.safeParse({ minQty: '-1' }).success).toBe(false)
    expect(schema.safeParse({ nonsense: '1' }).success).toBe(false)
    expect(schema.safeParse({ from: '2026-01-01' }).success).toBe(false)
    expect(schema.safeParse({ pageSize: '500' }).success).toBe(false)
  })

  it('关闭范围参数后不接受范围字段', () => {
    const noScope = pageListQuery({ sortable: ['name'] as const, defaultSort: { field: 'name', dir: 'asc' }, scope: false })
    expect(noScope.safeParse({ storeIds: 's1' }).success).toBe(false)
    expect(noScope.safeParse({ q: 'x' }).success).toBe(true)
  })

  it('游标版本使用 cursor 而不是 page', () => {
    const cursor = cursorListQuery({ sortable: ['createdAt'] as const, defaultSort: { field: 'createdAt', dir: 'desc' } })
    expect(cursor.parse({ cursor: 'abc' })).toMatchObject({ cursor: 'abc', pageSize: 50 })
    expect(cursor.safeParse({ page: '2' }).success).toBe(false)
  })
})

describe('查询条件摘要', () => {
  it('忽略分页参数，键顺序不影响结果', () => {
    const a = queryConditions({ q: 'x', storeIds: ['s1'], page: 3, pageSize: 50, cursor: 'c' })
    const b = queryConditions({ storeIds: ['s1'], q: 'x' })
    expect(canonicalize(a)).toBe(canonicalize(b))
    expect(canonicalize(queryConditions({ q: 'y' }))).not.toBe(canonicalize(a))
  })
})
