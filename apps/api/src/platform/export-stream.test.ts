import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { csvCell, csvLine, paginate, streamCsv } from './export-stream'

function fakeResponse() {
  const sink = new PassThrough()
  const chunks: string[] = []
  sink.on('data', chunk => chunks.push(String(chunk)))
  const headers: Record<string, string> = {}
  const response: any = Object.assign(sink, {
    status() {
      return response
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
    },
  })
  return { response, headers, text: () => chunks.join('') }
}

describe('CSV 单元格', () => {
  it('含逗号、引号、换行的内容加引号并转义', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('第一行\n第二行')).toBe('"第一行\n第二行"')
  })

  it('空值为空；日期用 ISO 格式；数字与布尔原样', () => {
    expect(csvLine([null, undefined, 3.5, true, new Date('2026-10-21T00:00:00Z')])).toBe(',,3.5,true,2026-10-21T00:00:00.000Z\r\n')
  })

  it('防 CSV 注入：以 = + - @ 开头的文本加单引号；负数不受影响', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"')
    expect(csvCell('+1-2')).toBe("'+1-2")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('-cmd')).toBe("'-cmd")
    expect(csvCell(-5)).toBe('-5')
  })
})

describe('流式导出', () => {
  it('写出带 BOM 的表头与全部行，设置下载头，返回行数', async () => {
    const { response, headers, text } = fakeResponse()
    async function* rows() {
      yield ['A1', 1]
      yield ['B,2', 2]
    }
    const count = await streamCsv(response, { filename: '订单.csv', header: ['名称', '数量'], rows: rows() })
    expect(count).toBe(2)
    expect(text()).toBe('\uFEFF名称,数量\r\nA1,1\r\n"B,2",2\r\n')
    expect(headers['content-type']).toContain('text/csv')
    expect(headers['content-disposition']).toContain(encodeURIComponent('订单.csv'))
    expect(headers['cache-control']).toBe('no-store')
  })

  it('超过行数上限：截断并在末尾说明', async () => {
    const { response, text } = fakeResponse()
    async function* rows() {
      for (let i = 0; i < 10; i += 1) yield [i]
    }
    expect(await streamCsv(response, { filename: 'x.csv', header: ['n'], rows: rows(), maxRows: 3 })).toBe(3)
    expect(text()).toContain('导出已在 3 行处截断')
  })

  it('取数中途出错：连接被关闭，错误向上抛出', async () => {
    const { response } = fakeResponse()
    async function* rows() {
      yield ['ok']
      throw new Error('boom')
    }
    await expect(streamCsv(response, { filename: 'x.csv', header: ['n'], rows: rows() })).rejects.toThrow('boom')
    expect(response.writableEnded).toBe(true)
  })

  it('分页迭代器一次只取一页，遇到空页或没有下一页结束', async () => {
    const pages = [
      { rows: [1, 2], next: 2 },
      { rows: [3], next: 3 },
      { rows: [] as number[], next: 4 },
    ]
    const requested: Array<number | undefined> = []
    const out: number[] = []
    for await (const row of paginate<number, number>(async cursor => {
      requested.push(cursor)
      return pages[requested.length - 1]
    }))
      out.push(row)
    expect(out).toEqual([1, 2, 3])
    expect(requested).toEqual([undefined, 2, 3])
  })

  it('大量行的导出：边读边写，不在内存里累积全部行', async () => {
    const { response } = fakeResponse()
    let produced = 0
    async function* rows() {
      for (let i = 0; i < 200_000; i += 1) {
        produced += 1
        yield [i, 'x'.repeat(50)]
      }
    }
    const before = process.memoryUsage().heapUsed
    const count = await streamCsv(response, { filename: 'big.csv', header: ['n', 'v'], rows: rows() })
    expect(count).toBe(200_000)
    expect(produced).toBe(200_000)
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(120 * 1024 * 1024) // 全量文本约 11MB × 多份拷贝若累积会远超此值
  })
})
