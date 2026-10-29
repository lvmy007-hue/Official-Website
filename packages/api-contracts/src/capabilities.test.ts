import { describe, expect, it } from 'vitest'
import {
  EXPORT_KINDS,
  ExportCreateBodySchema,
  FxWriteBodySchema,
  NOTIFICATION_TYPES,
  NotificationReadBodySchema,
  SWITCH_CATALOG,
  SwitchBatchBodySchema,
  SwitchEnableBodySchema,
  SubscriptionCreateBodySchema,
  SubscriptionFilterSchema,
  WorkItemBatchBodySchema,
  fxTemplateProblem,
  FX_PROVIDERS,
  writeModeOf,
} from './index.js'

describe('写入开关目录', () => {
  it('共 20 项，键唯一且以 sw. 开头，分组数量为 11、8、1', () => {
    expect(SWITCH_CATALOG).toHaveLength(20)
    expect(new Set(SWITCH_CATALOG.map(item => item.key)).size).toBe(20)
    expect(SWITCH_CATALOG.every(item => item.key.startsWith('sw.'))).toBe(true)
    const count = (group: string) => SWITCH_CATALOG.filter(item => item.group === group).length
    expect([count('SELLER'), count('ADS'), count('AUTOMATION')]).toEqual([11, 8, 1])
  })
  it('总览模式：全关为只读，全开为全部写入，其余为部分写入', () => {
    expect(writeModeOf(0)).toBe('READ_ONLY')
    expect(writeModeOf(3)).toBe('PARTIAL')
    expect(writeModeOf(20)).toBe('ALL')
  })
  it('开启必须填原因并二次确认；批量操作只能关闭', () => {
    expect(SwitchEnableBodySchema.safeParse({ reason: '需要创建入仓计划', confirm: true }).success).toBe(true)
    expect(SwitchEnableBodySchema.safeParse({ reason: '需要创建入仓计划', confirm: false }).success).toBe(false)
    expect(SwitchEnableBodySchema.safeParse({ reason: ' ', confirm: true }).success).toBe(false)
    expect(SwitchBatchBodySchema.safeParse({ keys: ['sw.ads.bid'], enabled: false, reason: '暂停调价' }).success).toBe(true)
    expect(SwitchBatchBodySchema.safeParse({ keys: ['sw.ads.bid'], enabled: true, reason: '暂停调价' }).success).toBe(false)
    expect(SwitchBatchBodySchema.safeParse({ keys: ['sw.none'], enabled: false, reason: '暂停调价' }).success).toBe(false)
  })
})

describe('汇率契约', () => {
  it('手工覆盖：币种、日期、汇率与原因都要合法；美元不能作为外币', () => {
    const ok = { kind: 'override', quoteCurrency: 'cny', rateDate: '2026-10-21', rate: 7.1234, reason: '财务口径调整' }
    expect(FxWriteBodySchema.safeParse(ok).success).toBe(true)
    expect(FxWriteBodySchema.safeParse({ ...ok, quoteCurrency: 'USD' }).success).toBe(false)
    expect(FxWriteBodySchema.safeParse({ ...ok, rate: 0 }).success).toBe(false)
    expect(FxWriteBodySchema.safeParse({ ...ok, rate: 7.123456789 }).success).toBe(false)
    expect(FxWriteBodySchema.safeParse({ ...ok, rateDate: '2026-02-30' }).success).toBe(false)
    expect(FxWriteBodySchema.safeParse({ ...ok, reason: '' }).success).toBe(false)
  })
  it('来源选择：主源与备源不能相同', () => {
    const body = { kind: 'source', primary: { provider: 'FRANKFURTER_BLENDED' }, backup: { provider: 'FRANKFURTER_ECB' }, reason: '改用备用通道' }
    expect(FxWriteBodySchema.safeParse(body).success).toBe(true)
    expect(FxWriteBodySchema.safeParse({ ...body, backup: { provider: 'FRANKFURTER_BLENDED' } }).success).toBe(false)
  })
  it('来源地址白名单：只允许 https 与固定主机；默认模板本身合法', () => {
    for (const provider of Object.values(FX_PROVIDERS)) expect(fxTemplateProblem(provider.template)).toBeNull()
    expect(fxTemplateProblem('http://api.frankfurter.dev/v2/rate/{base}/{quote}')).toContain('https')
    expect(fxTemplateProblem('https://evil.example.com/v2/rate/{base}/{quote}')).toContain('主机')
    expect(fxTemplateProblem('https://api.frankfurter.dev/v2/rate/USD/CNY')).toContain('{base}')
    expect(fxTemplateProblem('not a url')).not.toBeNull()
  })
})

