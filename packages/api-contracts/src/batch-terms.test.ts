import { describe, expect, it } from 'vitest'
import { BATCH_ITEM_MAX, BATCH_MAX_CHARS, BATCH_MAX_ITEMS, batchTermsIssue, joinBatchTerms, parseBatchTerms, splitBatchTerms } from './batch-terms'

// 批量搜索词（P6-04）：前端筛选栏与接口共用这套拆分规则，去空行、去重、数量与长度上限。

describe('parseBatchTerms', () => {
  it('换行、制表符、逗号、分号（含全角）都是分隔符；空行与空白项丢弃', () => {
    const parsed = parseBatchTerms('A1\n\n  \nB2\tC3,D4；E5，F6、G7;H8\r\nI9')
    expect(parsed.items).toEqual(['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8', 'I9'])
    expect(parsed.duplicates).toBe(0)
    expect(parsed.overflow).toBe(false)
  })

  it('去重不区分大小写，保留第一个写法与粘贴顺序，并数出去掉了几个', () => {
    const parsed = parseBatchTerms('abc\nABC\nxyz\nAbc\nxyz')
    expect(parsed.items).toEqual(['abc', 'xyz'])
    expect(parsed.duplicates).toBe(3)
  })

  it('全是空行时没有任何词', () => {
    expect(parseBatchTerms('\n \n\t\n').items).toEqual([])
  })

  it('超过 80 个字符的词单独列出，不进入结果', () => {
    const long = 'x'.repeat(BATCH_ITEM_MAX + 1)
    const parsed = parseBatchTerms(`ok\n${long}`)
    expect(parsed.items).toEqual(['ok'])
    expect(parsed.tooLong).toEqual([long])
  })

  it('正好 500 个可以，501 个溢出；总长度超限也算溢出', () => {
    const make = (count: number) => Array.from({ length: count }, (_, index) => `T${index}`).join('\n')
    expect(parseBatchTerms(make(BATCH_MAX_ITEMS)).overflow).toBe(false)
    expect(parseBatchTerms(make(BATCH_MAX_ITEMS + 1)).overflow).toBe(true)
    // 500 个 40 字符的词连接后约 20500 字符，超过总长度上限
    const wide = Array.from({ length: 400 }, (_, index) => `${String(index).padStart(3, '0')}${'z'.repeat(37)}`)
    expect(joinBatchTerms(wide).length).toBeGreaterThan(BATCH_MAX_CHARS)
    expect(parseBatchTerms(wide.join('\n')).overflow).toBe(true)
  })
})

describe('splitBatchTerms / batchTermsIssue', () => {
  it('没传或全空是“没有批量词”，不是错误', () => {
    expect(splitBatchTerms(undefined)).toEqual([])
    expect(splitBatchTerms('  ')).toEqual([])
    expect(batchTermsIssue(undefined)).toBeNull()
  })

  it('合规时拆出词；太多或含超长项返回 null，并给出提示', () => {
    expect(splitBatchTerms('a,b,A,c')).toEqual(['a', 'b', 'c'])
    const tooMany = Array.from({ length: 501 }, (_, index) => `T${index}`).join(',')
    expect(splitBatchTerms(tooMany)).toBeNull()
    expect(batchTermsIssue(tooMany)).toMatch(/最多 500 个词/)
    expect(splitBatchTerms('x'.repeat(81))).toBeNull()
    expect(batchTermsIssue('x'.repeat(81))).toMatch(/超过 80 个字符/)
  })
})
