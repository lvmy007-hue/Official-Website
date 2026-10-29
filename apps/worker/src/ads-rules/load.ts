import { ADS_CONSOLE_CURRENCY, ADS_RULE_LIMITS, shiftDate, termKey, termStatus, type AdsRuleDay, type AdsRuleLevel, type AdsRuleSubject } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'

// 自动规则的评估对象读取（P3-13）：一个广告账户下、给定活动范围内的活动、投放词或搜索词，各带截止日之前 30 天的日指标（美元）。
// 范围已经由“规则属于哪个广告账户、这个广告账户在不在你的数据范围内”保证，这里只带租户与广告账户条件，行级安全同时生效。
// 全部在数据库里聚合；对象与指标行超过上限时标 incomplete，不静默截断。这是接口侧 apps/api/src/modules/ads/ads-rules-load.ts 的同款读取（两个应用之间没有共享的数据库层），两处改动要一起改。

const HISTORY_DAYS = 30
const OBJECT_LIMIT = ADS_RULE_LIMITS.subjectMax
const ROW_LIMIT = ADS_RULE_LIMITS.dayRowMax

export interface RuleLoadInput {
  tenantId: string
  adsProfileId: string
  level: AdsRuleLevel
  /** 限定的活动（系统编号）；空数组 = 账户下全部活动。 */
  campaignIds: readonly string[]
  /** 评估截止日（YYYY-MM-DD）。 */
  asOf: string
  /** 读截止日之前多少天的日指标；评估默认 30 天，效果统计要更长（动作前后各 7 天）。 */
  historyDays?: number
}

export interface RuleSubjects {
  subjects: AdsRuleSubject[]
  incomplete: boolean
}

const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
const asDate = (date: string) => new Date(`${date}T00:00:00Z`)
const dateText = (value: Date) => value.toISOString().slice(0, 10)
const rowOf = (date: string, sum: { impressions: number | null; clicks: number | null; spend: unknown; sales: unknown; orders: number | null }): AdsRuleDay => ({
  date,
  impressions: sum.impressions ?? 0,
  clicks: sum.clicks ?? 0,
  spend: num(sum.spend as { toString(): string } | null),
  sales: num(sum.sales as { toString(): string } | null),
  orders: sum.orders ?? 0,
})
const pushDay = (map: Map<string, AdsRuleDay[]>, key: string, day: AdsRuleDay) => {
  const list = map.get(key)
  if (list) list.push(day)
  else map.set(key, [day])
}

