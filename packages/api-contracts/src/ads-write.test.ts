import { describe, expect, it } from 'vitest'
import { SWITCH_CATALOG } from './switches'
import {
  ADS_SOURCE_SWITCH,
  ADS_WRITE_KIND_INFO,
  ADS_WRITE_KINDS,
  ADS_WRITE_LIMITS,
  adsChangePercent,
  adsMoneyText,
  adsWriteAfterText,
  adsWriteChangeField,
  adsWriteEventOf,
  adsWriteFailureText,
  adsWriteOpIssue,
  adsWriteSwitches,
  adsWriteWarnings,
} from './ads-write'
import { ADS_CHANGE_FIELDS } from './ads-changes'
import { AdsWriteBatchBodySchema } from './ads-write-query'

// 广告写入契约（P3-17）：十种写入与八个开关的对应、内容合法性、前后值文字、变更记录与操作事件的字段、预览提醒、失败说明、请求校验。

describe('写入类型与开关', () => {
  it('每种写入都有已登记的开关；广告 8 个开关全部有出处（6 个动作开关 + 2 个来源开关）', () => {
    const catalog = new Set(SWITCH_CATALOG.map(item => item.key))
    for (const kind of ADS_WRITE_KINDS) expect(catalog.has(ADS_WRITE_KIND_INFO[kind].switchKey), kind).toBe(true)
    const adsSwitches = SWITCH_CATALOG.filter(item => item.provider === 'AMAZON_ADS_API').map(item => item.key)
    expect(adsSwitches).toHaveLength(8)
    const covered = new Set<string>([...ADS_WRITE_KINDS.map(kind => ADS_WRITE_KIND_INFO[kind].switchKey), ...Object.values(ADS_SOURCE_SWITCH).filter((key): key is string => key !== null)])
    expect([...covered].sort()).toEqual([...adsSwitches].sort())
  })

  it('手动写入只要动作自己的开关；规则与分时策略发起的写入还要来源开关', () => {
    expect(adsWriteSwitches('CAMPAIGN_BUDGET', 'MANUAL')).toEqual(['sw.ads.budget'])
    expect(adsWriteSwitches('CAMPAIGN_BUDGET', 'AUTO_RULE')).toEqual(['sw.ads.budget', 'sw.ads.rule.run'])
    expect(adsWriteSwitches('TARGET_BID', 'DAYPARTING')).toEqual(['sw.ads.bid', 'sw.ads.dayparting.run'])
  })

  it('每种写入的权限点都是已知的广告写权限', () => {
    const known = new Set(['ads.campaign.write', 'ads.budget.write', 'ads.bid.write', 'ads.placement.write', 'ads.negative.write', 'ads.keyword.write'])
    for (const kind of ADS_WRITE_KINDS) expect(known.has(ADS_WRITE_KIND_INFO[kind].permission), kind).toBe(true)
  })

  it('变更记录的字段都在变更追踪的字段表里（新增类与广告位没有本地字段，除外）；操作事件的种类互不重复', () => {
    for (const kind of ADS_WRITE_KINDS) {
      const { entityType, field } = adsWriteChangeField(kind)
      if (kind === 'NEGATIVE_ADD' || kind === 'KEYWORD_ADD' || kind === 'CAMPAIGN_PLACEMENT') continue
      expect(
        ADS_CHANGE_FIELDS[entityType].map(item => item.key),
        kind,
      ).toContain(field)
    }
    const kinds = ADS_WRITE_KINDS.map(kind => adsWriteEventOf(kind).kind)
    expect(new Set(kinds).size).toBe(kinds.length)
    expect(adsWriteEventOf('TARGET_BID')).toEqual({ entityType: 'ADS_TARGET', kind: 'ads.target.bid', key: 'bid' })
    expect(adsWriteEventOf('AD_GROUP_STATE')).toMatchObject({ entityType: 'ADS_AD_GROUP', kind: 'ads.ad-group.state' })
  })
})

