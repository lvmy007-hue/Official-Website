import { describe, expect, it } from 'vitest'
import { MAX_LIMIT_ROWS, parseDelimited, parseStorageLimits } from './capacity-import'

const TODAY = '2026-10-22'

describe('分隔文本解析', () => {
  it('逗号、引号内的逗号与换行、双引号转义、BOM、CRLF', () => {
    expect(parseDelimited('\uFEFFa,b\r\n"1,000","he said ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['1,000', 'he said "hi"'],
    ])
  })

  it('按表头判断制表符与分号分隔；空行忽略', () => {
    expect(parseDelimited('a\tb\n1\t2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(parseDelimited('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('仓储限额文件解析', () => {
  it('中文表头：类型别名、千分位、留空的已用与采集日期（采集日期默认今天）', () => {
    const { rows, errors } = parseStorageLimits('存储类型,限额,已用,采集日期\n标准尺寸,"12,000",9000.5,2026-10-01\n超大件,500,,\n', TODAY)
    expect(errors).toEqual([])
    expect(rows).toEqual([
      { storageType: 'STANDARD', limitQty: 12000, usedQty: 9000.5, captureDate: '2026-10-01' },
      { storageType: 'OVERSIZE', limitQty: 500, usedQty: null, captureDate: TODAY },
    ])
  })

  it('英文表头与英文类型名；日期斜杠写法补零', () => {
    const { rows, errors } = parseStorageLimits('Storage Type,Limit,Used,Capture Date\nstandard-size,100,50,2026/9/5\nApparel,10,1,2026-09-05', TODAY)
    expect(errors).toEqual([])
    expect(rows.map(row => [row.storageType, row.captureDate])).toEqual([
      ['STANDARD', '2026-09-05'],
      ['APPAREL', '2026-09-05'],
    ])
  })

  it('一行有错整份拒绝：逐行列出原因，不返回任何行', () => {
    const { rows, errors } = parseStorageLimits(
      '存储类型,限额,已用,采集日期\n标准尺寸,abc,1,2026-10-01\n未知类型,10,1,2026-10-01\n超大件,10,-1,2026-10-01\n服饰,10,1,2026-02-30\n鞋靴,10,1,2026-12-01\n',
      TODAY,
    )
    expect(rows).toEqual([])
    expect(errors).toHaveLength(5)
    expect(errors[0]).toContain('第 2 行')
    expect(errors[1]).toContain('不认识的存储类型')
    expect(errors[2]).toContain('已用')
    expect(errors[3]).toContain('采集日期')
    expect(errors[4]).toContain('不能晚于今天')
  })

  it('同一日期同一类型重复：拒绝', () => {
    const { errors } = parseStorageLimits('存储类型,限额\n标准尺寸,1\nstandard,2\n', TODAY)
    expect(errors[0]).toContain('出现了多次')
  })

  it('表头缺必需列、没有数据行、行数过多：给出整体说明', () => {
    expect(parseStorageLimits('类型,数量\nA,1', TODAY).errors[0]).toContain('缺少必需的列')
    expect(parseStorageLimits('存储类型,限额', TODAY).errors[0]).toContain('没有数据行')
    const many = `存储类型,限额,采集日期\n${Array.from({ length: MAX_LIMIT_ROWS + 1 }, (_, i) => `标准尺寸,1,2025-01-${String((i % 28) + 1).padStart(2, '0')}`).join('\n')}`
    expect(parseStorageLimits(many, TODAY).errors[0]).toContain('数据行过多')
  })

  it('错误最多列 10 条', () => {
    const body = Array.from({ length: 15 }, () => '坏类型,1').join('\n')
    expect(parseStorageLimits(`存储类型,限额\n${body}`, TODAY).errors).toHaveLength(10)
  })
})
