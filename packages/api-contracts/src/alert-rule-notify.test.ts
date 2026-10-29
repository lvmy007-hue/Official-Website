import { describe, expect, it } from 'vitest'
import { checkEscalation, describeEscalation, digestBody, digestLink, digestTitle, escalationMinutesText, isNotifyFrequency, readEscalation } from './index.js'

describe('预警规则通知设置（P6-16）', () => {
  it('通知频率只认三种', () => {
    expect(['IMMEDIATE', 'HOURLY', 'DAILY'].every(isNotifyFrequency)).toBe(true)
    expect(isNotifyFrequency('WEEKLY')).toBe(false)
    expect(isNotifyFrequency(undefined)).toBe(false)
  })

  it('升级设置：空、最多 3 级、整数分钟、范围、严格递增', () => {
    expect(checkEscalation(null)).toEqual({ ok: true, levels: [] })
    expect(checkEscalation([])).toEqual({ ok: true, levels: [] })
    expect(checkEscalation([{ afterMinutes: 60 }, { afterMinutes: 240 }, { afterMinutes: 1440 }])).toMatchObject({ ok: true })
    expect(checkEscalation([{ afterMinutes: 5 }, { afterMinutes: 6 }, { afterMinutes: 7 }, { afterMinutes: 8 }])).toMatchObject({ ok: false })
    expect(checkEscalation([{ afterMinutes: 4 }])).toMatchObject({ ok: false })
    expect(checkEscalation([{ afterMinutes: 43_201 }])).toMatchObject({ ok: false })
    expect(checkEscalation([{ afterMinutes: 10.5 }])).toMatchObject({ ok: false })
    expect(checkEscalation([{ afterMinutes: '60' }])).toMatchObject({ ok: false })
    expect(checkEscalation([{ afterMinutes: 60 }, { afterMinutes: 60 }])).toMatchObject({ ok: false, message: expect.stringContaining('第 2 级') })
    expect(checkEscalation({ afterMinutes: 60 })).toMatchObject({ ok: false })
  })

  it('读取库里的升级设置：格式不对按不升级', () => {
    expect(readEscalation([{ afterMinutes: 30 }])).toEqual([{ afterMinutes: 30 }])
    expect(readEscalation([{ afterMinutes: 30 }, { afterMinutes: 10 }])).toEqual([])
    expect(readEscalation('x')).toEqual([])
    expect(readEscalation(null)).toEqual([])
  })

  it('文字：时限换算与升级描述', () => {
    expect(escalationMinutesText(30)).toBe('30 分钟')
    expect(escalationMinutesText(120)).toBe('2 小时')
    expect(escalationMinutesText(2880)).toBe('2 天')
    expect(describeEscalation([])).toBe('不升级')
    expect(describeEscalation([{ afterMinutes: 60 }, { afterMinutes: 240 }])).toBe('超过 1 小时未确认通知待办负责人；再超过 4 小时未确认通知规则的通知对象')
  })

  it('汇总通知文案：标题区分静默补发；正文最多列 5 个对象；链接带规则', () => {
    expect(digestTitle('库存偏低', 3, 'FREQUENCY')).toBe('预警汇总：库存偏低（3 个对象）')
    expect(digestTitle('库存偏低', 3, 'QUIET')).toContain('静默期间')
    expect(digestBody(['a', 'b'], 2)).toBe('a、b，点击查看预警中心里这条规则的预警')
    expect(digestBody(['a', 'b', 'c', 'd', 'e', 'f'], 12)).toContain('a、b、c、d、e 等 12 个对象')
    expect(digestLink('rule 1')).toContain('rule')
  })
})
