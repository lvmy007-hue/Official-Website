import { describe, expect, it } from 'vitest'
import { analyzePacking, parseCsvTable } from '@nova/api-contracts'
import { mappingColumns } from './SaveMappingAction'
import { EMPTY_SETTINGS, bytesToBase64, decisionList, formatOf, liveBoxIssues, readiness, requestBody, sizeProblem, unitsOrDefault, verdictOf, withDecision } from './packing-list-state'

// 装箱单页签的纯逻辑（P6-11）：文件格式、请求体、人工决定、应用前的就绪判断（与服务端用同一个 resolvePacking）。

const ITEMS = [
  { sku: 'SKU-A', fnsku: null, asin: null, productName: '蓝牙耳机 黑色' },
  { sku: 'SKU-B', fnsku: null, asin: null, productName: '手机壳 红色' },
]
const PLAN = new Set(ITEMS.map(item => item.sku))
const CSV = ['货号,每箱数量,箱数,长(in),宽(in),高(in),毛重(lb)', 'SKU-A,10,1,12,12,12,20', 'ZZ-9,5,1,12,12,12,10', 'SKU-B,5,1,12,12,12'].join('\n')
const analysis = (csv = CSV) => analyzePacking({ table: parseCsvTable(csv), items: ITEMS, aliases: [], supplierId: null })

describe('文件与请求体', () => {
  it('按扩展名判断格式：xlsx 读 Excel，xls 不支持，其余当 CSV', () => {
    expect(formatOf('a.XLSX')).toBe('XLSX')
    expect(formatOf('a.xlsm')).toBe('XLSX')
    expect(formatOf('a.xls')).toBe('XLS')
    expect(formatOf('a.csv')).toBe('CSV')
    expect(formatOf('a.txt')).toBe('CSV')
  })

  it('文件太大给出原因；二进制转 base64 与浏览器一致', () => {
    expect(sizeProblem({ fileName: 'a.csv', format: 'CSV', content: 'x'.repeat(500_000) })).toMatch(/文件过大/)
    expect(sizeProblem({ fileName: 'a.csv', format: 'CSV', content: 'x' })).toBeNull()
    expect(bytesToBase64(new Uint8Array([80, 75, 3, 4]))).toBe('UEsDBA==')
    expect(bytesToBase64(new Uint8Array(100_000)).length).toBeGreaterThan(100_000)
  })

  it('请求体只带填过的识别设置：没填的不进去（服务端按保存的映射与表头处理）', () => {
    const file = { fileName: 'a.csv', format: 'CSV' as const, content: 'x' }
    expect(requestBody(file, EMPTY_SETTINGS)).toEqual({ fileName: 'a.csv', format: 'CSV', content: 'x', supplierId: null })
    const body = requestBody(
      { ...file, format: 'XLSX' },
      { supplierId: 's1', sheet: '第二页', headerLine: 3, columns: { code: 1, weight: null }, units: { length: 'IN' }, defaults: { weightLb: 20, lengthIn: 0, widthIn: null } },
    )
    expect(body).toEqual({
      fileName: 'a.csv',
      format: 'XLSX',
      content: 'x',
      supplierId: 's1',
      sheet: '第二页',
      headerLine: 3,
      columns: { code: 1, weight: null },
      units: { length: 'IN' },
      defaults: { weightLb: 20 },
    })
    // CSV 没有工作表：不带 sheet
    expect(requestBody(file, { ...EMPTY_SETTINGS, sheet: '第二页' })).not.toHaveProperty('sheet')
  })

  it('单位：手动选的优先，其次识别到的，最后默认厘米与千克', () => {
    expect(unitsOrDefault({}, null)).toEqual({ length: 'CM', weight: 'KG' })
    expect(unitsOrDefault({ weight: 'LB' }, { length: 'IN', weight: 'KG' })).toEqual({ length: 'IN', weight: 'LB' })
  })
})

