import { ADS_REPORT_AD_PRODUCTS, type AdsReportTemplateKey } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import { dayDate, type ParsedReportRow } from './rows'

// 新报告接口各模板的写库（P3-15）：每个模板落在对应的指标表，键与旧版一致的表（活动日指标、词级指标）沿用旧键，
// 所以新旧接口对同一天同一对象的数据落在同一行上（新值覆盖旧值，核对在覆盖之前做）。
// 报告里没给的指标不覆盖库里已有的值（update 里用 undefined 保持不变）；新建行时没给的金额留空，计数列沿用库的默认值 0（这些表的计数列不允许为空）。
// 调用方保证 prisma 是已进入租户上下文的客户端（批量导入里的事务客户端）。

export type WriteScope = {
  tenantId: string
  adsProfileId: string
  adsAccountId: string
  jobId: string
  adProduct: string
  currency: string
  now: Date
}

const count = (value: number | null) => (value === null ? undefined : Math.round(value))
const money = (value: number | null) => value ?? undefined

const adProductOf = (row: ParsedReportRow, scope: WriteScope) => ((ADS_REPORT_AD_PRODUCTS as readonly string[]).includes(row.keys.adProduct) ? row.keys.adProduct : scope.adProduct)
const nonEmpty = (value: string) => value || null

/** 词级指标表的行键：与旧版写入器同一格式（活动|广告组|投放对象编号|表达式|搜索词），新旧才落在同一行。 */
export const termRowKey = (keys: { campaignId: string; adGroupId: string; targetId: string; targetText: string; searchTerm: string }) =>
  [keys.campaignId, keys.adGroupId, keys.targetId, keys.targetText, keys.searchTerm].join('|').slice(0, 300)

/** 活动指标表（AdsMetric）一行的指标列：活动行与广告组、投放对象行同一口径。 */
function metricValues(scope: WriteScope, row: ParsedReportRow) {
  const { metrics } = row
  return {
    adsAccountId: scope.adsAccountId,
    impressions: count(metrics.impressions),
    clicks: count(metrics.clicks),
    cost: money(metrics.cost),
    sales: money(metrics.sales),
    purchases: count(metrics.purchases),
    units: count(metrics.units),
    reportJobId: scope.jobId,
    sourceReportJobId: scope.jobId,
    sourceUpdatedAt: scope.now,
  }
}

/**
 * 广告组与投放对象日报同时写一行对象维度的指标（entityType 为 AD_GROUP 或 TARGET，外键键不带活动编号以免与活动行的旧唯一键冲突）：
 * 广告组页、投放对象页与广告组趋势读的是这张表（按对象编号），词级表只服务词级中心。
 * 写进同一张表的对象行是同一笔花费的更细拆分，汇总活动花费的读取方必须只取 entityType = CAMPAIGN（日汇总、利润、现金流、迁移期核对都已这样做）。
 */
async function writeEntityMetric(prisma: PrismaClient, scope: WriteScope, entityType: 'AD_GROUP' | 'TARGET', row: ParsedReportRow) {
  const entityId = entityType === 'AD_GROUP' ? row.keys.adGroupId : row.keys.targetId
  if (!entityId) return
  const adProduct = adProductOf(row, scope)
  const reportDate = dayDate(row.keys.day)
  const values = metricValues(scope, row)
  await prisma.adsMetric.upsert({
    where: { tenantId_adsAccountId_entityType_entityId_reportDate_adProduct: { tenantId: scope.tenantId, adsAccountId: scope.adsAccountId, entityType, entityId, reportDate, adProduct } },
    create: { tenantId: scope.tenantId, adsProfileId: scope.adsProfileId, reportDate, adProduct, entityType, entityId, currency: scope.currency, ...values },
    update: values,
  })
}

async function writeCampaign(prisma: PrismaClient, scope: WriteScope, row: ParsedReportRow) {
  const { keys } = row
  const adProduct = adProductOf(row, scope)
  const reportDate = dayDate(keys.day)
  const values = metricValues(scope, row)
  await prisma.adsMetric.upsert({
    where: { adsProfileId_reportDate_adProduct_externalCampaignId: { adsProfileId: scope.adsProfileId, reportDate, adProduct, externalCampaignId: keys.campaignId } },
    create: {
      tenantId: scope.tenantId,
      adsProfileId: scope.adsProfileId,
      reportDate,
      adProduct,
      externalCampaignId: keys.campaignId,
      entityType: 'CAMPAIGN',
      entityId: keys.campaignId,
      currency: scope.currency,
      ...values,
    },
    update: values,
  })
}

async function writeTerm(prisma: PrismaClient, scope: WriteScope, templateKey: AdsReportTemplateKey, row: ParsedReportRow) {
  const { keys, metrics } = row
  const level = templateKey === 'AD_GROUP_DAILY' ? 'AD_GROUP' : templateKey === 'TARGET_DAILY' ? 'KEYWORD' : 'SEARCH_TERM'
  const adProduct = adProductOf(row, scope)
  const reportDate = dayDate(keys.day)
  const rowKey = termRowKey({
    ...keys,
    targetId: level === 'AD_GROUP' ? '' : keys.targetId,
    targetText: level === 'AD_GROUP' ? '' : keys.targetText,
    searchTerm: level === 'SEARCH_TERM' ? keys.searchTerm : '',
  })
  const values = {
    adsAccountId: scope.adsAccountId,
    impressions: count(metrics.impressions),
    clicks: count(metrics.clicks),
    cost: money(metrics.cost),
    sales: money(metrics.sales),
    purchases: count(metrics.purchases),
    reportJobId: scope.jobId,
    sourceReportJobId: scope.jobId,
    sourceUpdatedAt: scope.now,
  }
  const names =
    level === 'AD_GROUP'
      ? {}
      : {
          keywordId: nonEmpty(keys.targetId),
          targetId: nonEmpty(keys.targetId),
          keywordText: nonEmpty(keys.targetText),
          matchType: nonEmpty(keys.matchType),
          ...(level === 'SEARCH_TERM' ? { searchTerm: keys.searchTerm, matchedTargetExpression: nonEmpty(keys.targetText) } : {}),
        }
  await prisma.adsTermMetric.upsert({
    where: { adsProfileId_reportDate_adProduct_level_rowKey: { adsProfileId: scope.adsProfileId, reportDate, adProduct, level, rowKey } },
    create: {
      tenantId: scope.tenantId,
      adsProfileId: scope.adsProfileId,
      reportDate,
      adProduct,
      level,
      rowKey,
      externalCampaignId: keys.campaignId,
      adGroupId: nonEmpty(keys.adGroupId),
      currency: scope.currency,
      ...names,
      ...values,
    },
    update: { ...names, ...values },
  })
}

