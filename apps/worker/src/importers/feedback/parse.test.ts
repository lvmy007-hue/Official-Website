import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REVIEWS_LIMITS } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { parseBrowseNode, parseItemTopics, parseTrends } from './parse'

// 客户反馈响应解析（P4-13，I-15）。字段名依据官方文档整理、没有真实响应核对（CR-088 披露）：这里验证宽容规则——
// 多种形状都能读、提及量原样不估算、占比按百分数转小数、认不出的计入 skipped 而不是抛错。样例在 apps/worker/fixtures/feedback。

const FIXTURES = join(__dirname, '../../../fixtures/feedback')
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const byKey = <T extends { topicKey: string }>(rows: T[], key: string) => rows.find(row => row.topicKey === key)

describe('商品评论主题', () => {
  it('按 positiveTopics / negativeTopics 分组：名次从 1 起，提及量区间原样，没给的为 null（不当 0）', () => {
    const { rows, skipped } = parseItemTopics(fixture('item-topics.json'))
    expect(skipped).toBe(0)
    expect(rows.filter(row => row.sentiment === 'POSITIVE').map(row => [row.rank, row.topicKey])).toEqual([
      [1, 'Sturdy build'],
      [2, 'Easy to carry'],
      [3, 'Good value'],
    ])
    expect(rows.filter(row => row.sentiment === 'NEGATIVE').map(row => [row.rank, row.topicKey])).toEqual([
      [1, 'Zipper breaks'],
      [2, 'Wheels loose'],
    ])
    expect(byKey(rows, 'Sturdy build')).toMatchObject({ mentionRange: '100-250', reviewCountBucket: '1000+' })
    expect(byKey(rows, 'Easy to carry')).toMatchObject({ mentionRange: '50-100', reviewCountBucket: null })
    expect(byKey(rows, 'Good value')).toMatchObject({ mentionRange: null, reviewCountBucket: null })
  })

  it('条目自带 sentiment 字段（大小写不限）、外面套了 payload、主题名在子对象里；认不出的计入 skipped，数字不当区间', () => {
    const { rows, skipped } = parseItemTopics(fixture('item-topics-flat.json'))
    expect(rows.map(row => [row.sentiment, row.rank, row.topicKey])).toEqual([
      ['POSITIVE', 1, 'Sturdy build'],
      ['NEGATIVE', 1, 'Zipper breaks'],
      ['NEGATIVE', 2, 'Wheels loose'],
    ])
    expect(skipped).toBe(3) // 情感不是正负面、没有主题名、字符串条目没有情感
    expect(byKey(rows, 'Zipper breaks')).toMatchObject({ mentionRange: null, reviewCountBucket: '500-1000' })
    expect(byKey(rows, 'Wheels loose')?.mentionRange).toBeNull()
  })

  it('也认 topics.positive / topics.negative 与顶层 positiveTopics 的写法，字符串条目只有名称', () => {
    const grouped = parseItemTopics({ topics: { positive: ['A'], negative: [{ name: 'B' }] } })
    expect(grouped.rows.map(row => [row.sentiment, row.topicKey])).toEqual([
      ['POSITIVE', 'A'],
      ['NEGATIVE', 'B'],
    ])
    const top = parseItemTopics({ positiveTopics: [{ topicName: 'C', sentiment: 'NEGATIVE' }] })
    expect(top.rows).toMatchObject([{ sentiment: 'POSITIVE', topicKey: 'C' }]) // 分组优先于条目自己的字段
  })

  it('每种情感最多保留上限条；同名主题只留第一条（数据库唯一键不含情感）', () => {
    const many = Array.from({ length: REVIEWS_LIMITS.topicsPerSentiment + 5 }, (_, index) => ({ topic: `Topic ${index + 1}` }))
    const { rows } = parseItemTopics({ positiveTopics: many, negativeTopics: [{ topic: 'topic 1' }, { topic: 'Other' }] })
    const positive = rows.filter(row => row.sentiment === 'POSITIVE')
    expect(positive).toHaveLength(REVIEWS_LIMITS.topicsPerSentiment)
    expect(positive.map(row => row.rank)).toEqual(Array.from({ length: REVIEWS_LIMITS.topicsPerSentiment }, (_, index) => index + 1))
    expect(rows.filter(row => row.sentiment === 'NEGATIVE').map(row => [row.rank, row.topicKey])).toEqual([[1, 'Other']])
  })

  it('脏数据不抛错：空值、数组、错误类型都得到空结果', () => {
    for (const body of [null, undefined, 'x', 12, [], {}, { topics: 'bad' }, { topics: [null, 3, true, []] }, { positiveTopics: 'nope' }]) {
      expect(() => parseItemTopics(body)).not.toThrow()
      expect(parseItemTopics(body).rows).toEqual([])
    }
    expect(parseItemTopics({ topics: [null, 3, true] }).skipped).toBe(3)
  })

  it('超长主题名与区间文字被截断，空白被去掉', () => {
    const { rows } = parseItemTopics({ positiveTopics: [{ topic: `  ${'x'.repeat(500)}  `, mentionRange: ` ${'9'.repeat(300)} ` }] })
    expect(rows[0].topicKey).toHaveLength(200)
    expect(rows[0].mentionRange).toHaveLength(100)
  })
})