describe('人工决定', () => {
  it('选了 SKU 取消忽略；忽略会清掉 SKU 与“记住”；清除 SKU 也取消“记住”', () => {
    let map = withDecision({}, 3, { sku: 'SKU-B', remember: true })
    expect(map[3]).toEqual({ line: 3, sku: 'SKU-B', remember: true, ignore: false })
    map = withDecision(map, 3, { ignore: true })
    expect(map[3]).toEqual({ line: 3, sku: null, remember: false, ignore: true })
    map = withDecision(map, 3, { sku: 'SKU-A' })
    expect(map[3]).toMatchObject({ sku: 'SKU-A', ignore: false })
    map = withDecision(withDecision(map, 3, { remember: true }), 3, { sku: null })
    expect(map[3]).toMatchObject({ sku: null, remember: false })
  })

  it('请求里的决定列表：没有内容的不传，按行号排序', () => {
    const map = withDecision(withDecision(withDecision({}, 5, { ignore: true }), 3, { sku: 'SKU-B', remember: true }), 4, { remember: false })
    expect(decisionList(map)).toEqual([
      { line: 3, sku: 'SKU-B', remember: true },
      { line: 5, ignore: true },
    ])
  })
})

describe('应用前的就绪判断', () => {
  it('每一行的结果：忽略、有问题、待选 SKU、可装箱', () => {
    const result = analysis()
    const [first, second, third] = result.rows
    expect(verdictOf(first!, undefined)).toBe('READY')
    expect(verdictOf(second!, undefined)).toBe('NEEDS_SKU')
    expect(verdictOf(second!, { line: second!.line, sku: 'SKU-B' })).toBe('READY')
    expect(verdictOf(second!, { line: second!.line, ignore: true })).toBe('IGNORED')
    // 第三行没写重量：装箱后才看得出缺箱规（liveBoxIssues 给出），填了默认箱规就没有了
    expect(verdictOf(third!, undefined)).toBe('READY')
    const live = liveBoxIssues(result, {}, null)
    expect([...live.keys()]).toEqual([4])
    expect(verdictOf(third!, undefined, live.get(4))).toBe('PROBLEM')
    expect(liveBoxIssues(result, {}, { weightLb: 15 }).size).toBe(0)
  })

  it('没解决的行挡住应用，并写明哪一行；解决后才可应用', () => {
    const result = analysis()
    const none = readiness(result, {}, PLAN, null)
    expect(none.canApply).toBe(false)
    expect(none.blockers.join('')).toMatch(/第 3 行/)
    expect(none).toMatchObject({ total: 3, ready: 1, needsSku: 1, problems: 1 })

    const solved = readiness(result, withDecision({}, 3, { sku: 'SKU-B', remember: true }), PLAN, { weightLb: 15 })
    expect(solved.blockers).toEqual([])
    expect(solved.canApply).toBe(true)
    expect(solved).toMatchObject({ ready: 3, toRemember: 1 })
  })

  it('选的 SKU 不在计划里、全部忽略：都不能应用', () => {
    const result = analysis()
    expect(readiness(result, withDecision({}, 3, { sku: 'GHOST' }), PLAN, { weightLb: 15 }).canApply).toBe(false)
    const all = [2, 3, 4].reduce((map, line) => withDecision(map, line, { ignore: true }), {})
    expect(readiness(result, all, PLAN, null).canApply).toBe(false)
  })

  it('没有预览或整份文件有问题：什么都没有，不能应用', () => {
    expect(readiness(null, {}, PLAN, null).canApply).toBe(false)
    expect(readiness(analysis('x,y\n'), {}, PLAN, null)).toMatchObject({ total: 0, canApply: false })
  })
})

describe('保存列映射的内容', () => {
  it('保存“标准列 → 表头文字”，手动改过的优先，选了“没有这一列”的不保存', () => {
    const result = analysis()
    const preview = {
      ...result,
      planId: 'p',
      fileName: 'a',
      format: 'CSV' as const,
      sheet: null,
      sheets: [],
      supplier: null,
      savedMapping: false,
      canApply: true,
      applyBlockedReason: null,
      existingBoxTypes: 0,
      canRemember: true,
      rememberBlockedReason: null,
    }
    expect(mappingColumns(preview, EMPTY_SETTINGS)).toMatchObject({ code: '货号', perBox: '每箱数量', boxCount: '箱数' })
    const edited = mappingColumns(preview, { ...EMPTY_SETTINGS, columns: { boxCount: null, name: 1 } })
    expect(edited).not.toHaveProperty('boxCount')
    expect(edited.name).toBe('每箱数量')
  })
})