export async function writeReportRow(prisma: PrismaClient, scope: WriteScope, templateKey: AdsReportTemplateKey, row: ParsedReportRow): Promise<void> {
  const { keys, metrics } = row
  const base = { tenantId: scope.tenantId, adsProfileId: scope.adsProfileId, adsAccountId: scope.adsAccountId, currency: scope.currency, sourceUpdatedAt: scope.now, sourceReportJobId: scope.jobId }
  const reportDate = dayDate(keys.day)
  switch (templateKey) {
    case 'CAMPAIGN_DAILY':
      return writeCampaign(prisma, scope, row)
    case 'AD_GROUP_DAILY':
    case 'TARGET_DAILY':
      await writeEntityMetric(prisma, scope, templateKey === 'AD_GROUP_DAILY' ? 'AD_GROUP' : 'TARGET', row)
      return writeTerm(prisma, scope, templateKey, row)
    case 'SEARCH_TERM_DAILY':
      return writeTerm(prisma, scope, templateKey, row)
    case 'ADVERTISED_PRODUCT_DAILY': {
      const values = {
        impressions: count(metrics.impressions),
        clicks: count(metrics.clicks),
        spend: money(metrics.cost),
        sales: money(metrics.sales),
        orders: count(metrics.purchases),
        units: count(metrics.units),
        sourceUpdatedAt: scope.now,
        sourceReportJobId: scope.jobId,
      }
      await prisma.adsAdvertisedProductMetric.upsert({
        where: {
          tenantId_adsAccountId_campaignId_advertisedAsin_reportDate: {
            tenantId: scope.tenantId,
            adsAccountId: scope.adsAccountId,
            campaignId: keys.campaignId,
            advertisedAsin: keys.advertisedAsin,
            reportDate,
          },
        },
        create: { ...base, campaignId: keys.campaignId, advertisedAsin: keys.advertisedAsin, reportDate, ...values },
        update: values,
      })
      return
    }
    case 'PLACEMENT_DAILY': {
      const values = {
        impressions: count(metrics.impressions),
        clicks: count(metrics.clicks),
        spend: money(metrics.cost),
        sales: money(metrics.sales),
        orders: count(metrics.purchases),
        sourceUpdatedAt: scope.now,
        sourceReportJobId: scope.jobId,
      }
      await prisma.adsPlacementMetric.upsert({
        where: {
          tenantId_adsAccountId_campaignId_placement_reportDate: { tenantId: scope.tenantId, adsAccountId: scope.adsAccountId, campaignId: keys.campaignId, placement: keys.placement, reportDate },
        },
        create: { ...base, campaignId: keys.campaignId, placement: keys.placement, reportDate, ...values },
        update: values,
      })
      return
    }
    case 'CAMPAIGN_HOURLY': {
      const hourStart = keys.hourStart as Date
      const values = {
        impressions: count(metrics.impressions),
        clicks: count(metrics.clicks),
        spend: money(metrics.cost),
        sales: money(metrics.sales),
        orders: count(metrics.purchases),
        sourceUpdatedAt: scope.now,
        sourceReportJobId: scope.jobId,
      }
      await prisma.adsPerformanceHourly.upsert({
        where: { tenantId_adsAccountId_entityType_entityId_hourStart: { tenantId: scope.tenantId, adsAccountId: scope.adsAccountId, entityType: 'CAMPAIGN', entityId: keys.campaignId, hourStart } },
        create: { ...base, entityType: 'CAMPAIGN', entityId: keys.campaignId, hourStart, ...values },
        update: values,
      })
      return
    }
    case 'CONVERTED_PRODUCT_DAILY': {
      // 解析阶段已保证件数与销售额都有值；被推广与被购买 ASIN 不同就是光环销售
      const values = {
        units: Math.round(metrics.units as number),
        sales: metrics.sales as number,
        isHalo: keys.advertisedAsin !== keys.purchasedAsin,
        sourceUpdatedAt: scope.now,
        sourceReportJobId: scope.jobId,
      }
      await prisma.adsConvertedProductDaily.upsert({
        where: {
          tenantId_adsAccountId_campaignId_advertisedAsin_purchasedAsin_reportDate: {
            tenantId: scope.tenantId,
            adsAccountId: scope.adsAccountId,
            campaignId: keys.campaignId,
            advertisedAsin: keys.advertisedAsin,
            purchasedAsin: keys.purchasedAsin,
            reportDate,
          },
        },
        create: { ...base, campaignId: keys.campaignId, advertisedAsin: keys.advertisedAsin, purchasedAsin: keys.purchasedAsin, reportDate, ...values },
        update: values,
      })
    }
  }
}
