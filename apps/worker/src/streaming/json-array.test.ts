import { describe, expect, it } from 'vitest'
import { jsonArrayRows } from './json-array'
import { MAX_JSON_ELEMENT_CHARS } from './rows'

async function* chunked(text: string, size: number): AsyncGenerator<string> {
  for (let index = 0; index < text.length; index += size) yield text.slice(index, index + size)
}

async function collect(text: string, size = 7) {
  const rows: Array<Record<string, unknown>> = []
  for await (const row of jsonArrayRows(chunked(text, size))) rows.push(row)
  return rows
}

describe('jsonArrayRows：顶层对象里的数组逐个元素交出', () => {
  const report = {
    reportSpecification: { reportType: 'X', marketplaceIds: ['ATVPDKIKX0DER'], reportOptions: { reportPeriod: 'WEEK' } },
    dataByAsin: [
      { asin: 'B000000001', note: '含 } 和 ] 和 "引号" 的文本', nested: { list: [{ a: 1 }] } },
      { asin: 'B000000002', note: '转义 \\" 之后 }' },
    ],
  }

  it('报告说明里的对象与数组不会被当成记录', async () => {
    const rows = await collect(JSON.stringify(report))
    expect(rows.map(row => row.asin)).toEqual(['B000000001', 'B000000002'])
  })

  it('元素内部更深层的数组不拆开，字符串里的括号与转义引号不影响边界', async () => {
    const rows = await collect(JSON.stringify(report), 3)
    expect(rows[0]).toEqual(report.dataByAsin[0])
    expect(rows[1]).toEqual(report.dataByAsin[1])
  })

  it('任意分段大小结果一致（含逐字符分段）', async () => {
    const text = JSON.stringify(report)
    for (const size of [1, 2, 5, 11, 1000]) expect((await collect(text, size)).length).toBe(2)
  })

  it('数组在说明之前也一样（字段顺序无关）', async () => {
    const swapped = JSON.stringify({ dataByAsin: report.dataByAsin, reportSpecification: report.reportSpecification })
    expect((await collect(swapped)).length).toBe(2)
  })

  it('顶层就是数组时交出每个元素', async () => {
    expect(await collect('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('空数组、没有数组字段：不交出任何记录', async () => {
    expect(await collect('{"dataByAsin":[]}')).toEqual([])
    expect(await collect('{"reportSpecification":{"a":1}}')).toEqual([])
  })

  it('数组里不是对象的元素（字符串、数字）跳过', async () => {
    expect(await collect('{"ids":["a","b",3],"rows":[{"k":1}]}')).toEqual([{ k: 1 }])
  })

  it('文件在元素中间被截断：报错而不是静默丢数据', async () => {
    await expect(collect('{"dataByAsin":[{"asin":"B000000001"')).rejects.toThrow('JSON_STREAM_TRUNCATED')
  })

  it('单个元素超过上限：明确失败', async () => {
    const huge = `{"rows":[{"text":"${'x'.repeat(MAX_JSON_ELEMENT_CHARS + 10)}"}]}`
    await expect(collect(huge, 1_000_000)).rejects.toThrow(/超过/)
  })

  it('大量元素：只逐个交出（不依赖整体解析）', async () => {
    const items = Array.from({ length: 5000 }, (_, index) => ({ asin: `B${String(index).padStart(9, '0')}`, value: index }))
    const rows = await collect(JSON.stringify({ reportSpecification: {}, dataByAsin: items }), 4096)
    expect(rows).toHaveLength(5000)
    expect(rows[4999].value).toBe(4999)
  })
})
