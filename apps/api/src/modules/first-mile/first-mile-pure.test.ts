import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { allocateCost, allocationReadiness, type AllocationInput } from './allocation-math'
import { delayDaysOf } from './first-mile-rows'
import { normalizeMilestone, parseMilestoneFile, parseOccurredAt } from './milestone-file'
import { monthlyStats, summarizeDays, transitDaysOf } from './transit-math'

// 头程物流的纯函数：费用分摊、节点文件解析、时效统计、延误天数。

const item = (sku: string, quantity: number, over: Partial<AllocationInput> = {}): AllocationInput => ({ sku, quantity, volumeCbm: null, weightKg: null, goodsValue: null, ...over })
const sum = (lines: Array<{ amount: Prisma.Decimal }>) => lines.reduce((total, line) => total.plus(line.amount), new Prisma.Decimal(0)).toString()

describe('费用分摊', () => {
  it('按体积分摊：各行之和恰好等于合计，舍入余数落在权重最大的 SKU 上', () => {
    const result = allocateCost([item('B', 10, { volumeCbm: 1 }), item('A', 30, { volumeCbm: 1 }), item('C', 10, { volumeCbm: 1 })], 'VOLUME', '100')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines.map(line => line.sku)).toEqual(['A', 'B', 'C'])
    expect(sum(result.lines)).toBe('100')
    // 100 / 3 = 33.333333…，余数 0.000001 加到并列最大里字典序靠前的 A
    expect(result.lines[0].amount.toString()).toBe('33.333334')
    expect(result.lines[1].amount.toString()).toBe('33.333333')
  })

  it('按件数、重量、货值分别取对应列；每件成本 = 分摊额 / 数量（6 位小数）', () => {
    const items = [item('A', 100, { weightKg: 30, goodsValue: 1000 }), item('B', 300, { weightKg: 10, goodsValue: 3000 })]
    const byQty = allocateCost(items, 'QTY', 400)
    const byWeight = allocateCost(items, 'WEIGHT', 400)
    const byValue = allocateCost(items, 'VALUE', 400)
    if (!byQty.ok || !byWeight.ok || !byValue.ok) throw new Error('应当可分摊')
    expect(byQty.lines.map(line => line.amount.toString())).toEqual(['100', '300'])
    expect(byWeight.lines.map(line => line.amount.toString())).toEqual(['300', '100'])
    expect(byValue.lines.map(line => line.amount.toString())).toEqual(['100', '300'])
    expect(byWeight.lines[0].unitCost.toString()).toBe('3')
    expect(byQty.lines[1].unitCost.toString()).toBe('1')
  })

  it('任一 SKU 缺所选口径的数据就拒绝，并写明缺哪些；不拿 0 或平均数顶替', () => {
    const items = [item('A', 1, { volumeCbm: 2 }), item('B', 1), item('C', 1)]
    const result = allocateCost(items, 'VOLUME', 10)
    expect(result).toEqual({ ok: false, reason: 'B、C 没有填写体积' })
    expect(allocationReadiness(items, 'QTY')).toBeNull()
    expect(allocationReadiness([], 'QTY')).toBe('运单没有明细')
  })

  it('所选口径合计为 0 时拒绝', () => {
    expect(allocationReadiness([item('A', 1, { weightKg: 0 })], 'WEIGHT')).toBe('按重量合计为 0，无法分摊')
  })
})

