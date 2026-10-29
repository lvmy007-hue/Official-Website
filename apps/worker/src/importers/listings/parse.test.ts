import { describe, expect, it } from 'vitest'
import { parseIssue, parseListings } from './items-parse'
import { hasErrorIssue, parseFeedResult, parsePatchResponse, parseRestrictions, parseValidationIssues } from './write-parse'

// 刊登响应的解析（P4-10）：依据官方文档整理的结构；认不出的不猜，只收错误与警告，同一问题去重，没有美国站摘要的商品照样收问题。

const US = 'ATVPDKIKX0DER'
const item = (over: Record<string, unknown> = {}) => ({
  sku: 'SKU-1',
  summaries: [
    { marketplaceId: US, asin: 'b0test0001', productType: 'LUGGAGE', conditionType: 'new_new', status: ['BUYABLE', 'DISCOVERABLE'], itemName: '行李箱', mainImage: { link: 'https://img/1.jpg' } },
  ],
  issues: [],
  ...over,
})

describe('刊登搜索结果解析', () => {
  it('取美国站摘要：ASIN 大写、状态由 BUYABLE 决定、标题与主图、商品类型', () => {
    const parsed = parseListings({ items: [item()], pagination: { nextToken: 'next-1' } })
    expect(parsed.nextToken).toBe('next-1')
    expect(parsed.items[0]).toMatchObject({ sku: 'SKU-1', asin: 'B0TEST0001', hasSummary: true, productType: 'LUGGAGE', status: 'ACTIVE', itemName: '行李箱', mainImageUrl: 'https://img/1.jpg' })
  })

  it('没有 BUYABLE 就是非活跃，状态原文保留；没有分页令牌是 null', () => {
    const parsed = parseListings({ items: [item({ summaries: [{ marketplaceId: US, asin: 'B0TEST0002', status: ['DISCOVERABLE'] }] })] })
    expect(parsed.items[0]).toMatchObject({ status: 'INACTIVE', amazonStatuses: ['DISCOVERABLE'] })
    expect(parsed.nextToken).toBeNull()
  })

  it('没有 sku 的商品跳过并计数；别的站点的摘要不取；没有美国站摘要的商品不写状态与内容', () => {
    const parsed = parseListings({ items: [{ summaries: [] }, 'bad', item({ sku: 'SKU-2', summaries: [{ marketplaceId: 'A1F83G8C2ARO7P', asin: 'B0UK0000001' }] })] })
    expect(parsed.skipped).toBe(2)
    expect(parsed.items).toHaveLength(1)
    expect(parsed.items[0]).toMatchObject({ sku: 'SKU-2', hasSummary: false, asin: '', productType: null, itemName: null })
  })

  it('问题只收错误与警告；同一（代码，属性）去重；执法动作决定对销售的影响；类别取缺少或无效属性', () => {
    const parsed = parseListings({
      items: [
        item({
          issues: [
            { code: '90220', message: '缺少颜色', severity: 'ERROR', attributeNames: ['color'], categories: ['MISSING_ATTRIBUTE'], enforcements: { actions: [{ action: 'SEARCH_SUPPRESSED' }] } },
            { code: '90220', message: '重复', severity: 'ERROR', attributeNames: ['color'] },
            { code: '8541', message: '提示', severity: 'INFO' },
            { code: '', severity: 'ERROR' },
            { code: '99', message: '警告', severity: 'warning' },
          ],
        }),
      ],
    })
    const issues = parsed.items[0]!.issues
    expect(issues.map(issue => issue.code)).toEqual(['90220', '99'])
    expect(issues[0]).toMatchObject({ attributeName: 'color', category: 'MISSING_ATTRIBUTE', severity: 'ERROR', impact: 'SEARCH_SUPPRESSED', message: '缺少颜色' })
    expect(issues[1]).toMatchObject({ severity: 'WARNING', impact: 'NONE', attributeName: '', category: '' })
  })

  it('没有消息文字时用代码；消息过长会截断；响应不是对象就抛错（让同步失败，不当作“没有刊登”）', () => {
    expect(parseIssue({ code: 'X1', severity: 'ERROR' })?.message).toBe('X1')
    expect(parseIssue({ code: 'X1', severity: 'ERROR', message: 'a'.repeat(5000) })?.message).toHaveLength(1000)
    expect(parseIssue('bad')).toBeNull()
    expect(() => parseListings(null)).toThrow('LISTINGS_RESPONSE_INVALID')
    expect(parseListings({}).items).toEqual([])
  })
})

describe('写入与查询响应解析', () => {
  it('修改与校验预览：认得 ACCEPTED、VALID、INVALID，认不出的是 null（调用方当作失败）', () => {
    expect(parsePatchResponse({ status: 'valid', submissionId: 's1', issues: [] })).toEqual({ status: 'VALID', issues: [], submissionId: 's1' })
    expect(parsePatchResponse({ status: 'ACCEPTED', submissionId: 's2' }).status).toBe('ACCEPTED')
    expect(parsePatchResponse({ status: 'WHATEVER' }).status).toBeNull()
    expect(parsePatchResponse('x')).toEqual({ status: null, issues: [], submissionId: null })
  })

  it('校验问题：没有严重程度按错误；属性名最多 10 个；没有代码的丢弃', () => {
    const issues = parseValidationIssues([{ code: 'A', message: '坏了', attributeNames: Array.from({ length: 15 }, (_, i) => `a${i}`) }, { message: '没有代码' }, 3])
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ code: 'A', severity: 'ERROR', message: '坏了' })
    expect(issues[0]!.attributeNames).toHaveLength(10)
    expect(hasErrorIssue(issues)).toBe(true)
    expect(hasErrorIssue([{ code: 'W', severity: 'WARNING', message: '', attributeNames: [] }])).toBe(false)
  })

  it('刊登限制：没有任何限制就是可以刊登；有原因逐条列出，带处理链接', () => {
    expect(parseRestrictions('B0AAAAAAAA', { restrictions: [] })).toEqual({ asin: 'B0AAAAAAAA', restricted: false, reasons: [], error: null })
    const row = parseRestrictions('B0BBBBBBBB', {
      restrictions: [{ reasons: [{ reasonCode: 'APPROVAL_REQUIRED', message: '需要审核', links: [{ resource: 'https://sellercentral.amazon.com/apply', verb: 'GET' }] }, { message: '没有代码' }] }],
    })
    expect(row.restricted).toBe(true)
    expect(row.reasons).toEqual([
      { code: 'APPROVAL_REQUIRED', message: '需要审核', link: 'https://sellercentral.amazon.com/apply' },
      { code: 'UNKNOWN', message: '没有代码', link: null },
    ])
  })

  it('批量结果文件：消息编号从 1 起对应提交顺序；有错误的商品失败，只有警告的成功；没提到的商品成功', () => {
    const rows = parseFeedResult(
      {
        issues: [
          { messageId: 2, code: 'E1', severity: 'ERROR', message: '标题太长' },
          { messageId: 3, code: 'W1', severity: 'WARNING', message: '建议补充' },
          { messageId: 'x', code: 'E9', severity: 'ERROR' },
        ],
      },
      ['SKU-1', 'SKU-2', 'SKU-3'],
    )
    expect(rows.map(row => [row.sku, row.ok])).toEqual([
      ['SKU-1', true],
      ['SKU-2', false],
      ['SKU-3', true],
    ])
    expect(rows[1]!.issues[0]).toMatchObject({ code: 'E1', message: '标题太长' })
    expect(parseFeedResult('bad', ['A'])).toEqual([{ sku: 'A', ok: true, issues: [] }])
  })
})
