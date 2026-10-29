import { describe, expect, it } from 'vitest'
import { averageResolveHours, estimateIssueImpact, listingAdviceOf, listingImpactOf, listingIssueStatusOf, listingStatusOfSummary } from './listing-quality.js'
import { buildListingsFeed, listingAmazonPatches, listingFailureText, listingPatchIssue, listingPatchesIssue, listingPatchesText } from './listing-quality-write.js'

const day = (value: string) => new Date(`${value}T08:00:00Z`)

describe('刊登质量：影响与状态', () => {
  it('多个执法动作取最重的一个，认不出的按无影响', () => {
    expect(listingImpactOf([])).toBe('NONE')
    expect(listingImpactOf(['ATTRIBUTE_SUPPRESSED', 'SEARCH_SUPPRESSED'])).toBe('SEARCH_SUPPRESSED')
    expect(listingImpactOf(['SEARCH_SUPPRESSED', 'LISTING_SUPPRESSED', 'ATTRIBUTE_SUPPRESSED'])).toBe('LISTING_SUPPRESSED')
    expect(listingImpactOf(['SOMETHING_NEW'])).toBe('NONE')
  })

  it('刊登状态：含 BUYABLE 才是活跃，空数组与仅可发现都是非活跃', () => {
    expect(listingStatusOfSummary(['BUYABLE', 'DISCOVERABLE'])).toBe('ACTIVE')
    expect(listingStatusOfSummary(['DISCOVERABLE'])).toBe('INACTIVE')
    expect(listingStatusOfSummary([])).toBe('INACTIVE')
  })

  it('问题状态：已解决优先，其次处理中，其余是新增', () => {
    expect(listingIssueStatusOf({ resolvedAt: new Date(), handlingStatus: 'IN_PROGRESS' })).toBe('RESOLVED')
    expect(listingIssueStatusOf({ resolvedAt: null, handlingStatus: 'IN_PROGRESS' })).toBe('IN_PROGRESS')
    expect(listingIssueStatusOf({ resolvedAt: null, handlingStatus: 'OPEN' })).toBe('NEW')
  })

  it('修复建议按类别与影响给出方向', () => {
    const base = { category: 'OTHER', attributeName: '', kind: 'ISSUE', impact: 'NONE' as const, severity: 'WARNING' }
    expect(listingAdviceOf({ ...base, category: 'MISSING_ATTRIBUTE', attributeName: 'color' })).toContain('color')
    expect(listingAdviceOf({ ...base, kind: 'SEARCH_SUPPRESSED' })).toContain('搜索展示')
    expect(listingAdviceOf({ ...base, impact: 'LISTING_SUPPRESSED', severity: 'ERROR' })).toContain('优先处理')
    expect(listingAdviceOf(base)).toContain('警告不影响销售')
  })
})

describe('刊登质量：影响估算与解决时长', () => {
  const sales = (entries: Array<[string, number]>) => new Map(entries)

  it('无影响的问题不估算', () => {
    const result = estimateIssueImpact({ impact: 'NONE', firstSeenAt: day('2026-10-01'), endAt: day('2026-10-10'), salesByDay: sales([['2026-10-05', 10]]) })
    expect(result).toMatchObject({ state: 'NOT_APPLICABLE', estimatedChange: null, isEstimate: true })
  })

  it('存续太短、没有销售、此前没有销售都给出原因而不是 0', () => {
    expect(estimateIssueImpact({ impact: 'SEARCH_SUPPRESSED', firstSeenAt: day('2026-10-10'), endAt: day('2026-10-10'), salesByDay: sales([['2026-10-09', 5]]) })).toMatchObject({
      state: 'NO_DATA',
      estimatedChange: null,
    })
    expect(estimateIssueImpact({ impact: 'SEARCH_SUPPRESSED', firstSeenAt: day('2026-10-05'), endAt: day('2026-10-10'), salesByDay: null })).toMatchObject({ state: 'NO_DATA', duringDaily: null })
    expect(estimateIssueImpact({ impact: 'SEARCH_SUPPRESSED', firstSeenAt: day('2026-10-05'), endAt: day('2026-10-10'), salesByDay: sales([['2026-10-08', 5]]) })).toMatchObject({
      state: 'NO_DATA',
      note: expect.stringContaining('之前'),
    })
  })

  it('存续期日均与此前同长度时段对比：下降为负数', () => {
    // 存续 10-06 至 10-10（5 天，每天 20），此前 10-01 至 10-05（每天 100）
    const entries: Array<[string, number]> = []
    for (let d = 1; d <= 5; d += 1) entries.push([`2026-10-0${d}`, 100])
    for (let d = 6; d <= 10; d += 1) entries.push([`2026-10-${String(d).padStart(2, '0')}`, 20])
    const result = estimateIssueImpact({ impact: 'LISTING_SUPPRESSED', firstSeenAt: day('2026-10-06'), endAt: day('2026-10-10'), salesByDay: sales(entries) })
    expect(result).toMatchObject({ state: 'OK', spanDays: 5, duringDaily: 20, beforeDaily: 100, estimatedChange: -400 })
  })

  it('存续天数封顶 180 天', () => {
    const result = estimateIssueImpact({ impact: 'SEARCH_SUPPRESSED', firstSeenAt: day('2025-01-01'), endAt: day('2026-10-10'), salesByDay: sales([['2026-10-09', 1]]) })
    expect(result.spanDays).toBe(180)
  })

  it('平均解决时长只算已解决且时间合理的，没有样本为 null', () => {
    expect(averageResolveHours([])).toBeNull()
    expect(averageResolveHours([{ firstSeenAt: day('2026-10-01'), resolvedAt: null }])).toBeNull()
    expect(
      averageResolveHours([
        { firstSeenAt: new Date('2026-10-01T00:00:00Z'), resolvedAt: new Date('2026-10-01T10:00:00Z') },
        { firstSeenAt: new Date('2026-10-01T00:00:00Z'), resolvedAt: new Date('2026-10-02T00:00:00Z') },
        { firstSeenAt: new Date('2026-10-05T00:00:00Z'), resolvedAt: new Date('2026-10-01T00:00:00Z') },
      ]),
    ).toBe(17)
  })
})