describe('内容合法性', () => {
  const issue = (op: Parameters<typeof adsWriteOpIssue>[0]) => adsWriteOpIssue(op)

  it('状态类必须给状态；预算要大于 0 且不超上限；竞价在最小与最大之间；广告位百分比在范围内', () => {
    expect(issue({ kind: 'CAMPAIGN_STATE' })).toContain('状态')
    expect(issue({ kind: 'TARGET_STATE', state: 'PAUSED' })).toBeNull()
    expect(issue({ kind: 'CAMPAIGN_BUDGET', amount: 0 })).toContain('日预算')
    expect(issue({ kind: 'CAMPAIGN_BUDGET', amount: ADS_WRITE_LIMITS.budgetMax + 1 })).toContain('日预算')
    expect(issue({ kind: 'CAMPAIGN_BUDGET', amount: 25.5 })).toBeNull()
    expect(issue({ kind: 'AD_GROUP_BID', amount: ADS_WRITE_LIMITS.bidMin - 0.01 })).toContain('默认竞价')
    expect(issue({ kind: 'TARGET_BID', amount: ADS_WRITE_LIMITS.bidMax })).toBeNull()
    expect(issue({ kind: 'TARGET_BID', amount: Number.NaN })).toContain('竞价')
    expect(issue({ kind: 'CAMPAIGN_PLACEMENT', amount: 10 })).toContain('广告位')
    expect(issue({ kind: 'CAMPAIGN_PLACEMENT', placement: 'TOP_OF_SEARCH', amount: ADS_WRITE_LIMITS.placementPercentMax + 1 })).toContain('百分比')
    expect(issue({ kind: 'CAMPAIGN_BID_STRATEGY' })).toContain('策略')
  })

  it('否定投放必须有词、层级与否定匹配方式；关键词必须有词与匹配方式，竞价可选但给了就要合法；否定匹配方式不能用于关键词', () => {
    expect(issue({ kind: 'NEGATIVE_ADD', text: ' ', level: 'AD_GROUP', matchType: 'NEGATIVE_EXACT' })).toContain('词')
    expect(issue({ kind: 'NEGATIVE_ADD', text: 'x', matchType: 'NEGATIVE_EXACT' })).toContain('活动还是广告组')
    expect(issue({ kind: 'NEGATIVE_ADD', text: 'x', level: 'CAMPAIGN', matchType: 'EXACT' })).toContain('否定')
    expect(issue({ kind: 'NEGATIVE_ADD', text: 'x', level: 'CAMPAIGN', matchType: 'NEGATIVE_PHRASE' })).toBeNull()
    expect(issue({ kind: 'KEYWORD_ADD', text: 'x', matchType: 'NEGATIVE_EXACT' })).toContain('匹配方式')
    expect(issue({ kind: 'KEYWORD_ADD', text: 'x', matchType: 'BROAD' })).toBeNull()
    expect(issue({ kind: 'KEYWORD_ADD', text: 'x', matchType: 'BROAD', amount: 0 })).toContain('竞价')
  })
})

describe('前后值文字、百分比与提醒', () => {
  it('修改后的值：状态、金额、策略、广告位、词都有稳定的文字', () => {
    expect(adsWriteAfterText({ kind: 'CAMPAIGN_STATE', state: 'PAUSED' })).toBe('PAUSED')
    expect(adsWriteAfterText({ kind: 'CAMPAIGN_BUDGET', amount: 30 })).toBe('30')
    expect(adsWriteAfterText({ kind: 'CAMPAIGN_BID_STRATEGY', strategy: 'MANUAL' })).toBe('MANUAL')
    expect(adsWriteAfterText({ kind: 'CAMPAIGN_PLACEMENT', placement: 'TOP_OF_SEARCH', amount: 50 })).toBe('TOP_OF_SEARCH 50%')
    expect(adsWriteAfterText({ kind: 'KEYWORD_ADD', text: ' yoga ', matchType: 'EXACT' })).toBe('yoga（EXACT）')
  })

  it('金额文字去掉末尾 0；变化百分比保留一位小数，前值为空或 0 不给百分比', () => {
    expect(adsMoneyText('20.000000')).toBe('20')
    expect(adsMoneyText(0.85)).toBe('0.85')
    expect(adsMoneyText(null)).toBeNull()
    expect(adsMoneyText('abc')).toBeNull()
    expect(adsChangePercent('20', '30')).toBe(50)
    expect(adsChangePercent('3', '4')).toBe(33.3)
    expect(adsChangePercent('0', '4')).toBeNull()
    expect(adsChangePercent(null, '4')).toBeNull()
  })

  it('提醒：幅度达到阈值提醒（提高与降低都要）；没有当前值说明无法算幅度；暂停提醒；广告位说明没有修改前的值', () => {
    const big = ADS_WRITE_LIMITS.bigChangePercent
    expect(adsWriteWarnings({ kind: 'CAMPAIGN_BUDGET', amount: 10 * (1 + big / 100) }, '10').join('')).toContain('提高')
    expect(adsWriteWarnings({ kind: 'CAMPAIGN_BUDGET', amount: 4 }, '10').join('')).toContain('降低')
    expect(adsWriteWarnings({ kind: 'CAMPAIGN_BUDGET', amount: 10.5 }, '10')).toEqual([])
    expect(adsWriteWarnings({ kind: 'TARGET_BID', amount: 1 }, null).join('')).toContain('尚未同步')
    expect(adsWriteWarnings({ kind: 'AD_GROUP_STATE', state: 'PAUSED' }, 'ENABLED').join('')).toContain('暂停')
    expect(adsWriteWarnings({ kind: 'AD_GROUP_STATE', state: 'ENABLED' }, 'PAUSED')).toEqual([])
    expect(adsWriteWarnings({ kind: 'CAMPAIGN_PLACEMENT', placement: 'PRODUCT_PAGE', amount: 10 }, null).join('')).toContain('修改前')
  })
})

