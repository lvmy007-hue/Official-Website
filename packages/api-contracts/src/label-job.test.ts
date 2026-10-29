import { describe, expect, it } from 'vitest'
import { DEFAULT_BOX_NO_RULE, DEFAULT_LABEL_OPTIONS } from './label-template.js'
import { ITEM_LABEL_SIZES, ITEM_LABEL_SIZE_SPEC, boxContentFacts, boxLabelLines, itemLabelsTotal, parseBoxLabelJob, parseItemLabelJob, type BoxContentFacts } from './label-job.js'

const names = new Map([
  ['A', { productName: 'Desk lamp', fnsku: 'X001AAAAAA' }],
  ['B', { productName: null, fnsku: 'X002BBBBBB' }],
])
const facts = (input: Partial<Parameters<typeof boxContentFacts>[0]>) => boxContentFacts({ boxes: [], shipmentItems: [], boxCount: 2, names, ...input })

describe('箱内内容的确定规则', () => {
  it('没有装箱记录：不印，并说明原因', () => {
    const result = facts({})
    expect(result.facts).toBeNull()
    expect(result.note).toContain('还没有装箱记录')
  })

  it('所有箱子内容一致且货件数量核对得上：印 SKU、品名、FNSKU、件数', () => {
    const result = facts({ boxes: [{ quantity: 2, items: [{ sku: 'A', quantity: 12 }] }], shipmentItems: [{ sku: 'A', quantity: 24 }] })
    expect(result).toEqual({ facts: { items: [{ sku: 'A', quantity: 12, productName: 'Desk lamp', fnsku: 'X001AAAAAA' }] }, note: null })
  })

  it('多行装箱记录但内容相同、行内商品顺序不同，也算一致', () => {
    const result = facts({
      boxes: [
        {
          quantity: 1,
          items: [
            { sku: 'A', quantity: 2 },
            { sku: 'B', quantity: 3 },
          ],
        },
        {
          quantity: 1,
          items: [
            { sku: 'B', quantity: 3 },
            { sku: 'A', quantity: 2 },
          ],
        },
      ],
      shipmentItems: [
        { sku: 'A', quantity: 4 },
        { sku: 'B', quantity: 6 },
      ],
    })
    expect(result.facts?.items.map(item => item.sku).sort()).toEqual(['A', 'B'])
  })

  it('货件还没有商品明细、或数量与箱数 × 每箱件数对不上：不印', () => {
    const boxes = [{ quantity: 2, items: [{ sku: 'A', quantity: 12 }] }]
    expect(facts({ boxes }).facts).toBeNull()
    expect(facts({ boxes }).note).toContain('还没有同步')
    expect(facts({ boxes, shipmentItems: [{ sku: 'A', quantity: 23 }] }).note).toContain('对不上')
    expect(
      facts({
        boxes,
        shipmentItems: [
          { sku: 'A', quantity: 24 },
          { sku: 'B', quantity: 1 },
        ],
      }).facts,
    ).toBeNull()
  })

  it('各箱件数不同但都只装同一个 SKU：印 SKU，不印件数，并说明', () => {
    const result = facts({
      boxes: [
        { quantity: 1, items: [{ sku: 'A', quantity: 10 }] },
        { quantity: 1, items: [{ sku: 'A', quantity: 14 }] },
      ],
      shipmentItems: [{ sku: 'A', quantity: 24 }],
    })
    expect(result.facts).toEqual({ items: [{ sku: 'A', quantity: null, productName: 'Desk lamp', fnsku: 'X001AAAAAA' }] })
    expect(result.note).toContain('件数不同')
  })

  it('同一个 SKU 但货件里是别的商品：不印', () => {
    const boxes = [
      { quantity: 1, items: [{ sku: 'A', quantity: 10 }] },
      { quantity: 1, items: [{ sku: 'A', quantity: 14 }] },
    ]
    expect(facts({ boxes, shipmentItems: [{ sku: 'B', quantity: 24 }] }).facts).toBeNull()
  })

  it('混装且各箱不同：什么都不印', () => {
    const result = facts({
      boxes: [
        { quantity: 1, items: [{ sku: 'A', quantity: 10 }] },
        { quantity: 1, items: [{ sku: 'B', quantity: 14 }] },
      ],
      shipmentItems: [
        { sku: 'A', quantity: 10 },
        { sku: 'B', quantity: 14 },
      ],
    })
    expect(result.facts).toBeNull()
    expect(result.note).toContain('各箱内容不同')
  })

  it('数量为 0 或没有商品的行不参与判断', () => {
    const result = facts({
      boxes: [
        { quantity: 0, items: [{ sku: 'B', quantity: 1 }] },
        { quantity: 2, items: [] },
        { quantity: 2, items: [{ sku: 'A', quantity: 12 }] },
      ],
      shipmentItems: [{ sku: 'A', quantity: 24 }],
    })
    expect(result.facts?.items).toHaveLength(1)
  })
})

