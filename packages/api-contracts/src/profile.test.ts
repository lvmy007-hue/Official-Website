import { describe, expect, it } from 'vitest'
import { DND_SUMMARY_KIND, ESCALATION_KINDS, NOTIFY_DOMAINS, decideDelivery, defaultNotifyPrefs, dndSummaryBody, dndSummaryLink, inDndWindow, notificationDomainOf, notifyPrefsOf } from './profile.js'
import { NotifyPrefsSchema, PreferencesUpdateBodySchema, ProfileUpdateBodySchema } from './profile-query.js'

const at = (hhmm: string) => new Date(`2026-10-25T${hhmm}:00.000Z`)

describe('通知的业务域', () => {
  it('预警规则自带业务域时优先使用；其余按通知类型推断，认不出的归系统', () => {
    expect(notificationDomainOf('ALERT_RULE', 'INVENTORY')).toBe('INVENTORY')
    expect(notificationDomainOf('ALERT_RULE', 'NOPE')).toBe('SYSTEM')
    expect(notificationDomainOf('ALERT_RULE')).toBe('SYSTEM')
    expect(notificationDomainOf('WORK_ASSIGNED')).toBe('WORK')
    expect(notificationDomainOf('MENTION')).toBe('WORK')
    expect(notificationDomainOf('WORK_OVERDUE')).toBe('WORK')
    expect(notificationDomainOf('EXPORT_DONE')).toBe('WORK')
    expect(notificationDomainOf('PRICING')).toBe('PRODUCT')
    expect(notificationDomainOf('ADS_RULE')).toBe('ADS')
    expect(notificationDomainOf('ADVERTISING')).toBe('ADS')
    expect(notificationDomainOf('ALERT_FX_FETCH_FAILED')).toBe('SYSTEM')
    expect(notificationDomainOf('WRITE_SWITCH_CHANGED')).toBe('SYSTEM')
  })
})

describe('通知偏好的还原', () => {
  it('没有保存过：全部接收，免打扰关闭', () => {
    const prefs = notifyPrefsOf(null)
    expect(prefs.dnd).toEqual({ enabled: false, start: '22:00', end: '08:00' })
    for (const domain of NOTIFY_DOMAINS) expect(prefs.domains[domain]).toEqual({ INFO: true, WARNING: true, CRITICAL: true })
  })

  it('库里的坏值按默认处理，好的部分保留', () => {
    const prefs = notifyPrefsOf({ domains: { ADS: { INFO: false, WARNING: 'x' }, NOPE: { INFO: false } }, dnd: { enabled: true, start: '25:00', end: '07:30' } })
    expect(prefs.domains.ADS).toEqual({ INFO: false, WARNING: true, CRITICAL: true })
    expect(prefs.dnd).toEqual({ enabled: true, start: '22:00', end: '07:30' })
    expect(notifyPrefsOf({ dnd: { enabled: true, start: '09:00', end: '09:00' } }).dnd).toEqual({ enabled: true, start: '22:00', end: '08:00' })
  })
})

describe('免打扰时段', () => {
  const dnd = { enabled: true, start: '22:00', end: '08:00' }

  it('跨午夜：按企业本地时区判断，结束时刻不含', () => {
    // 北京时间 = UTC + 8：UTC 14:30 是北京 22:30，UTC 00:00 是北京 08:00
    expect(inDndWindow(at('14:30'), 'Asia/Shanghai', dnd)).toBe(true)
    expect(inDndWindow(at('23:59'), 'Asia/Shanghai', dnd)).toBe(true)
    expect(inDndWindow(at('00:00'), 'Asia/Shanghai', dnd)).toBe(false)
    expect(inDndWindow(at('13:59'), 'Asia/Shanghai', dnd)).toBe(false)
    // 同一时刻在美国太平洋时区（夏令时 UTC-7）是 10:00，不在时段内
    expect(inDndWindow(at('17:00'), 'America/Los_Angeles', dnd)).toBe(false)
    expect(inDndWindow(at('17:00'), 'Asia/Shanghai', dnd)).toBe(true)
  })

  it('不跨午夜、关闭、时区无效', () => {
    expect(inDndWindow(at('12:00'), 'UTC', { enabled: true, start: '12:00', end: '14:00' })).toBe(true)
    expect(inDndWindow(at('14:00'), 'UTC', { enabled: true, start: '12:00', end: '14:00' })).toBe(false)
    expect(inDndWindow(at('23:00'), 'UTC', { ...dnd, enabled: false })).toBe(false)
    expect(inDndWindow(at('14:30'), 'Not/AZone', dnd)).toBe(true)
    expect(inDndWindow(at('14:30'), null, dnd)).toBe(true)
  })
})