describe('浏览节点', () => {
  it('从 browseNode 对象里取编号与名称', () => {
    expect(parseBrowseNode(fixture('browse-node.json'))).toEqual({ browseNodeId: '2975312011', browseNodeName: 'Suitcases' })
  })

  it('也认根上的字段、数字编号、browseNodes 列表与 payload 包装；缺名称为 null', () => {
    expect(parseBrowseNode({ browseNodeId: 123, displayName: 'Bags' })).toEqual({ browseNodeId: '123', browseNodeName: 'Bags' })
    expect(parseBrowseNode({ payload: { browseNodes: [{ id: 'N-9' }] } })).toEqual({ browseNodeId: 'N-9', browseNodeName: null })
  })

  it('认不出或编号带非法字符时返回 null，不抛错', () => {
    const none = { browseNodeId: null, browseNodeName: null }
    for (const body of [null, 'x', [], {}, { browseNode: {} }, { browseNodeId: 'a/b?x=1' }]) expect(parseBrowseNode(body)).toEqual(none)
  })
})

describe('类目评论主题趋势', () => {
  const parsed = parseTrends(fixture('review-trends.json'), 'review')
  const point = (scope: string, month: string, topicKey: string) => parsed.rows.find(row => row.scope === scope && row.month === month && row.topicKey === topicKey)

  it('百分数转成小数，口径分 ALL 与 TOP25，情感取自分组', () => {
    expect(point('ALL', '2026-09-01', 'Sturdy build')).toMatchObject({ rate: 0.155, sentiment: 'POSITIVE' })
    expect(point('TOP25', '2026-09-01', 'Sturdy build')?.rate).toBe(0.22)
    expect(point('ALL', '2026-08-01', 'Zipper breaks')).toMatchObject({ rate: 0.07, sentiment: 'NEGATIVE' })
    expect(point('ALL', '2026-09-01', 'Zipper breaks')?.rate).toBe(0.085) // 带 % 的文字也认
  })

  it('只保留最近 6 个月：7 个月的数据丢掉最早的一个', () => {
    expect(REVIEWS_LIMITS.trendMonths).toBe(6)
    expect([...new Set(parsed.rows.map(row => row.month))].sort()).toEqual(['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'])
    expect(parsed.rows).toHaveLength(14)
  })

  it('超出 0 到 100 的占比丢弃并计数；月份不合法、没有口径、占比为空的点计入 skipped（不当 0）', () => {
    expect(point('TOP25', '2026-08-01', 'Zipper breaks')).toBeUndefined()
    expect(parsed.outOfRange).toBe(1)
    expect(point('TOP25', '2026-09-01', 'Zipper breaks')).toBeUndefined()
    expect(parsed.skipped).toBe(3)
  })

  it('0 与 100 是合法占比；负数、超过 100、非数字都计入 outOfRange', () => {
    const body = {
      positiveTopics: [
        {
          topic: 'T',
          trends: [
            { month: '2026-01', allProducts: 0, top25Percent: 100 },
            { month: '2026-02', allProducts: -1, top25Percent: 100.5 },
            { month: '2026-03', allProducts: 'abc' },
          ],
        },
      ],
    }
    const result = parseTrends(body, 'review')
    expect(result.rows.map(row => [row.scope, row.month, row.rate])).toEqual([
      ['ALL', '2026-01-01', 0],
      ['TOP25', '2026-01-01', 1],
    ])
    expect(result.outOfRange).toBe(3)
  })

  it('评论趋势的条目没有情感时丢弃并计入 skipped', () => {
    const result = parseTrends({ topics: [{ topic: 'T', trends: [{ month: '2026-01', allProducts: 5 }] }] }, 'review')
    expect(result.rows).toEqual([])
    expect(result.skipped).toBe(1)
  })

  it('同一主题同一月同一口径出现多次，后一条覆盖前一条（唯一键）', () => {
    const body = {
      positiveTopics: [
        {
          topic: 'T',
          trends: [
            { month: '2026-01', allProducts: 5 },
            { month: '2026-01-15', allProducts: 7 },
          ],
        },
      ],
    }
    expect(parseTrends(body, 'review').rows.map(row => row.rate)).toEqual([0.07])
  })
})

describe('类目退货主题趋势', () => {
  it('口径放在条目的键上（allProducts / top25Percent 数组），也认点上的 scope 字段与 dateRange', () => {
    const { rows, skipped, outOfRange } = parseTrends(fixture('return-trends.json'), 'return')
    const label = rows.map(row => `${row.topicKey}|${row.scope}|${row.month}|${row.rate}|${row.sentiment}`).sort()
    expect(label).toEqual(
      ['Damaged on arrival|TOP25|2026-09-01|0.015|null', 'Too small|ALL|2026-08-01|0.045|null', 'Too small|ALL|2026-09-01|0.05|null', 'Too small|TOP25|2026-09-01|0.0225|null'].sort(),
    )
    expect(skipped).toBe(0)
    expect(outOfRange).toBe(0)
  })

  it('小写口径名里的 small 之类的词不会被当成“全部商品”', () => {
    const { rows } = parseTrends({ returnTopics: [{ topic: 'T', trends: [{ month: '2026-01', smallCount: 5 }] }] }, 'return')
    expect(rows).toEqual([])
  })

  it('脏数据不抛错：得到空结果', () => {
    for (const body of [null, undefined, 'x', [], {}, { returnTopics: [null, 5, { trends: 'x' }] }, { returnTopics: [{ topic: 'T', trends: [null, 'x', {}] }] }]) {
      expect(() => parseTrends(body, 'return')).not.toThrow()
      expect(parseTrends(body, 'return').rows).toEqual([])
    }
  })
})