describe('货代节点文件', () => {
  const header = '头程单号,节点,发生时间,地点,备注'
  it('认中英文表头与别名，把货代的叫法归到常用节点，认不出的原样保留', () => {
    const content = [header, 'WB-1,已提货,2026-10-01 09:30,深圳,', 'WB-1,Departed,2026-10-03,盐田港,', 'WB-1,海关查验,2026-10-12 08:00,洛杉矶,抽查'].join('\n')
    const { rows, errors } = parseMilestoneFile(content, 'WB-1', new Date('2026-10-20T00:00:00Z'))
    expect(errors).toEqual([])
    expect(rows.map(row => row.milestone)).toEqual(['PICKED_UP', 'DEPARTED', '海关查验'])
    // 无时区按北京时间：09:30+08:00 = 01:30Z
    expect(rows[0].occurredAt.toISOString()).toBe('2026-10-01T01:30:00.000Z')
    expect(rows[1].occurredAt.toISOString()).toBe('2026-10-02T16:00:00.000Z')
    expect(rows[2]).toMatchObject({ location: '洛杉矶', note: '抽查' })
  })

  it('运单号列可以省略；写了就必须等于当前运单号', () => {
    expect(parseMilestoneFile('milestone,time\nArrived,2026-10-05', 'WB-1', new Date('2026-10-20T00:00:00Z')).errors).toEqual([])
    const other = parseMilestoneFile(`${header}\nWB-2,到港,2026-10-05,,`, 'WB-1', new Date('2026-10-20T00:00:00Z'))
    expect(other.rows).toEqual([])
    expect(other.errors[0]).toContain('第 2 行')
    expect(other.errors[0]).toContain('不一致')
  })

  it('一行有错整份拒绝；缺必需列、空文件、未来时间、重复行都有明确说明', () => {
    const now = new Date('2026-10-20T00:00:00Z')
    expect(parseMilestoneFile('备注\nx', 'WB-1', now).errors[0]).toContain('缺少必需的列')
    expect(parseMilestoneFile(header, 'WB-1', now).errors[0]).toContain('没有数据行')
    const bad = parseMilestoneFile([header, ',到港,2026-13-45,,', ',到港,2026-12-31,,', ',到港,2026-10-05,,', ',到港,2026-10-05,,'].join('\n'), 'WB-1', now)
    expect(bad.rows).toEqual([])
    expect(bad.errors).toEqual(['第 2 行：发生时间“2026-13-45”格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm', '第 3 行：发生时间不能晚于今天', '第 5 行：同一节点同一时间出现了多次'])
  })

  it('时间解析：无时区按 UTC+8，带时区按自带的；不存在的日期不进位', () => {
    expect(parseOccurredAt('2026/10/01 08:00')?.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(parseOccurredAt('2026-10-01T08:00:00Z')?.toISOString()).toBe('2026-10-01T08:00:00.000Z')
    expect(parseOccurredAt('2026-10-01 08:00 -0500')?.toISOString()).toBe('2026-10-01T13:00:00.000Z')
    expect(parseOccurredAt('2026-02-31')).toBeNull()
    expect(parseOccurredAt('昨天')).toBeNull()
    expect(normalizeMilestone(' DELIVERED ')).toBe('DELIVERED')
    expect(normalizeMilestone('已签收')).toBe('DELIVERED')
  })
})

describe('实际时效统计', () => {
  it('发货日到实际交付日的自然日数；交付早于发货的脏数据不进统计', () => {
    expect(transitDaysOf({ shipDate: '2026-09-01', ataDelivery: '2026-09-29' })).toBe(28)
    expect(transitDaysOf({ shipDate: '2026-09-30', ataDelivery: '2026-09-01' })).toBeNull()
  })

  it('分位数用最近邻法，没有样本返回 null，不是 0', () => {
    expect(summarizeDays([])).toEqual({ sampleCount: 0, p50Days: null, p90Days: null, minDays: null, maxDays: null })
    expect(summarizeDays([20, 22, 25, 30, 41])).toEqual({ sampleCount: 5, p50Days: 25, p90Days: 41, minDays: 20, maxDays: 41 })
    expect(summarizeDays([30])).toMatchObject({ p50Days: 30, p90Days: 30 })
  })

  it('按实际交付所在月份分组，升序', () => {
    const points = monthlyStats([
      { shipDate: '2026-08-01', ataDelivery: '2026-09-02' },
      { shipDate: '2026-07-01', ataDelivery: '2026-07-21' },
      { shipDate: '2026-08-10', ataDelivery: '2026-09-20' },
      { shipDate: '2026-09-30', ataDelivery: '2026-09-01' },
    ])
    expect(points).toEqual([
      { month: '2026-07-01', sampleCount: 1, p50Days: 20, p90Days: 20 },
      { month: '2026-09-01', sampleCount: 2, p50Days: 32, p90Days: 41 },
    ])
  })
})

describe('延误天数', () => {
  it('已交付按实际减预计（负数是提前）；未交付只在已过预计交付日时算逾期；没有预计日为 null', () => {
    expect(delayDaysOf('2026-10-10', '2026-10-13', '2026-10-20')).toBe(3)
    expect(delayDaysOf('2026-10-10', '2026-10-08', '2026-10-20')).toBe(-2)
    expect(delayDaysOf('2026-10-10', null, '2026-10-20')).toBe(10)
    expect(delayDaysOf('2026-10-25', null, '2026-10-20')).toBeNull()
    expect(delayDaysOf(null, null, '2026-10-20')).toBeNull()
  })
})