describe('待办与通知契约', () => {
  it('批量忽略必须有原因，批量指派必须有对象', () => {
    const items = [{ id: 'w1', version: 1 }]
    expect(WorkItemBatchBodySchema.safeParse({ action: 'ACK', items }).success).toBe(true)
    expect(WorkItemBatchBodySchema.safeParse({ action: 'IGNORE', items }).success).toBe(false)
    expect(WorkItemBatchBodySchema.safeParse({ action: 'IGNORE', items, reason: '重复预警' }).success).toBe(true)
    expect(WorkItemBatchBodySchema.safeParse({ action: 'ASSIGN', items }).success).toBe(false)
    expect(WorkItemBatchBodySchema.safeParse({ action: 'ASSIGN', items: [], assigneeId: 'u1' }).success).toBe(false)
  })
  it('标记已读：指定通知与全部已读二选一', () => {
    expect(NotificationReadBodySchema.safeParse({ ids: ['n1'] }).success).toBe(true)
    expect(NotificationReadBodySchema.safeParse({ all: true }).success).toBe(true)
    expect(NotificationReadBodySchema.safeParse({}).success).toBe(false)
    expect(NotificationReadBodySchema.safeParse({ ids: ['n1'], all: true }).success).toBe(false)
  })
})

describe('导出目录与通知类型', () => {
  it('导出目录：权限点存在、列键唯一、敏感列标注合法', () => {
    for (const kind of EXPORT_KINDS) {
      expect(new Set(kind.columns.map(column => column.key)).size).toBe(kind.columns.length)
      for (const column of kind.columns) if (column.sensitive) expect(['cost', 'profit', 'buyer']).toContain(column.sensitive)
    }
    expect(ExportCreateBodySchema.safeParse({ kind: 'orders' }).data).toMatchObject({ format: 'CSV', filters: {} })
    expect(ExportCreateBodySchema.safeParse({ kind: 'orders', format: 'PDF' }).success).toBe(false)
  })
  it('通知类型共 18 个且不重复；只有报价变化支持过滤；过滤条件限定美国站', () => {
    expect(NOTIFICATION_TYPES).toHaveLength(18)
    expect(new Set(NOTIFICATION_TYPES.map(item => item.type)).size).toBe(18)
    expect(NOTIFICATION_TYPES.filter(item => item.filterable).map(item => item.type)).toEqual(['ANY_OFFER_CHANGED'])
    expect(SubscriptionFilterSchema.safeParse({ marketplaceIds: ['A1F83G8C2ARO7P'] }).success).toBe(false)
    expect(SubscriptionFilterSchema.safeParse({ marketplaceIds: ['ATVPDKIKX0DER'], aggregationTimePeriod: 'FiveMinutes' }).success).toBe(true)
    expect(SubscriptionCreateBodySchema.safeParse({ sellerAccountId: 's1', notificationType: 'ORDER_CHANGE' }).success).toBe(true)
    expect(SubscriptionCreateBodySchema.safeParse({ sellerAccountId: 's1', notificationType: 'NOT_A_TYPE' }).success).toBe(false)
  })
})
