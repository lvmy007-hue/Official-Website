import { describe, expect, it } from 'vitest'
import { EVENT_TYPES, EVENT_TYPE_LABEL, EVENT_TYPE_PERMISSION, EventsQuerySchema, eventGroupLabel, eventKindsOf, eventTypeOfKind, groupEventsByDay, type EventItem } from './index.js'

const item = (over: Partial<EventItem> & Pick<EventItem, 'id' | 'type' | 'day'>): EventItem => ({
  occurredAt: `${over.day}T10:00:00.000Z`,
  title: `事件 ${over.id}`,
  summary: null,
  link: null,
  actor: '系统',
  ...over,
})

describe('统一事件契约：类型与归类', () => {
  it('七种类型都有中文名；读权限只有价格、广告、预警、Listing、系统操作五类要额外权限', () => {
    expect(EVENT_TYPES).toHaveLength(7)
    for (const type of EVENT_TYPES) expect(EVENT_TYPE_LABEL[type]).toBeTruthy()
    expect(EVENT_TYPES.filter(type => EVENT_TYPE_PERMISSION[type] !== null)).toEqual(['PRICE', 'ADS', 'ALERT', 'LISTING', 'AUDIT'])
    expect(EVENT_TYPE_PERMISSION.ADS).toBe('ads.read')
    expect(EVENT_TYPE_PERMISSION.ALERT).toBe('alerts.read')
  })

  it('对象事件表的种类按登记归类，没登记的归“其他”', () => {
    expect(eventTypeOfKind('price.change')).toBe('PRICE')
    expect(eventTypeOfKind('budget.change')).toBe('ADS')
    expect(eventTypeOfKind('content.change')).toBe('LISTING')
    expect(eventTypeOfKind('alert')).toBe('ALERT')
    expect(eventTypeOfKind('manual')).toBe('OTHER')
    expect(eventTypeOfKind('something.new')).toBe('OTHER')
    expect(eventKindsOf('LISTING').sort()).toEqual(['content.change', 'listing.change', 'variation.attribute_change'])
    expect(eventKindsOf('OTHER')).toEqual([])
  })
})

describe('统一事件契约：同一天合并', () => {
  it('同一天同一类合并成一组，不同类型各自一组；按日期再按类型顺序排列', () => {
    const groups = groupEventsByDay([
      item({ id: 'a', type: 'ALERT', day: '2026-10-02' }),
      item({ id: 'b', type: 'PRICE', day: '2026-10-02' }),
      item({ id: 'c', type: 'PRICE', day: '2026-10-02' }),
      item({ id: 'd', type: 'OPERATION', day: '2026-10-01' }),
    ])
    expect(groups.map(group => `${group.day}:${group.type}:${group.items.length}`)).toEqual(['2026-10-01:OPERATION:1', '2026-10-02:PRICE:2', '2026-10-02:ALERT:1'])
  })

  it('一个事件显示标题，多个事件显示“N 个事件”，没有事件是空串', () => {
    const [one, many] = groupEventsByDay([
      item({ id: 'a', type: 'PRICE', day: '2026-10-01', title: '改价' }),
      item({ id: 'b', type: 'ADS', day: '2026-10-01' }),
      item({ id: 'c', type: 'ADS', day: '2026-10-01' }),
    ])
    expect(eventGroupLabel(one!)).toBe('改价')
    expect(eventGroupLabel(many!)).toBe('2 个事件')
    expect(eventGroupLabel({ items: [] })).toBe('')
    expect(groupEventsByDay([])).toEqual([])
  })
})

describe('统一事件契约：查询参数', () => {
  const base = { objectType: 'ASIN', objectId: 'p1' }

  it('只有对象是必填的；日期与时间两种写法都接受', () => {
    expect(EventsQuerySchema.parse(base)).toEqual(base)
    expect(EventsQuerySchema.parse({ ...base, from: '2026-10-01', to: '2026-10-31T23:59:59.000Z' })).toMatchObject({ from: '2026-10-01' })
  })

  it('types 按固定顺序去重，写错的类型 422（校验失败）', () => {
    expect(EventsQuerySchema.parse({ ...base, types: 'ALERT, PRICE,ALERT' }).types).toEqual(['PRICE', 'ALERT'])
    expect(EventsQuerySchema.safeParse({ ...base, types: 'PRICE,NOPE' }).success).toBe(false)
  })

  it('不认识的对象类型、空编号、坏日期都不通过', () => {
    expect(EventsQuerySchema.safeParse({ ...base, objectType: 'NOPE' }).success).toBe(false)
    expect(EventsQuerySchema.safeParse({ ...base, objectId: '' }).success).toBe(false)
    expect(EventsQuerySchema.safeParse({ ...base, from: '10/01/2026' }).success).toBe(false)
  })
})
