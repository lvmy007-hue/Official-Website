import { describe, expect, it } from 'vitest'
import { parseCsvTable } from './csv-table.js'
import { analyzePacking, type PackingAnalysis } from './packing-list-analyze.js'
import { resolvePacking } from './packing-list-boxes.js'
import { textSimilarity } from './packing-list-match.js'
import { detectHeaderRow } from './packing-list.js'

// 装箱单识别与匹配（P6-11）：三份构造的样例（中文厘米千克带标题行与合并箱号、英文英寸磅、只有品名与数量）+ 匹配顺序、相似度、候选不自动采用、决定与阻止项。

const ITEMS = [
  { sku: 'SKU-A', fnsku: 'X0AAAAAAAA', asin: 'B0AAAAAAAA', productName: '蓝牙耳机 黑色' },
  { sku: 'SKU-B', fnsku: null, asin: null, productName: '手机壳 红色' },
  { sku: 'SKU-C', fnsku: null, asin: null, productName: '手机壳 蓝色' },
]
const SUPPLIER = 's1'
const analyze = (csv: string, over: Partial<Parameters<typeof analyzePacking>[0]> = {}): PackingAnalysis =>
  analyzePacking({ table: parseCsvTable(csv), items: ITEMS, aliases: [], supplierId: SUPPLIER, ...over })
const planSkus = new Set(ITEMS.map(item => item.sku))

const CHINESE = [
  '装箱单 PACKING LIST,,,,,,,,',
  '供应商：ABC 工厂,,,,,,,,',
  ',,,,,,,,',
  '箱号,货号,品名,每箱数量,箱数,长(cm),宽(cm),高(cm),毛重(kg)',
  '1-2,SKU-A,蓝牙耳机 黑色,10,,40,30,20,10',
  '3,AB-1001,手机壳 蓝色,20,1,40,30,20,12.5',
  ',SKU-B,手机壳 红色,10,,,,,',
  '合计,,,,3,,,,',
].join('\n')

describe('装箱单样例一：中文、厘米千克、带标题行、箱号范围与合并箱号', () => {
  it('找到表头在第 4 行，认出全部列与单位，合计行跳过，行号与文件一致', () => {
    const result = analyze(CHINESE, { aliases: [{ supplierId: SUPPLIER, externalCode: 'AB-1001', sku: 'SKU-C' }] })
    expect(result.fatal).toBeNull()
    expect(result.headerLine).toBe(4)
    expect(result.missingFields).toEqual([])
    expect(result.units).toEqual({ length: 'CM', weight: 'KG' })
    expect(result.unitsSource).toBe('HEADER')
    expect(result.rows.map(row => row.line)).toEqual([5, 6, 7])
    expect(result.skipped).toEqual([{ line: 8, message: '合计行，已忽略' }])
    const [first, second, third] = result.rows
    expect(first).toMatchObject({ boxRange: { from: 1, to: 2 }, boxCount: 2, perBox: 10, status: 'MATCHED', basis: 'SKU', sku: 'SKU-A', lengthIn: 15.75, weightLb: 22.05 })
    expect(second).toMatchObject({ status: 'MATCHED', basis: 'ALIAS', sku: 'SKU-C', perBox: 20, boxCount: 1, weightLb: 27.56 })
    expect(third).toMatchObject({ boxNo: '3', boxNoInherited: true, status: 'MATCHED', basis: 'SKU', sku: 'SKU-B', perBox: 10 })
    expect(result.summary).toMatchObject({ rows: 3, matched: 3, candidate: 0, unmatched: 0, problems: 0, skipped: 1 })
  })

  it('没有映射时，外部货号 AB-1001 不会被自动采用：给候选，不匹配', () => {
    const result = analyze(CHINESE)
    const row = result.rows[1]!
    expect(row.status).not.toBe('MATCHED')
    expect(row.sku).toBeNull()
    expect(row.candidates[0]).toMatchObject({ sku: 'SKU-C' })
    expect(row.candidates.length).toBeLessThanOrEqual(5)
  })

  it('全部确认后按箱号合并：1-2 箱各 10 件、第 3 箱混装两个 SKU，箱规由有值的行提供', () => {
    const result = analyze(CHINESE, { aliases: [{ supplierId: SUPPLIER, externalCode: 'AB-1001', sku: 'SKU-C' }] })
    const resolved = resolvePacking(result.rows, [], planSkus, null)
    expect(resolved.blockers).toEqual([])
    expect(resolved.boxes).toHaveLength(2)
    expect(resolved.boxes[0]).toMatchObject({ quantity: 2, weightLb: 22.05, lengthIn: 15.75, items: [{ sku: 'SKU-A', quantity: 10 }] })
    expect(resolved.boxes[1]).toMatchObject({
      quantity: 1,
      items: expect.arrayContaining([
        { sku: 'SKU-C', quantity: 20 },
        { sku: 'SKU-B', quantity: 10 },
      ]),
    })
  })
})

