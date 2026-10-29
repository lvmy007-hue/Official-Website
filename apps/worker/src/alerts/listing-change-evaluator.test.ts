import { describe, expect, it, vi } from 'vitest'
import { contentChangedByOthersEvaluator, groupChanges, type ChangeRow } from './listing-change-evaluator'

// 详情页被他人修改预警（P4-15）：只看内容变更、修改人在阈值范围内、窗口写进查询、他人修改排前面、没有 SKU 的事件按 ASIN 合并。

const at = (text: string) => new Date(text)
const change = (over: Partial<ChangeRow> = {}): ChangeRow => ({
  sellerAccountId: 's1',
  sellerSku: 'SKU-A',
  asin: 'B0A',
  fieldPath: 'item_name',
  beforeText: '旧标题',
  afterText: '新标题',
  actorKind: 'UNKNOWN',
  occurredAt: at('2026-10-24T01:00:00Z'),
  ...over,
})

describe('groupChanges', () => {
  it('同一 SKU 合并，组内最近的在前；有“他人”修改的组排前面，其次最近的在前', () => {
    const groups = groupChanges([
      change({ sellerSku: 'B', occurredAt: at('2026-10-24T05:00:00Z') }),
      change({ sellerSku: 'A', fieldPath: 'main_image', actorKind: 'OTHER', occurredAt: at('2026-10-23T05:00:00Z') }),
      change({ sellerSku: 'A', occurredAt: at('2026-10-24T01:00:00Z') }),
    ])
    expect(groups.map(group => group.sellerSku)).toEqual(['A', 'B'])
    expect(groups[0]).toMatchObject({ byOthers: true, lastAt: at('2026-10-24T01:00:00Z') })
    expect(groups[0].changes.map(item => item.fieldPath)).toEqual(['item_name', 'main_image'])
    expect(groups[1].byOthers).toBe(false)
  })

  it('没有 SKU 的事件按 ASIN 合并，不与有 SKU 的混在一起', () => {
    const groups = groupChanges([change({ sellerSku: '', asin: 'B0X' }), change({ sellerSku: '', asin: 'B0X', fieldPath: 'main_image' }), change({ sellerSku: '', asin: 'B0Y' }), change()])
    expect(groups).toHaveLength(3)
    expect(groups.find(group => group.asin === 'B0X')?.changes).toHaveLength(2)
  })
})

describe('评估器', () => {
  const rule = (params: Record<string, unknown> = {}, scope: Record<string, unknown> = {}) => ({
    id: 'r',
    code: 'PRD_CONTENT_CHANGED_BY_OTHERS',
    domain: 'PRODUCT',
    name: '详情页被他人修改',
    severity: 'WARNING',
    cooldownMinutes: 4320,
    currentVersion: 1,
    condition: { type: 'listing.content-changed-by-others', params },
    scope,
  })
  const now = new Date('2026-10-25T08:00:00Z')
  const makeDb = (rows: ChangeRow[], products: Array<Record<string, unknown>> = [{ id: 'prod-A', sellerAccountId: 's1', sellerSku: 'SKU-A', asin: 'B0A', title: '示例商品' }]) => ({
    listingChangeEvent: { findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => rows) },
    fbaProduct: { findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => products) },
    sellerAccount: { findMany: vi.fn(async () => [{ id: 's1', displayName: '一店' }]) },
  })

  it('命中：只查内容变更、修改人默认“他人”与“未知”、窗口默认 3 天；链到商品全景；标题写明修改的字段与来源；证据带前后文字', async () => {
    const db = makeDb([change({ actorKind: 'OTHER' }), change({ fieldPath: 'main_image', beforeText: 'a.jpg', afterText: 'b.jpg' })])
    const hits = await contentChangedByOthersEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule(), now })
    const where = db.listingChangeEvent.findMany.mock.calls[0][0].where as Record<string, unknown>
    expect(where).toMatchObject({ tenantId: 't1', changeKind: 'CONTENT_CHANGE', actorKind: { in: ['OTHER', 'UNKNOWN'] } })
    expect((where.occurredAt as { gte: Date }).gte.toISOString()).toBe('2026-10-22T08:00:00.000Z')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ entityType: 'ASIN', entityId: 'prod-A', entityLabel: 'SKU-A（一店）' })
    expect(hits[0].title).toBe('SKU SKU-A 的标题、主图近 3 天被他人修改')
    expect(hits[0].suggestedAction).toContain('不是你们授权')
    expect(hits[0].evidence).toMatchObject({ byOthers: true, changeCount: 2, title: '示例商品' })
    expect(hits[0].evidence.changes).toMatchObject([
      { field: 'item_name', before: '旧标题', after: '新标题', actorLabel: '他人' },
      { field: 'main_image', actorLabel: '未知' },
    ])
  })

  it('只有“未知”来源时标题写“未知来源”，建议先确认是不是自己人改的', async () => {
    const hits = await contentChangedByOthersEvaluator.evaluate({ db: makeDb([change()]) as never, tenantId: 't1', rule: rule(), now })
    expect(hits[0].title).toBe('SKU SKU-A 的标题近 3 天被未知来源修改')
    expect(hits[0].suggestedAction).toContain('先确认是不是团队成员')
  })

  it('去掉“未知”只看他人；窗口夹在 1 到 30；SKU 与店铺范围写进查询；不合法的修改人被忽略', async () => {
    const db = makeDb([])
    await contentChangedByOthersEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule({ actors: ['OTHER', 'SELF'], windowDays: 0 }, { sellerAccountIds: ['s1'], skus: ['SKU-A'] }), now })
    const where = db.listingChangeEvent.findMany.mock.calls[0][0].where as Record<string, unknown>
    expect(where).toMatchObject({ actorKind: { in: ['OTHER'] }, sellerAccountId: { in: ['s1'] }, sellerSku: { in: ['SKU-A'] } })
    expect((where.occurredAt as { gte: Date }).gte.toISOString()).toBe('2026-10-24T08:00:00.000Z')
    expect(db.fbaProduct.findMany).not.toHaveBeenCalled()
  })

  it('没有 SKU 的事件按 ASIN 找商品；找不到商品时按店铺|键登记', async () => {
    const db = makeDb([change({ sellerSku: '', asin: 'B0A' }), change({ sellerSku: '', asin: 'B0Z' })])
    const hits = await contentChangedByOthersEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule(), now })
    expect(hits).toHaveLength(2)
    const found = hits.find(hit => hit.entityLabel === 'B0A（一店）')
    expect(found).toMatchObject({ entityType: 'ASIN', entityId: 'prod-A' })
    expect(found?.title).toBe('ASIN B0A 的标题近 3 天被未知来源修改')
    expect(hits.find(hit => hit.entityLabel === 'B0Z（一店）')).toMatchObject({ entityType: 'LISTING_SKU', entityId: 's1|asin:B0Z' })
  })
})