describe('送达判断', () => {
  const night = at('15:00') // 北京 23:00
  const day = at('04:00') // 北京 12:00
  const prefs = () => {
    const value = defaultNotifyPrefs()
    value.dnd.enabled = true
    return value
  }

  it('默认：白天送达，夜里普通通知被压下', () => {
    expect(decideDelivery(prefs(), { kind: 'ALERT_RULE', domain: 'ADS', severity: 'WARNING' }, day, 'Asia/Shanghai')).toBe('DELIVER')
    expect(decideDelivery(prefs(), { kind: 'ALERT_RULE', domain: 'ADS', severity: 'WARNING' }, night, 'Asia/Shanghai')).toBe('SILENCE')
    expect(decideDelivery(prefs(), { kind: 'WORK_ASSIGNED', severity: 'INFO' }, night, 'Asia/Shanghai')).toBe('SILENCE')
  })

  it('严重级别与超时升级穿透免打扰', () => {
    expect(decideDelivery(prefs(), { kind: 'ALERT_RULE', domain: 'INVENTORY', severity: 'CRITICAL' }, night, 'Asia/Shanghai')).toBe('DELIVER')
    for (const kind of ESCALATION_KINDS) expect(decideDelivery(prefs(), { kind, severity: 'WARNING' }, night, 'Asia/Shanghai')).toBe('DELIVER')
  })

  it('业务域与级别的开关优先：关掉的组合直接不写入，哪怕是严重级别', () => {
    const value = prefs()
    value.domains.ADS.WARNING = false
    value.domains.FINANCE.CRITICAL = false
    expect(decideDelivery(value, { kind: 'ALERT_RULE', domain: 'ADS', severity: 'WARNING' }, day, 'Asia/Shanghai')).toBe('SKIP')
    expect(decideDelivery(value, { kind: 'ALERT_RULE', domain: 'FINANCE', severity: 'CRITICAL' }, night, 'Asia/Shanghai')).toBe('SKIP')
    expect(decideDelivery(value, { kind: 'ALERT_RULE', domain: 'ADS', severity: 'INFO' }, day, 'Asia/Shanghai')).toBe('DELIVER')
  })

  it('不认识的级别按提示处理', () => {
    expect(decideDelivery(prefs(), { kind: 'X', severity: 'LOUD' }, night, 'Asia/Shanghai')).toBe('SILENCE')
  })
})

describe('免打扰汇总', () => {
  it('按业务域列出条数，顺序固定，没有的不列', () => {
    expect(dndSummaryBody({ ADS: 2, INVENTORY: 3, OTHER: 1 })).toBe('免打扰期间没有逐条提醒：库存 3 条、广告 2 条、其他 1 条。')
    expect(dndSummaryBody({})).toBe('免打扰期间没有新的通知。')
    expect(DND_SUMMARY_KIND).toBe('DND_SUMMARY')
  })

  it('只有一个业务域时链接直接带筛选，多个时看全部免打扰通知', () => {
    expect(dndSummaryLink({ ADS: 2 })).toBe('/app/my/notifications?silenced=true&domain=ADS')
    expect(dndSummaryLink({ ADS: 2, FINANCE: 1 })).toBe('/app/my/notifications?silenced=true')
    expect(dndSummaryLink({ OTHER: 2 })).toBe('/app/my/notifications?silenced=true')
  })
})

describe('请求校验', () => {
  it('偏好必须完整：七个业务域都要有三个开关，免打扰起止不能相同', () => {
    expect(NotifyPrefsSchema.safeParse(defaultNotifyPrefs()).success).toBe(true)
    const missing = defaultNotifyPrefs() as unknown as { domains: Record<string, unknown> }
    delete missing.domains.ADS
    expect(NotifyPrefsSchema.safeParse(missing).success).toBe(false)
    const same = defaultNotifyPrefs()
    same.dnd = { enabled: true, start: '08:00', end: '08:00' }
    expect(NotifyPrefsSchema.safeParse(same).success).toBe(false)
    const bad = defaultNotifyPrefs()
    bad.dnd.start = '8:00'
    expect(NotifyPrefsSchema.safeParse(bad).success).toBe(false)
    expect(PreferencesUpdateBodySchema.safeParse({ notify: defaultNotifyPrefs() }).success).toBe(false)
    expect(PreferencesUpdateBodySchema.safeParse({ notify: defaultNotifyPrefs(), version: 0 }).success).toBe(true)
  })

  it('显示名：去首尾空白，1 到 60 个字，不含控制字符', () => {
    expect(ProfileUpdateBodySchema.parse({ displayName: '  张三  ' }).displayName).toBe('张三')
    expect(ProfileUpdateBodySchema.safeParse({ displayName: '   ' }).success).toBe(false)
    expect(ProfileUpdateBodySchema.safeParse({ displayName: 'a'.repeat(61) }).success).toBe(false)
    expect(ProfileUpdateBodySchema.safeParse({ displayName: `张${String.fromCharCode(7)}三` }).success).toBe(false)
    expect(ProfileUpdateBodySchema.safeParse({}).success).toBe(false)
  })
})