describe('装箱单样例二：英文表头、英寸磅', () => {
  const csv = ['Carton No.,Item No.,Description,Qty per Carton,No. of Cartons,Length (in),Width (in),Height (in),Gross Weight (lb)', '1,SKU-A,Bluetooth headset,12,5,16,12,10,20.5'].join('\n')
  it('单位取自表头，不做换算；一行就是 5 个相同的箱子', () => {
    const result = analyze(csv)
    expect(result.headerLine).toBe(1)
    expect(result.units).toEqual({ length: 'IN', weight: 'LB' })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ perBox: 12, boxCount: 5, lengthIn: 16, widthIn: 12, heightIn: 10, weightLb: 20.5, status: 'MATCHED', sku: 'SKU-A' })
    const resolved = resolvePacking(result.rows, [], planSkus, null)
    expect(resolved.boxes).toEqual([expect.objectContaining({ quantity: 5, weightLb: 20.5, items: [{ sku: 'SKU-A', quantity: 12 }] })])
  })

  it('请求里指定的单位优先于表头；保存的映射优先于自动识别', () => {
    expect(analyze(csv, { units: { length: 'CM' } }).rows[0]!.lengthIn).toBe(6.3)
    const saved = analyze(csv.replace('Item No.', '物料'), { savedColumns: { code: '物料' } })
    expect(saved.columnSources.code).toBe('SAVED')
    expect(saved.rows[0]!.sku).toBe('SKU-A')
  })
})

describe('装箱单样例三：只有品名与数量，用默认箱规', () => {
  const csv = ['品名,数量', '蓝牙耳机 黑色,20', '手机壳 红色,30'].join('\n')
  it('品名相似只给候选，不自动采用；没有决定就不能应用', () => {
    const result = analyze(csv)
    expect(result.missingFields).toEqual([])
    expect(result.rows.map(row => [row.status, row.candidates[0]?.sku ?? null])).toEqual([
      ['CANDIDATE', 'SKU-A'],
      ['CANDIDATE', 'SKU-B'],
    ])
    expect(result.rows.every(row => row.sku === null)).toBe(true)
    expect(result.notes.join('')).toContain('每一行按一个箱子处理')
    const blocked = resolvePacking(result.rows, [], planSkus, { weightLb: 20, lengthIn: 16, widthIn: 12, heightIn: 10 })
    expect(blocked.boxes).toEqual([])
    expect(blocked.blockers).toHaveLength(2)
  })

  it('人工选了 SKU、给了默认箱规后可以应用；记住只记人工确认的对应关系；决定里的 SKU 必须在计划里', () => {
    const result = analyze(csv, { defaults: { weightLb: 20, lengthIn: 16, widthIn: 12, heightIn: 10 } })
    const defaults = { weightLb: 20, lengthIn: 16, widthIn: 12, heightIn: 10 }
    const ok = resolvePacking(
      result.rows,
      [
        { line: 2, sku: 'SKU-A', remember: true },
        { line: 3, ignore: true },
      ],
      planSkus,
      defaults,
    )
    expect(ok.blockers).toEqual([])
    expect(ok.ignoredLines).toEqual([3])
    expect(ok.remember).toEqual([{ externalCode: '蓝牙耳机 黑色', sku: 'SKU-A', line: 2 }])
    expect(ok.boxes).toHaveLength(1)
    const outside = resolvePacking(
      result.rows,
      [
        { line: 2, sku: 'SKU-X' },
        { line: 3, ignore: true },
      ],
      planSkus,
      defaults,
    )
    expect(outside.blockers.join('')).toContain('SKU-X 不在这个计划里')
    expect(
      resolvePacking(
        result.rows,
        [
          { line: 9, ignore: true },
          { line: 2, ignore: true },
          { line: 3, ignore: true },
        ],
        planSkus,
        defaults,
      ).blockers.join(''),
    ).toContain('决定里的第 9 行不在这份文件里')
  })
})

