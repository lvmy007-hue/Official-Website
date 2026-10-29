import { describe, expect, it, vi } from 'vitest'
import { groupIssues, isSearchSuppressed, newListingIssueEvaluator, searchSuppressedEvaluator, type IssueRow } from './listing-issue-evaluators'

// 刊登问题预警（P4-15）：新增问题与被搜索抑制两个口径互不重复、按 店铺 × SKU 合并、窗口与阈值写进查询、没有商品记录时按店铺|SKU 登记。

const at = (day: string) => new Date(`${day}T00:00:00Z`)
const issue = (over: Partial<IssueRow> = {}): IssueRow => ({
  sellerAccountId: 's1',
  sellerSku: 'SKU-A',
  asin: 'B0A',
  issueKind: 'ISSUE',
  issueCode: '90220',
  attributeName: 'color',
  severity: 'ERROR',
  impact: 'NONE',
  message: '缺少颜色',
  firstSeenAt: at('2026-10-24'),
  ...over,
})

describe('isSearchSuppressed', () => {
  it('问题类型是搜索抑制，或执法动作是搜索抑制；其他影响（属性抑制、刊登抑制、无）不算', () => {
    expect(isSearchSuppressed({ issueKind: 'SEARCH_SUPPRESSED', impact: 'NONE' })).toBe(true)
    expect(isSearchSuppressed({ issueKind: 'ISSUE', impact: 'SEARCH_SUPPRESSED' })).toBe(true)
    expect(isSearchSuppressed({ issueKind: 'ISSUE', impact: 'LISTING_SUPPRESSED' })).toBe(false)
    expect(isSearchSuppressed({ issueKind: 'COMPLIANCE', impact: 'ATTRIBUTE_SUPPRESSED' })).toBe(false)
  })
})

describe('groupIssues', () => {
  it('同一店铺同一 SKU 合并；错误多的排前面，其次问题多的；组内按首次发现时间从早到晚；带上首个非空 ASIN 与最早时间', () => {
    const groups = groupIssues([
      issue({ sellerSku: 'B', asin: '', severity: 'WARNING', issueCode: '2' }),
      issue({ sellerSku: 'A', issueCode: '9', firstSeenAt: at('2026-10-24') }),
      issue({ sellerSku: 'A', issueCode: '1', firstSeenAt: at('2026-10-22') }),
      issue({ sellerSku: 'B', asin: 'B0B', severity: 'WARNING', issueCode: '3' }),
      issue({ sellerSku: 'C', severity: 'WARNING' }),
    ])
    expect(groups.map(group => group.sellerSku)).toEqual(['A', 'B', 'C'])
    expect(groups[0]).toMatchObject({ errorCount: 2, firstSeenAt: at('2026-10-22') })
    expect(groups[0].issues.map(item => item.issueCode)).toEqual(['1', '9'])
    expect(groups[1].asin).toBe('B0B')
  })

  it('不同店铺的同名 SKU 不合并', () => {
    expect(groupIssues([issue({ sellerAccountId: 's1' }), issue({ sellerAccountId: 's2' })])).toHaveLength(2)
  })
})