describe('标签上的文字行', () => {
  const one: BoxContentFacts = { items: [{ sku: 'A', quantity: 12, productName: 'Desk lamp', fnsku: 'X001AAAAAA' }] }
  const all = { ...DEFAULT_LABEL_OPTIONS, showProductName: true, showFnsku: true }

  it('按勾选项依次给出箱号、原产地、SKU、品名、FNSKU、件数', () => {
    expect(boxLabelLines(all, 'BOX-003', one)).toEqual(['Box No: BOX-003', 'Origin: Made in China', 'SKU: A', 'Item: Desk lamp', 'FNSKU: X001AAAAAA', 'Units per box: 12'])
  })

  it('内容不能确定（facts 为空）时只印箱号和原产地', () => {
    expect(boxLabelLines(all, 'BOX-003', null)).toEqual(['Box No: BOX-003', 'Origin: Made in China'])
  })

  it('取消勾选的项不印；原产地文字为空不印', () => {
    const options = { ...DEFAULT_LABEL_OPTIONS, showBoxNo: false, showSku: false, showUnits: false, originText: '  ' }
    expect(boxLabelLines(options, 'BOX-003', one)).toEqual([])
  })

  it('多种商品：SKU 带件数；FNSKU 只在单品时印；件数合计', () => {
    const many: BoxContentFacts = {
      items: [
        { sku: 'A', quantity: 2, productName: null, fnsku: 'X001AAAAAA' },
        { sku: 'B', quantity: 3, productName: 'Fan', fnsku: 'X002BBBBBB' },
      ],
    }
    expect(boxLabelLines(all, 'B1', many)).toEqual(['Box No: B1', 'Origin: Made in China', 'SKU: A x 2', 'SKU: B x 3', 'Item: Fan', 'Units per box: 5'])
  })

  it('件数未知时不印件数', () => {
    expect(boxLabelLines(all, 'B1', { items: [{ sku: 'A', quantity: null, productName: null, fnsku: null }] })).toEqual(['Box No: B1', 'Origin: Made in China', 'SKU: A'])
  })
})

describe('任务载荷读取', () => {
  const box = {
    planId: 'p1',
    shipmentRowId: 's1',
    shipmentLabel: 'FBA1',
    destinationFc: 'ONT8',
    planName: '计划',
    planNo: 'wf-1',
    baseLabelJobId: 'lj1',
    templateId: null,
    templateName: '默认设置',
    paper: 'THERMAL_4X6',
    options: DEFAULT_LABEL_OPTIONS,
    boxNoRule: DEFAULT_BOX_NO_RULE,
    boxCount: 3,
    startNumber: 1,
    facts: { items: [{ sku: 'A', quantity: 12, productName: null, fnsku: null }] },
    notes: ['说明', 5],
  }

  it('箱标签任务：完整载荷原样读出，notes 只保留文字', () => {
    const parsed = parseBoxLabelJob(box)
    expect(parsed).toMatchObject({ planId: 'p1', paper: 'THERMAL_4X6', boxCount: 3, startNumber: 1, notes: ['说明'], facts: { items: [{ sku: 'A', quantity: 12 }] } })
  })

  it('箱标签任务：缺字段或值不合格一律返回 null', () => {
    for (const patch of [{ paper: 'LETTER' }, { planId: '' }, { shipmentRowId: undefined }, { baseLabelJobId: 1 }, { boxCount: 0 }, { boxCount: 2001 }, { boxCount: 1.5 }, { startNumber: -1 }]) {
      expect(parseBoxLabelJob({ ...box, ...patch })).toBeNull()
    }
    expect(parseBoxLabelJob(null)).toBeNull()
    expect(parseBoxLabelJob([])).toBeNull()
  })

  it('箱标签任务：损坏的 facts 当作没有内容，不当作有内容', () => {
    expect(parseBoxLabelJob({ ...box, facts: { items: [{ sku: '' }] } })?.facts).toBeNull()
    expect(parseBoxLabelJob({ ...box, facts: 'x' })?.facts).toBeNull()
  })

  const item = { planId: 'p1', shipmentRowId: null, size: 'THERMAL_60X40', showTitle: true, lines: [{ sku: 'A', fnsku: 'X001AAAAAA', title: null, quantity: 5 }] }

  it('商品标签任务：读出载荷；showCondition 缺省为 false', () => {
    expect(parseItemLabelJob(item)).toEqual({ planId: 'p1', shipmentRowId: null, size: 'THERMAL_60X40', showTitle: true, showCondition: false, lines: item.lines })
  })

  it('商品标签任务：尺寸不对、没有行、数量不是正整数、缺 FNSKU 都返回 null', () => {
    for (const patch of [
      { size: 'X' },
      { lines: [] },
      { lines: [{ ...item.lines[0], quantity: 0 }] },
      { lines: [{ ...item.lines[0], fnsku: '' }] },
      { lines: [{ ...item.lines[0], sku: undefined }] },
      { planId: '' },
    ]) {
      expect(parseItemLabelJob({ ...item, ...patch })).toBeNull()
    }
  })

  it('商品标签纸规格：热敏标签一页一张；A4 拼版的格子放得进页面', () => {
    for (const size of ITEM_LABEL_SIZES) {
      const spec = ITEM_LABEL_SIZE_SPEC[size]
      const right = spec.marginLeftPt + (spec.cols - 1) * spec.pitchXPt + spec.widthPt
      const bottom = spec.marginTopPt + (spec.rows - 1) * spec.pitchYPt + spec.heightPt
      expect(right).toBeLessThanOrEqual(spec.pageWidthPt + 0.01)
      expect(bottom).toBeLessThanOrEqual(spec.pageHeightPt + 0.01)
    }
    expect(ITEM_LABEL_SIZE_SPEC.THERMAL_60X40.cols * ITEM_LABEL_SIZE_SPEC.THERMAL_60X40.rows).toBe(1)
    expect(itemLabelsTotal([{ quantity: 3 }, { quantity: 4 }])).toBe(7)
  })
})
