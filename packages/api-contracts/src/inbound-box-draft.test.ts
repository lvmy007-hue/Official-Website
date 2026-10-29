import { describe, expect, it } from 'vitest'
import { applyBoxSpecs, boxDraftIssues, boxDraftTotals, boxDraftsToInputs, copyBoxDraft, draftsFromServer, newBoxDraft, nextBoxId, type BoxDraft } from './inbound-box-draft.js'

const plan = [
  { sku: 'A', quantity: 10 },
  { sku: 'B', quantity: 4 },
]
const draft = (over: Partial<Omit<BoxDraft, 'key'>> = {}): BoxDraft =>
  draftsFromServer([{ boxId: 'B1', packingGroupId: null, quantity: 2, weightLb: 20, lengthIn: 12, widthIn: 12, heightIn: 12, items: [{ sku: 'A', quantity: 5 }], ...over }])[0]!

describe('装箱草稿：加箱、复制、批量设箱规', () => {
  it('新箱的箱号取最小的没被占用的编号，箱规沿用最后一箱', () => {
    expect(nextBoxId([])).toBe('BOX-001')
    expect(nextBoxId([draft({ boxId: 'BOX-001' }), draft({ boxId: 'BOX-003' })])).toBe('BOX-002')
    const fresh = newBoxDraft([draft({ boxId: 'BOX-001', weightLb: 9 })])
    expect(fresh).toMatchObject({ boxId: 'BOX-002', quantity: 1, weightLb: 9, lengthIn: 12, items: [] })
    expect(newBoxDraft([])).toMatchObject({ boxId: 'BOX-001', weightLb: null, lengthIn: null })
  })

  it('复制箱：插在原箱后面，新箱号、新标识，箱内物品是副本（改副本不影响原箱）', () => {
    const first = draft({ boxId: 'BOX-001' })
    const second = draft({ boxId: 'BOX-002' })
    const result = copyBoxDraft([first, second], first.key)
    expect(result.map(box => box.boxId)).toEqual(['BOX-001', 'BOX-003', 'BOX-002'])
    expect(new Set(result.map(box => box.key)).size).toBe(3)
    result[1]!.items[0]!.quantity = 99
    expect(first.items[0]!.quantity).toBe(5)
    expect(copyBoxDraft([first], 'nope')).toEqual([first])
  })

  it('批量设箱规：只改选中的箱，只改给了值的项', () => {
    const first = draft({ boxId: 'X1' })
    const second = draft({ boxId: 'X2' })
    const result = applyBoxSpecs([first, second], new Set([first.key]), { weightLb: 30, heightIn: 8 })
    expect(result[0]).toMatchObject({ weightLb: 30, heightIn: 8, lengthIn: 12, widthIn: 12 })
    expect(result[1]).toBe(second)
  })
})

describe('装箱草稿：底部合计', () => {
  it('按 SKU 对比已装与计划，不一致的 diff 不为 0；箱数含相同箱数；总重与总体积按箱数放大', () => {
    const totals = boxDraftTotals([draft({ quantity: 2, items: [{ sku: 'A', quantity: 4 }] }), draft({ boxId: 'B2', quantity: 1, weightLb: 10, items: [{ sku: 'B', quantity: 4 }] })], plan)
    expect(totals.skuRows).toEqual([
      { sku: 'A', planned: 10, packed: 8, diff: -2 },
      { sku: 'B', planned: 4, packed: 4, diff: 0 },
    ])
    expect(totals).toMatchObject({ boxCount: 3, boxTypes: 2, packedUnits: 12, plannedUnits: 14, totalWeightLb: 50, matched: false, incompleteBoxes: 0, unknownSkus: [] })
    // 12×12×12 英寸 = 1 立方英尺；3 箱
    expect(totals.totalVolumeCubicFeet).toBe(3)
  })

  it('全部一致才算匹配；装了计划外的 SKU 不算匹配并列出', () => {
    expect(boxDraftTotals([draft({ quantity: 2 }), draft({ boxId: 'B2', quantity: 1, items: [{ sku: 'B', quantity: 4 }] })], plan).matched).toBe(true)
    const extra = boxDraftTotals(
      [
        draft({
          quantity: 2,
          items: [
            { sku: 'A', quantity: 5 },
            { sku: 'ZZ', quantity: 1 },
          ],
        }),
      ],
      plan,
    )
    expect(extra.unknownSkus).toEqual(['ZZ'])
    expect(extra.matched).toBe(false)
  })

  it('没填完的箱子：重量与体积只合计已填的，并告知有几个箱型没填全；一个都没填时合计为空而不是 0', () => {
    const partial = boxDraftTotals([draft(), draft({ boxId: 'B2', weightLb: null, heightIn: null })], plan)
    expect(partial.incompleteBoxes).toBe(1)
    expect(partial.totalWeightLb).toBe(40)
    const none = boxDraftTotals([draft({ weightLb: null, lengthIn: null })], plan)
    expect(none.totalWeightLb).toBeNull()
    expect(none.totalVolumeCubicFeet).toBeNull()
    expect(boxDraftTotals([], plan)).toMatchObject({ boxCount: 0, packedUnits: 0, plannedUnits: 14, totalWeightLb: null })
  })
})

describe('装箱草稿：保存前的本地校验', () => {
  it('合格的草稿没有问题（数量与计划不一致不拦，只提示）', () => {
    expect(boxDraftIssues([draft()], plan)).toEqual([])
  })

  it('没有箱子、箱号为空或重复、箱规与数量不合法、没有商品、商品不在计划里或重复都会被拦', () => {
    expect(boxDraftIssues([], plan)).toEqual(['至少添加一个箱子'])
    const issues = boxDraftIssues(
      [
        draft({ boxId: '', quantity: 0, weightLb: null, items: [] }),
        draft({ boxId: 'D', lengthIn: 0 }),
        draft({
          boxId: 'D',
          items: [
            { sku: 'ZZ', quantity: 1 },
            { sku: 'A', quantity: null },
            { sku: 'A', quantity: 2 },
          ],
        }),
      ],
      plan,
    )
    const text = issues.join('\n')
    for (const part of ['第 1 箱没有箱号', '相同箱数要是', '重量（磅）要填大于 0', '里还没有商品', 'D 的长（英寸）要填大于 0', '箱号 D 重复', 'ZZ 不在这个计划里', 'A 重复', '数量要是大于 0 的整数'])
      expect(text, part).toContain(part)
  })

  it('通过校验后转成提交体：箱号去空白，装箱组只在有值时带上', () => {
    const inputs = boxDraftsToInputs([draft({ boxId: ' B1 ', packingGroupId: 'pg1' }), draft({ boxId: 'B2' })])
    expect(inputs[0]).toMatchObject({ boxId: 'B1', packingGroupId: 'pg1', quantity: 2, items: [{ sku: 'A', quantity: 5 }] })
    expect(inputs[1]).not.toHaveProperty('packingGroupId')
  })
})
