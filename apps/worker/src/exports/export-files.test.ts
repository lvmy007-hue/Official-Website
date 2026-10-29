import { once } from 'node:events'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { csvCell, csvLine, writeCsv, type Cell } from './csv'
import { XlsxRowLimitError, columnName, writeXlsx } from './xlsx-writer'
import { readZip, zipText } from './zip-reader.test-helper'
import { crc32Update } from './zip-stream'

function sink() {
  const chunks: Buffer[] = []
  const stream = new Writable({
    // 故意做成会“写不动”的目标，检验背压路径
    highWaterMark: 16,
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk)
      setImmediate(callback)
    },
  })
  // 结束并等全部数据真正落到目标（写入是异步的，不等会漏掉最后一块）
  const end = async () => {
    stream.end()
    await once(stream, 'finish')
  }
  return { stream, end, bytes: () => Buffer.concat(chunks) }
}
async function* rowsOf(rows: Cell[][]) {
  for (const row of rows) yield row
}

describe('CSV', () => {
  it('以 = + - @ 开头的文本加单引号前缀防公式注入；数字（含负数）保持原样', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell('-cmd')).toBe("'-cmd")
    expect(csvCell('@x')).toBe("'@x")
    expect(csvCell(-12.5)).toBe('-12.5')
    expect(csvCell('-12.5')).toBe("'-12.5")
  })

  it('含逗号、引号、换行的单元格加引号并转义；空值输出空；日期输出 ISO 时间', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
    expect(csvCell(new Date('2026-10-22T03:00:00Z'))).toBe('2026-10-22T03:00:00.000Z')
    expect(csvLine(['a', 1, true])).toBe('a,1,true\r\n')
  })

  it('writeCsv：开头带 BOM 与表头，逐行写出，返回数据行数（目标写不动时也完整写出）', async () => {
    const out = sink()
    const count = await writeCsv(
      out.stream,
      ['订单号', '金额'],
      rowsOf([
        ['A1', 19.9],
        ['A2', null],
      ]),
    )
    await out.end()
    expect(count).toBe(2)
    expect(out.bytes().toString('utf8')).toBe('\uFEFF订单号,金额\r\nA1,19.9\r\nA2,\r\n')
  })
})

describe('XLSX（流式 ZIP）', () => {
  it('CRC32 与标准值一致', () => {
    expect(crc32Update(0, Buffer.from('123456789'))).toBe(0xcbf43926)
    expect(crc32Update(crc32Update(0, Buffer.from('12345')), Buffer.from('6789'))).toBe(0xcbf43926)
  })

  it('生成的文件是合法 ZIP：包含必需的部件，CRC 与大小都对得上', async () => {
    const out = sink()
    const count = await writeXlsx(out.stream, { sheetName: '订单列表', header: ['订单号', '金额'], rows: rowsOf([['A1', 19.9]]), maxRows: 10, now: new Date('2026-10-22T03:00:00Z') })
    await out.end()
    expect(count).toBe(1)
    const files = readZip(out.bytes())
    expect(files.map(file => file.name)).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml'])
    expect(zipText(files, 'xl/workbook.xml')).toContain('<sheet name="订单列表" sheetId="1" r:id="rId1"/>')
  })

  it('工作表：首行冻结且表头加粗；数字与布尔保持类型；文本一律按文本（= 开头不会变成公式）；空值不占单元格', async () => {
    const out = sink()
    await writeXlsx(out.stream, {
      sheetName: 's',
      header: ['A', 'B', 'C', 'D'],
      rows: rowsOf([
        ['=1+1', 5, true, null],
        [new Date('2026-10-22T03:00:00Z'), -0.5, false, '尾'],
      ]),
      maxRows: 10,
    })
    await out.end()
    const sheet = zipText(readZip(out.bytes()), 'xl/worksheets/sheet1.xml') ?? ''
    expect(sheet).toContain('state="frozen"')
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1">')
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">=1+1</t></is></c>')
    expect(sheet).toContain('<c r="B2"><v>5</v></c>')
    expect(sheet).toContain('<c r="C2" t="b"><v>1</v></c>')
    expect(sheet).not.toContain('r="D2"')
    expect(sheet).toContain('2026-10-22T03:00:00.000Z')
    expect(sheet).toContain('<c r="B3"><v>-0.5</v></c>')
    expect(sheet).not.toContain('<f>')
  })

  it('特殊字符转义，非法控制字符被去掉，超长文本截到 Excel 单元格上限', async () => {
    const out = sink()
    await writeXlsx(out.stream, { sheetName: 's', header: ['x'], rows: rowsOf([['a<b>&"c\u0001d'], ['x'.repeat(40_000)]]), maxRows: 10 })
    await out.end()
    const sheet = zipText(readZip(out.bytes()), 'xl/worksheets/sheet1.xml') ?? ''
    expect(sheet).toContain('a&lt;b&gt;&amp;&quot;cd')
    expect(sheet).not.toContain('\u0001')
    expect(sheet).toContain(`>${'x'.repeat(32_767)}<`)
    expect(sheet).not.toContain('x'.repeat(32_768))
  })

  it('大量行：分块写出后整体仍可解压，行号连续', async () => {
    const out = sink()
    const rows = Array.from({ length: 5000 }, (_, index) => [`订单-${index}`, index])
    const count = await writeXlsx(out.stream, { sheetName: 's', header: ['订单', '序号'], rows: rowsOf(rows), maxRows: 10_000 })
    await out.end()
    expect(count).toBe(5000)
    const sheet = zipText(readZip(out.bytes()), 'xl/worksheets/sheet1.xml') ?? ''
    expect(sheet).toContain('<row r="5001">')
    expect(sheet).not.toContain('<row r="5002">')
  })

  it('超过行数上限直接报错（调用方丢弃半成品）', async () => {
    const out = sink()
    await expect(writeXlsx(out.stream, { sheetName: 's', header: ['x'], rows: rowsOf([['1'], ['2'], ['3']]), maxRows: 2 })).rejects.toBeInstanceOf(XlsxRowLimitError)
  })

  it('列名换算：0→A，25→Z，26→AA，701→ZZ，702→AAA', () => {
    expect([0, 25, 26, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA'])
  })
})