describe('评估器', () => {
  const rule = (type: string, params: Record<string, unknown> = {}, scope: Record<string, unknown> = {}) => ({
    id: 'r',
    code: 'X',
    domain: 'PRODUCT',
    name: 'n',
    severity: 'WARNING',
    cooldownMinutes: 1,
    currentVersion: 1,
    condition: { type, params },
    scope,
  })
  const now = new Date('2026-10-25T08:00:00Z')
  const makeDb = (rows: IssueRow[], products: Array<Record<string, unknown>> = [{ id: 'prod-A', sellerAccountId: 's1', sellerSku: 'SKU-A', asin: 'B0A', title: '示例商品' }]) => ({
    listingIssue: { findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => rows) },
    fbaProduct: { findMany: vi.fn(async () => products) },
    sellerAccount: { findMany: vi.fn(async () => [{ id: 's1', displayName: '一店' }]) },
  })

  it('新增问题：窗口（默认 3 天）、严重度（默认只看错误）、类型与“不含搜索抑制影响”都写进查询', async () => {
    const db = makeDb([issue(), issue({ issueCode: '2' })])
    const hits = await newListingIssueEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule('listing.issue-new'), now })
    const where = db.listingIssue.findMany.mock.calls[0][0].where as Record<string, unknown>
    expect(where).toMatchObject({ tenantId: 't1', resolvedAt: null, severity: { in: ['ERROR'] }, issueKind: { in: ['ISSUE', 'COMPLIANCE'] }, impact: { not: 'SEARCH_SUPPRESSED' } })
    expect((where.firstSeenAt as { gte: Date }).gte.toISOString()).toBe('2026-10-22T08:00:00.000Z')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ entityType: 'ASIN', entityId: 'prod-A', sellerAccountId: 's1', entityLabel: 'SKU-A（一店）' })
    expect(hits[0].title).toBe('SKU SKU-A 近 3 天新增 2 个刊登问题（其中 2 个错误）')
    expect(hits[0].evidence).toMatchObject({ sku: 'SKU-A', asin: 'B0A', title: '示例商品', issueCount: 2, errorCount: 2, storeName: '一店' })
    expect(hits[0].impact).toBeUndefined()
  })

  it('新增问题：阈值可改（窗口夹在 1 到 30、严重度加入警告）；读出来仍是搜索抑制的行即使数据库条件漏掉也被排除；范围写进查询', async () => {
    const db = makeDb([issue({ impact: 'SEARCH_SUPPRESSED' }), issue({ sellerSku: 'SKU-B', severity: 'WARNING' })], [])
    const hits = await newListingIssueEvaluator.evaluate({
      db: db as never,
      tenantId: 't1',
      rule: rule('listing.issue-new', { windowDays: 99, severities: ['ERROR', 'WARNING', 'BOGUS'] }, { sellerAccountIds: ['s1'], skus: ['SKU-A', 'SKU-B'] }),
      now,
    })
    const where = db.listingIssue.findMany.mock.calls[0][0].where as Record<string, unknown>
    expect(where).toMatchObject({ severity: { in: ['ERROR', 'WARNING'] }, sellerAccountId: { in: ['s1'] }, sellerSku: { in: ['SKU-A', 'SKU-B'] } })
    expect((where.firstSeenAt as { gte: Date }).gte.toISOString()).toBe('2026-09-25T08:00:00.000Z')
    expect(hits).toHaveLength(1)
    // 没有商品记录：按店铺|SKU 登记，不编造链接
    expect(hits[0]).toMatchObject({ entityType: 'LISTING_SKU', entityId: 's1|SKU-B' })
    expect(hits[0].title).toBe('SKU SKU-B 近 30 天新增 1 个刊登问题')
  })

  it('新增问题：没有命中时不查商品与店铺', async () => {
    const db = makeDb([])
    expect(await newListingIssueEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule('listing.issue-new'), now })).toEqual([])
    expect(db.fbaProduct.findMany).not.toHaveBeenCalled()
  })

  it('被搜索抑制：只取还没解决的搜索抑制问题（两种口径）；不限首次发现时间；标题写明已持续几天；证据带影响的中文名', async () => {
    const db = makeDb([
      issue({ issueKind: 'SEARCH_SUPPRESSED', impact: 'SEARCH_SUPPRESSED', severity: 'ERROR', firstSeenAt: at('2026-10-15'), issueCode: 'FYP', attributeName: '' }),
      issue({ issueCode: 'noise', impact: 'NONE' }),
    ])
    const hits = await searchSuppressedEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule('listing.search-suppressed'), now })
    const where = db.listingIssue.findMany.mock.calls[0][0].where as Record<string, unknown>
    expect(where).toMatchObject({ resolvedAt: null, OR: [{ issueKind: 'SEARCH_SUPPRESSED' }, { impact: 'SEARCH_SUPPRESSED' }] })
    expect(where).not.toHaveProperty('firstSeenAt')
    expect(hits).toHaveLength(1)
    expect(hits[0].title).toBe('SKU SKU-A 被搜索抑制，自 2026-10-15 起已 10 天（1 个问题）')
    expect(hits[0].evidence).toMatchObject({ issueCount: 1, openDays: 10, issues: [{ code: 'FYP', attribute: null, impact: 'SEARCH_SUPPRESSED', impactLabel: '被搜索抑制' }] })
  })
})