describe('匹配顺序与相似度', () => {
  it('精确匹配顺序：SKU → FNSKU → ASIN → 外部货号映射；供应商专属映射优先于通用映射；目标不在计划里不采用', () => {
    const csv = ['货号,数量', 'SKU-B,1', 'X0AAAAAAAA,2', 'B0AAAAAAAA,3', 'ZZ-1,4', 'ZZ-2,5'].join('\n')
    const aliases = [
      { supplierId: null, externalCode: 'ZZ-1', sku: 'SKU-B' },
      { supplierId: SUPPLIER, externalCode: 'ZZ-1', sku: 'SKU-C' },
      { supplierId: null, externalCode: 'ZZ-2', sku: 'SKU-NOT-IN-PLAN' },
    ]
    const rows = analyze(csv, { aliases }).rows
    expect(rows.map(row => [row.basis, row.sku])).toEqual([
      ['SKU', 'SKU-B'],
      ['FNSKU', 'SKU-A'],
      ['ASIN', 'SKU-A'],
      ['ALIAS', 'SKU-C'],
      [null, null],
    ])
    expect(rows[4]!.note).toContain('SKU-NOT-IN-PLAN')
  })

  it('其他供应商的专属映射不会被用到', () => {
    const rows = analyze('货号,数量\nZZ-1,4', { aliases: [{ supplierId: 'other', externalCode: 'ZZ-1', sku: 'SKU-C' }] }).rows
    expect(rows[0]!.status).not.toBe('MATCHED')
  })

  it('相似度：完全相同为 1，无关为 0，包含关系有加成，中英文都能算', () => {
    expect(textSimilarity('蓝牙耳机 黑色', '蓝牙耳机黑色')).toBe(1)
    expect(textSimilarity('abc', 'xyz')).toBe(0)
    expect(textSimilarity('手机壳', '手机壳 红色')).toBeGreaterThan(textSimilarity('手机', '手机壳 红色') - 0.5)
    expect(textSimilarity('Bluetooth Headset', 'bluetooth headset black')).toBeGreaterThan(0.6)
  })
})

describe('异常与边界', () => {
  it('空文件、列不齐、超行、坏数字都有明确的说法', () => {
    expect(analyze('').fatal).toBe('文件是空的')
    const noQty = analyze('货号\nSKU-A')
    expect(noQty.missingFields).toEqual(['每箱件数或数量'])
    expect(noQty.rows).toEqual([])
    const bad = analyze('货号,每箱数量,箱数\nSKU-A,abc,2\nSKU-B,5,0')
    expect(bad.rows[0]!.issues[0]).toContain('不是数字')
    expect(bad.rows[1]!.issues[0]).toContain('1 到')
    expect(resolvePacking(bad.rows, [], planSkus, { weightLb: 1, lengthIn: 1, widthIn: 1, heightIn: 1 }).boxes).toEqual([])
    const many = ['货号,数量', ...Array.from({ length: 2001 }, (_, index) => `S${index},1`)].join('\n')
    expect(analyze(many).fatal).toContain('一次最多处理 2000 行')
  })

  it('指定的表头行超出范围、数量对不上只提醒、同箱箱规不一致阻止应用', () => {
    expect(analyze(CHINESE, { headerLine: 99 }).fatal).toContain('超出了文件范围')
    const mismatch = analyze('货号,数量,每箱数量,箱数\nSKU-A,25,10,2')
    expect(mismatch.rows[0]!.warnings.join('')).toContain('对不上')
    const clash = analyze(['箱号,货号,每箱数量,长cm,宽cm,高cm,重量kg', '1,SKU-A,5,40,30,20,10', '1,SKU-B,5,50,30,20,10'].join('\n'))
    const resolved = resolvePacking(clash.rows, [], planSkus, null)
    expect(resolved.boxes).toEqual([])
    expect(resolved.blockers.join('')).toContain('不一致')
  })

  it('表头识别：标题行与说明行不会被当成表头', () => {
    const table = parseCsvTable(CHINESE)
    expect(detectHeaderRow(table)).toBe(3)
  })
})
