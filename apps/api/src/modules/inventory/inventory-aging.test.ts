import { describe, expect, it } from 'vitest'
import { ageFeeBands, ageView, crossings, type AgeColumns, type AgeFeeColumns } from './inventory-aging'

const coarse = (over: Partial<AgeColumns> = {}): AgeColumns => ({
  age0to90: 100,
  age91to180: 50,
  age181to270: 20,
  age271to365: 10,
  age365plus: 0,
  age0to30: null,
  age31to60: null,
  age61to90: null,
  age366to455: null,
  age456plus: null,
  ...over,
})
const fine = (over: Partial<AgeColumns> = {}): AgeColumns => coarse({ age0to30: 40, age31to60: 30, age61to90: 30, age366to455: 0, age456plus: 0, ...over })
const fees = (over: Partial<AgeFeeColumns> = {}): AgeFeeColumns => ({
  aisEst181To210: 1,
  aisEst211To240: 1,
  aisEst241To270: 1,
  aisEst271To300: 2,
  aisEst301To330: 2,
  aisEst331To365: 2,
  aisEst365Plus: null,
  ...over,
})

describe('库龄分段视图', () => {
  it('细分段齐全用 8 段，否则退化为 5 段，全空则没有库龄数据', () => {
    expect(ageView(fine()).granularity).toBe('FINE')
    expect(ageView(fine()).buckets).toHaveLength(8)
    expect(ageView(coarse()).granularity).toBe('COARSE')
    expect(ageView(coarse()).buckets).toHaveLength(5)
    expect(ageView(coarse({ age0to90: null, age91to180: null, age181to270: null, age271to365: null, age365plus: null })).granularity).toBeNull()
    expect(ageView(null).buckets).toEqual([])
  })

  it('费用分档：缺失的档保持 null，不补 0', () => {
    const bands = ageFeeBands(fees())
    expect(bands).toHaveLength(7)
    expect(bands[6]).toEqual({ label: '365 天以上', amount: null })
    expect(ageFeeBands(null)).toEqual([])
  })
})

describe('库龄跨档时间线', () => {
  const snapshot = '2026-10-20'

  it('只列有库存要跨档的边界；窗口按分段上下界给出：最早次日，最晚 = 快照日 + (边界 − 分段起点)', () => {
    const list = crossings(coarse({ age181to270: 20, age271to365: 0, age91to180: 0, age0to90: 0 }), fees(), snapshot, '2026-10-22')
    expect(list.map(item => item.boundaryDays)).toEqual([271])
    expect(list[0]).toMatchObject({ qty: 20, earliestDate: '2026-10-21', latestDate: '2027-01-18', toLabel: '271-365 天', feeTier: true, likelyCrossed: false })
  })

  it('跨入收费档：预计新增 = 跨档数量 × 目标档当前平均单价（目标档费用 ÷ 目标档数量）', () => {
    const list = crossings(coarse({ age91to180: 0, age181to270: 20, age271to365: 10 }), fees(), snapshot, '2026-10-22')
    // 目标档 271-365：费用 6，数量 10，单价 0.6；20 件 → 12
    expect(list.find(item => item.boundaryDays === 271)?.estimatedIncrease).toBe(12)
  })

  it('目标档当前没有库存：不推算，写明原因，金额为 null', () => {
    const list = crossings(coarse({ age91to180: 0, age181to270: 20, age271to365: 0 }), fees(), snapshot, '2026-10-22')
    const item = list.find(entry => entry.boundaryDays === 271)
    expect(item?.estimatedIncrease).toBeNull()
    expect(item?.note).toContain('无法用自身数据推算')
  })

  it('不收费的边界（进入 91-180 天）说明不收库龄附加费；窗口已过标记 likelyCrossed', () => {
    const list = crossings(coarse({ age0to90: 30, age91to180: 0, age181to270: 0, age271to365: 0 }), null, '2026-01-01', '2026-10-22')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ boundaryDays: 91, feeTier: false, estimatedIncrease: null, likelyCrossed: true })
    expect(list[0].note).toContain('不收取')
  })

  it('没有库龄数据：空列表；没有费用报告时说明缺少预估', () => {
    expect(crossings(null, null, snapshot, '2026-10-22')).toEqual([])
    const list = crossings(coarse({ age181to270: 0, age91to180: 5 }), null, snapshot, '2026-10-22')
    expect(list.find(item => item.boundaryDays === 181)?.note).toContain('尚无库存规划报告')
  })
})
