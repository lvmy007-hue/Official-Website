import { describe, expect, it } from 'vitest'
import {
  DESTINATION_ENV_KEY,
  FILTER_AGGREGATION_OPTIONS,
  SUBSCRIPTION_STATES,
  SUBSCRIPTION_STATE_LABEL,
  SUBSCRIPTION_STATE_NOTE,
  SUBSCRIPTION_STATE_TONE,
  affectedPagesOf,
  aggregationLabel,
  subscriptionActionsOf,
  subscriptionStateOf,
  summarizeSubscriptions,
} from './subscription-center.js'
import { AGGREGATION_PERIODS, NOTIFICATION_TYPES } from './subscriptions.js'

const base = { destinationConfigured: true, storeAuthorized: true, grantless: false }

describe('订阅状态', () => {
  it('已有记录按记录：有效、已失效；其余为处理中', () => {
    expect(subscriptionStateOf({ ...base, rowStatus: 'ACTIVE' })).toBe('ACTIVE')
    expect(subscriptionStateOf({ ...base, rowStatus: 'INVALID' })).toBe('INVALID')
    expect(subscriptionStateOf({ ...base, rowStatus: 'NOT_CREATED' })).toBe('PENDING')
  })

  it('没有记录：接收端未配置优先，其次店铺没授权，否则未订阅', () => {
    expect(subscriptionStateOf({ ...base, rowStatus: null, destinationConfigured: false, storeAuthorized: false })).toBe('DESTINATION_MISSING')
    expect(subscriptionStateOf({ ...base, rowStatus: null, storeAuthorized: false })).toBe('STORE_NOT_AUTHORIZED')
    expect(subscriptionStateOf({ ...base, rowStatus: null })).toBe('NOT_SUBSCRIBED')
  })

  it('免授权的类型（货件追踪节点）不要求店铺授权', () => {
    expect(subscriptionStateOf({ ...base, rowStatus: null, storeAuthorized: false, grantless: true })).toBe('NOT_SUBSCRIBED')
  })

  it('接收端后来被拿掉：已有的待创建记录显示接收端未接入，已创建的仍按记录显示', () => {
    expect(subscriptionStateOf({ ...base, rowStatus: 'NOT_CREATED', destinationConfigured: false })).toBe('DESTINATION_MISSING')
    expect(subscriptionStateOf({ ...base, rowStatus: 'ACTIVE', destinationConfigured: false })).toBe('ACTIVE')
  })

  it('每个状态都有名称、色调与说明', () => {
    for (const state of SUBSCRIPTION_STATES) {
      expect(SUBSCRIPTION_STATE_LABEL[state]).toBeTruthy()
      expect(SUBSCRIPTION_STATE_TONE[state]).toBeTruthy()
      expect(SUBSCRIPTION_STATE_NOTE[state].length).toBeGreaterThan(8)
    }
  })
})

describe('动作可用性', () => {
  const input = { hasRow: true, state: 'ACTIVE' as const, canManage: true, destinationConfigured: true, filterable: true, failures24h: 3 }

  it('有权限且有记录：改过滤条件、取消、重放都可用；订阅不可重复', () => {
    const actions = subscriptionActionsOf(input)
    expect(actions.editFilter.allowed).toBe(true)
    expect(actions.unsubscribe.allowed).toBe(true)
    expect(actions.replay.allowed).toBe(true)
    expect(actions.subscribe).toEqual({ allowed: false, reason: '已经订阅，不能重复订阅' })
  })

  it('没有权限：四个动作全部不可用并写明权限', () => {
    const actions = subscriptionActionsOf({ ...input, canManage: false })
    for (const state of Object.values(actions)) expect(state).toEqual({ allowed: false, reason: '需要“消息推送订阅管理”权限' })
  })

  it('还没订阅：只能订阅；接收端未接入或店铺未授权时订阅不可用并说明原因', () => {
    const empty = { ...input, hasRow: false, state: 'NOT_SUBSCRIBED' as const, failures24h: 0 }
    const open = subscriptionActionsOf(empty)
    expect(open.subscribe.allowed).toBe(true)
    expect(open.editFilter.reason).toBe('还没有订阅')
    expect(open.unsubscribe.reason).toBe('还没有订阅')
    expect(open.replay.reason).toBe('还没有订阅')
    expect(subscriptionActionsOf({ ...empty, destinationConfigured: false, state: 'DESTINATION_MISSING' }).subscribe.reason).toContain('部署专项')
    expect(subscriptionActionsOf({ ...empty, state: 'STORE_NOT_AUTHORIZED' }).subscribe.reason).toContain('连接中心')
  })

  it('不支持过滤的类型不能改过滤条件；没有失败事件不能重放；接收端未接入不能改过滤条件', () => {
    expect(subscriptionActionsOf({ ...input, filterable: false }).editFilter.reason).toBe('这类推送不支持过滤条件')
    expect(subscriptionActionsOf({ ...input, failures24h: 0 }).replay.reason).toBe('近 24 小时没有失败事件')
    expect(subscriptionActionsOf({ ...input, destinationConfigured: false }).editFilter.reason).toContain('部署专项')
    expect(subscriptionActionsOf({ ...input, destinationConfigured: false }).replay.allowed).toBe(true) // 重放不需要接收端
  })
})

describe('汇总与受影响页面', () => {
  it('汇总只数有记录的行；事件数与失败数含没有记录的行', () => {
    const summary = summarizeSubscriptions([
      { id: 'a', state: 'ACTIVE', events24h: 10, failures24h: 1 },
      { id: 'b', state: 'PENDING', events24h: 0, failures24h: 0 },
      { id: 'c', state: 'INVALID', events24h: 0, failures24h: 0 },
      { id: null, state: 'NOT_SUBSCRIBED', events24h: 2, failures24h: 2 },
    ])
    expect(summary).toEqual({ rows: 3, active: 1, pending: 1, invalid: 1, events24h: 12, failures24h: 3 })
  })

  it('受影响的页面按页面归并推送类型，且包含今日实时', () => {
    const pages = affectedPagesOf(NOTIFICATION_TYPES)
    const today = pages.find(item => item.page === '今日实时')
    expect(today?.types).toEqual(expect.arrayContaining(['商品销售事件', '详情页流量事件', '商品库存事件', '订单变化']))
    expect(new Set(pages.map(item => item.page)).size).toBe(pages.length)
  })
})

describe('与订阅请求体契约一致', () => {
  it('聚合周期选项与 AGGREGATION_PERIODS 一致', () => {
    expect(FILTER_AGGREGATION_OPTIONS.map(item => item.value)).toEqual([...AGGREGATION_PERIODS])
    expect(aggregationLabel('FiveMinutes')).toBe('5 分钟')
    expect(aggregationLabel(undefined)).toBe('')
  })

  it('环境变量名固定', () => {
    expect(DESTINATION_ENV_KEY).toBe('AMAZON_NOTIFICATION_DESTINATION_ID')
  })
})