describe('失败说明', () => {
  it('常见失败码都有中文说明，且不透出亚马逊返回的原文', () => {
    expect(adsWriteFailureText(null)).toContain('未记录')
    expect(adsWriteFailureText('SWITCH_DISABLED')).toContain('开关')
    expect(adsWriteFailureText('ADS_ACCOUNT_MISSING')).toContain('账户编号')
    expect(adsWriteFailureText('ADS_WRITE_REJECTED')).toContain('拒绝')
    expect(adsWriteFailureText('ADS_API_403')).toContain('拒绝')
    expect(adsWriteFailureText('ADS_API_500')).toContain('暂时不可用')
    expect(adsWriteFailureText('QUEUE_UNAVAILABLE')).toContain('失败')
  })
})

describe('请求校验', () => {
  const parse = (ops: unknown[]) => AdsWriteBatchBodySchema.safeParse({ ops })

  it('合法的批次通过；对象编号格式、未声明字段、空批次、超过上限、内容不合法都被拒绝', () => {
    expect(parse([{ kind: 'CAMPAIGN_BUDGET', entityId: 'c1', amount: 30 }]).success).toBe(true)
    expect(parse([{ kind: 'KEYWORD_ADD', entityId: 'g1', text: 'yoga', matchType: 'PHRASE' }]).success).toBe(true)
    expect(parse([]).success).toBe(false)
    expect(parse([{ kind: 'CAMPAIGN_BUDGET', entityId: 'a b', amount: 30 }]).success).toBe(false)
    expect(parse([{ kind: 'CAMPAIGN_BUDGET', entityId: 'c1', amount: 30, extra: 1 }]).success).toBe(false)
    expect(parse([{ kind: 'CAMPAIGN_BUDGET', entityId: 'c1', amount: -1 }]).success).toBe(false)
    expect(parse([{ kind: 'NOPE', entityId: 'c1' }]).success).toBe(false)
    expect(parse(Array.from({ length: ADS_WRITE_LIMITS.batchMax + 1 }, () => ({ kind: 'CAMPAIGN_STATE', entityId: 'c1', state: 'PAUSED' }))).success).toBe(false)
  })

  it('词会去掉首尾空格，超长被拒绝', () => {
    const ok = parse([{ kind: 'NEGATIVE_ADD', entityId: 'g1', level: 'AD_GROUP', text: '  free  ', matchType: 'NEGATIVE_EXACT' }])
    expect(ok.success && ok.data.ops[0]!.text).toBe('free')
    expect(parse([{ kind: 'NEGATIVE_ADD', entityId: 'g1', level: 'AD_GROUP', text: 'x'.repeat(ADS_WRITE_LIMITS.textMax + 1), matchType: 'NEGATIVE_EXACT' }]).success).toBe(false)
  })
})