describe('刊登修复：修改项与批量文件', () => {
  it('单个修改项的校验：属性名、禁改属性、取值', () => {
    expect(listingPatchIssue({ op: 'replace', attribute: 'color', values: ['Blue'] })).toBeNull()
    expect(listingPatchIssue({ op: 'replace', attribute: 'Color', values: ['Blue'] })).toContain('属性名')
    expect(listingPatchIssue({ op: 'replace', attribute: 'purchasable_offer', values: ['1'] })).toContain('不能在这里修改')
    expect(listingPatchIssue({ op: 'replace', attribute: 'color', values: [] })).toContain('取值')
    expect(listingPatchIssue({ op: 'replace', attribute: 'color', values: ['  '] })).toContain('不能为空')
    expect(listingPatchIssue({ op: 'delete', attribute: 'color' })).toBeNull()
    expect(listingPatchIssue({ op: 'delete', attribute: 'color', values: ['x'] })).toContain('不能带取值')
  })

  it('一组修改项：数量与重复属性', () => {
    expect(listingPatchesIssue([])).toContain('1 到')
    expect(
      listingPatchesIssue([
        { op: 'replace', attribute: 'color', values: ['a'] },
        { op: 'replace', attribute: 'color', values: ['b'] },
      ]),
    ).toContain('重复')
    expect(listingPatchesIssue([{ op: 'replace', attribute: 'size', values: [''] }])).toContain('第 1 项')
    expect(
      listingPatchesIssue([
        { op: 'replace', attribute: 'color', values: ['a'] },
        { op: 'delete', attribute: 'size' },
      ]),
    ).toBeNull()
  })

  it('转成亚马逊局部修改格式：replace 带站点与语言，delete 不带取值', () => {
    expect(
      listingAmazonPatches([
        { op: 'replace', attribute: 'color', values: ['Blue', 'Red'], languageTag: 'en_GB' },
        { op: 'delete', attribute: 'size' },
      ]),
    ).toEqual([
      {
        op: 'replace',
        path: '/attributes/color',
        value: [
          { value: 'Blue', marketplace_id: 'ATVPDKIKX0DER', language_tag: 'en_GB' },
          { value: 'Red', marketplace_id: 'ATVPDKIKX0DER', language_tag: 'en_GB' },
        ],
      },
      { op: 'delete', path: '/attributes/size' },
    ])
  })

  it('校验令牌的稳定文字：取值缺省与空语言归一，内容变化文字就变', () => {
    const a = listingPatchesText('SKU-1', 'SHIRT', [{ op: 'delete', attribute: 'size' }])
    expect(a).toBe(listingPatchesText('SKU-1', 'SHIRT', [{ op: 'delete', attribute: 'size', values: [], languageTag: '' }]))
    expect(a).not.toBe(listingPatchesText('SKU-1', 'SHIRT', [{ op: 'delete', attribute: 'color' }]))
    expect(a).not.toBe(listingPatchesText('SKU-2', 'SHIRT', [{ op: 'delete', attribute: 'size' }]))
  })

  it('批量文件：每个商品一条 PATCH 消息，编号从 1 起', () => {
    const feed = buildListingsFeed({
      sellerId: 'A1SELLER',
      items: [
        { sku: 'SKU-1', productType: 'SHIRT', patches: [{ op: 'replace', attribute: 'color', values: ['Blue'] }] },
        { sku: 'SKU-2', productType: 'MUG', patches: [{ op: 'delete', attribute: 'size' }] },
      ],
    })
    expect(feed.header).toEqual({ sellerId: 'A1SELLER', version: '2.0', issueLocale: 'en_US' })
    expect(feed.messages.map(message => [message.messageId, message.sku, message.operationType, message.productType])).toEqual([
      [1, 'SKU-1', 'PATCH', 'SHIRT'],
      [2, 'SKU-2', 'PATCH', 'MUG'],
    ])
    expect(feed.messages[1].patches).toEqual([{ op: 'delete', path: '/attributes/size' }])
  })

  it('失败码翻成中文，没有码或不认识都有兜底', () => {
    expect(listingFailureText('FEED_TIMEOUT')).toContain('批量任务')
    expect(listingFailureText('SP_API_403')).toContain('商品刊登')
    expect(listingFailureText('UNKNOWN_CODE')).toBe('执行失败，请稍后重试或联系管理员')
    expect(listingFailureText(null)).toBe('执行失败')
  })
})