/** 账户下（限定范围内）的活动，按名称排。 */
async function loadCampaigns(prisma: PrismaClient, input: RuleLoadInput) {
  const rows = await prisma.adsCampaign.findMany({
    where: { tenantId: input.tenantId, adsProfileId: input.adsProfileId, currency: ADS_CONSOLE_CURRENCY, ...(input.campaignIds.length > 0 ? { id: { in: [...input.campaignIds] } } : {}) },
    select: { id: true, externalCampaignId: true, adProduct: true, name: true, state: true, budget: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: OBJECT_LIMIT + 1,
  })
  return { rows: rows.slice(0, OBJECT_LIMIT), truncated: rows.length > OBJECT_LIMIT }
}

async function campaignSubjects(prisma: PrismaClient, input: RuleLoadInput, from: string): Promise<RuleSubjects> {
  const { rows, truncated } = await loadCampaigns(prisma, input)
  if (rows.length === 0) return { subjects: [], incomplete: false }
  const summaries = await prisma.adsDailySummary.findMany({
    where: {
      tenantId: input.tenantId,
      adsProfileId: input.adsProfileId,
      currency: ADS_CONSOLE_CURRENCY,
      summaryDate: { gte: asDate(from), lte: asDate(input.asOf) },
      campaignId: { in: [...new Set(rows.map(row => row.externalCampaignId))] },
    },
    select: { adProduct: true, campaignId: true, summaryDate: true, impressions: true, clicks: true, spend: true, sales: true, orders: true },
    orderBy: [{ summaryDate: 'asc' }, { campaignId: 'asc' }],
    take: ROW_LIMIT + 1,
  })
  const daily = new Map<string, AdsRuleDay[]>()
  for (const row of summaries.slice(0, ROW_LIMIT)) pushDay(daily, `${row.adProduct}|${row.campaignId}`, rowOf(dateText(row.summaryDate), row))
  const subjects = rows.map(row => ({
    key: row.id,
    label: row.name,
    campaignLabel: row.name,
    state: row.state,
    bid: null,
    budget: num(row.budget),
    daily: daily.get(`${row.adProduct}|${row.externalCampaignId}`) ?? [],
  }))
  return { subjects, incomplete: truncated || summaries.length > ROW_LIMIT }
}

/** 限定活动后的外部活动编号（没限定返回 null = 全部）。 */
async function externalCampaigns(prisma: PrismaClient, input: RuleLoadInput): Promise<Map<string, string> | null> {
  const rows = await prisma.adsCampaign.findMany({
    where: { tenantId: input.tenantId, adsProfileId: input.adsProfileId, ...(input.campaignIds.length > 0 ? { id: { in: [...input.campaignIds] } } : {}) },
    select: { externalCampaignId: true, name: true },
    orderBy: [{ id: 'asc' }],
    take: OBJECT_LIMIT,
  })
  return new Map(rows.map(row => [row.externalCampaignId, row.name]))
}

async function targetSubjects(prisma: PrismaClient, input: RuleLoadInput, from: string): Promise<RuleSubjects> {
  const campaigns = await externalCampaigns(prisma, input)
  const limited = input.campaignIds.length > 0
  if (limited && campaigns && campaigns.size === 0) return { subjects: [], incomplete: false }
  const campaignList = campaigns ? [...campaigns.keys()] : []
  const [groups, keywords] = await Promise.all([
    prisma.adsAdGroup.findMany({
      where: { tenantId: input.tenantId, adsProfileId: input.adsProfileId, ...(limited ? { campaignId: { in: campaignList } } : {}) },
      select: { adGroupId: true, campaignId: true },
      orderBy: [{ adGroupId: 'asc' }],
      take: OBJECT_LIMIT,
    }),
    prisma.adsKeyword.findMany({
      where: { tenantId: input.tenantId, adsProfileId: input.adsProfileId, ...(limited ? { campaignId: { in: campaignList } } : {}) },
      select: { keywordId: true, campaignId: true, text: true, bid: true, state: true },
      orderBy: [{ keywordId: 'asc' }],
      take: OBJECT_LIMIT + 1,
    }),
  ])
  const targets = await prisma.adsTarget.findMany({
    where: { tenantId: input.tenantId, adsProfileId: input.adsProfileId, adGroupId: { in: groups.map(group => group.adGroupId) } },
    select: { targetId: true, adGroupId: true, expression: true, bid: true, state: true },
    orderBy: [{ targetId: 'asc' }],
    take: OBJECT_LIMIT + 1,
  })
  const campaignOfGroup = new Map(groups.map(group => [group.adGroupId, group.campaignId]))
  const names = campaigns ?? new Map<string, string>()
  const all = [
    ...keywords.slice(0, OBJECT_LIMIT).map(row => ({ key: row.keywordId, label: row.text, campaign: row.campaignId, state: row.state, bid: num(row.bid) })),
    ...targets.slice(0, OBJECT_LIMIT).map(row => ({ key: row.targetId, label: row.expression, campaign: campaignOfGroup.get(row.adGroupId) ?? null, state: row.state, bid: num(row.bid) })),
  ].slice(0, OBJECT_LIMIT)
  if (all.length === 0) return { subjects: [], incomplete: false }
  const metrics = await prisma.adsMetric.groupBy({
    by: ['entityId', 'reportDate'],
    where: {
      tenantId: input.tenantId,
      adsProfileId: input.adsProfileId,
      currency: ADS_CONSOLE_CURRENCY,
      entityType: { in: ['TARGET', 'KEYWORD'] },
      entityId: { in: all.map(row => row.key) },
      reportDate: { gte: asDate(from), lte: asDate(input.asOf) },
    },
    _sum: { impressions: true, clicks: true, cost: true, sales: true, purchases: true },
    orderBy: [{ reportDate: 'asc' }, { entityId: 'asc' }],
    take: ROW_LIMIT + 1,
  })
  const daily = new Map<string, AdsRuleDay[]>()
  for (const group of metrics.slice(0, ROW_LIMIT)) {
    if (group.entityId) pushDay(daily, group.entityId, rowOf(dateText(group.reportDate), { ...group._sum, spend: group._sum.cost, orders: group._sum.purchases }))
  }
  const subjects = all.map(row => ({
    key: row.key,
    label: row.label,
    campaignLabel: row.campaign ? (names.get(row.campaign) ?? null) : null,
    state: row.state,
    bid: row.bid,
    budget: null,
    daily: daily.get(row.key) ?? [],
  }))
  return { subjects, incomplete: keywords.length > OBJECT_LIMIT || targets.length > OBJECT_LIMIT || metrics.length > ROW_LIMIT }
}

async function termSubjects(prisma: PrismaClient, input: RuleLoadInput, from: string): Promise<RuleSubjects> {
  const campaigns = await externalCampaigns(prisma, input)
  const limited = input.campaignIds.length > 0
  if (limited && campaigns && campaigns.size === 0) return { subjects: [], incomplete: false }
  const campaignList = campaigns ? [...campaigns.keys()] : []
  const base = {
    tenantId: input.tenantId,
    adsProfileId: input.adsProfileId,
    level: 'SEARCH_TERM',
    currency: ADS_CONSOLE_CURRENCY,
    reportDate: { gte: asDate(from), lte: asDate(input.asOf) },
    searchTerm: { not: null },
    externalCampaignId: limited ? { in: campaignList } : { not: null },
  }
  // 先按近 30 天花费取最高的对象，再取这些对象的逐日指标：搜索词很多时留下的是花费最高的那批
  const top = await prisma.adsTermMetric.groupBy({
    by: ['externalCampaignId', 'searchTerm'],
    where: base,
    _sum: { cost: true },
    orderBy: [{ _sum: { cost: 'desc' } }, { externalCampaignId: 'asc' }, { searchTerm: 'asc' }],
    take: OBJECT_LIMIT + 1,
  })
  const picked = top.slice(0, OBJECT_LIMIT).flatMap(group => (group.externalCampaignId && group.searchTerm ? [{ campaign: group.externalCampaignId, term: group.searchTerm }] : []))
  if (picked.length === 0) return { subjects: [], incomplete: false }
  const pickedCampaigns = [...new Set(picked.map(row => row.campaign))]
  const [days, keywords, negatives, groups, names] = await Promise.all([
    prisma.adsTermMetric.groupBy({
      by: ['externalCampaignId', 'searchTerm', 'reportDate'],
      where: { ...base, externalCampaignId: { in: pickedCampaigns }, searchTerm: { in: [...new Set(picked.map(row => row.term))] } },
      _sum: { impressions: true, clicks: true, cost: true, sales: true, purchases: true },
      orderBy: [{ reportDate: 'asc' }, { externalCampaignId: 'asc' }, { searchTerm: 'asc' }],
      take: ROW_LIMIT + 1,
    }),
    prisma.adsKeyword.findMany({
      where: { tenantId: input.tenantId, adsProfileId: input.adsProfileId, campaignId: { in: pickedCampaigns } },
      select: { campaignId: true, text: true },
      orderBy: [{ keywordId: 'asc' }],
      take: 20_000,
    }),
    prisma.adsNegativeTarget.findMany({
      where: { tenantId: input.tenantId, adsProfileId: input.adsProfileId, campaignId: { in: pickedCampaigns } },
      select: { campaignId: true, expression: true },
      orderBy: [{ negativeId: 'asc' }],
      take: 20_000,
    }),
    prisma.adsAdGroup.findMany({
      where: { tenantId: input.tenantId, adsProfileId: input.adsProfileId, campaignId: { in: pickedCampaigns } },
      select: { adGroupId: true, campaignId: true },
      orderBy: [{ adGroupId: 'asc' }],
      take: 20_000,
    }),
    prisma.adsCampaign.findMany({
      where: { tenantId: input.tenantId, adsProfileId: input.adsProfileId, externalCampaignId: { in: pickedCampaigns } },
      select: { externalCampaignId: true, name: true },
      orderBy: [{ id: 'asc' }],
      take: 5000,
    }),
  ])
  const targets = await prisma.adsTarget.findMany({
    where: { tenantId: input.tenantId, adsProfileId: input.adsProfileId, adGroupId: { in: groups.map(group => group.adGroupId) } },
    select: { adGroupId: true, expression: true },
    orderBy: [{ targetId: 'asc' }],
    take: 20_000,
  })
  const campaignOfGroup = new Map(groups.map(group => [group.adGroupId, group.campaignId]))
  const targeted = new Map<string, Set<string>>()
  const negated = new Map<string, Set<string>>()
  const add = (map: Map<string, Set<string>>, campaign: string | null | undefined, text: string) => {
    if (!campaign) return
    const set = map.get(campaign) ?? new Set<string>()
    set.add(termKey(text))
    map.set(campaign, set)
  }
  for (const row of keywords) add(targeted, row.campaignId, row.text)
  for (const row of targets) add(targeted, campaignOfGroup.get(row.adGroupId), row.expression)
  for (const row of negatives) add(negated, row.campaignId, row.expression)
  const daily = new Map<string, AdsRuleDay[]>()
  for (const group of days.slice(0, ROW_LIMIT)) {
    if (group.externalCampaignId && group.searchTerm)
      pushDay(daily, `${group.externalCampaignId}|${group.searchTerm}`, rowOf(dateText(group.reportDate), { ...group._sum, spend: group._sum.cost, orders: group._sum.purchases }))
  }
  const campaignNames = new Map(names.map(row => [row.externalCampaignId, row.name]))
  const empty = new Set<string>()
  const subjects = picked.map(row => ({
    key: `${row.campaign}|${row.term}`,
    label: row.term,
    campaignLabel: campaignNames.get(row.campaign) ?? null,
    state: termStatus(row.term, targeted.get(row.campaign) ?? empty, negated.get(row.campaign) ?? empty),
    bid: null,
    budget: null,
    daily: daily.get(`${row.campaign}|${row.term}`) ?? [],
  }))
  return { subjects, incomplete: top.length > OBJECT_LIMIT || days.length > ROW_LIMIT }
}

export async function loadRuleSubjects(prisma: PrismaClient, input: RuleLoadInput): Promise<RuleSubjects> {
  const from = shiftDate(input.asOf, -((input.historyDays ?? HISTORY_DAYS) - 1))
  if (input.level === 'CAMPAIGN') return campaignSubjects(prisma, input, from)
  if (input.level === 'TARGET') return targetSubjects(prisma, input, from)
  return termSubjects(prisma, input, from)
}

/** 这个广告账户最新有日指标的一天（活动日汇总）；没有数据为 null。 */
export async function latestDataDate(prisma: PrismaClient, tenantId: string, adsProfileId: string): Promise<string | null> {
  const row = await prisma.adsDailySummary.findFirst({
    where: { tenantId, adsProfileId, currency: ADS_CONSOLE_CURRENCY },
    select: { summaryDate: true },
    orderBy: { summaryDate: 'desc' },
  })
  return row ? dateText(row.summaryDate) : null
}
