import type { AdsMetricsBase, AdsMetricsDatasetKey, AdsMetricsDimension } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'

// 广告指标（自由分析）各数据集的来源（P3-15）：对应哪张指标表、固定条件、维度对应哪些列、基础指标对应哪一列。
// 不同表的列名不一样（花费在活动日表叫 cost，其它叫 spend；订单在活动日表叫 purchases），差异全部收在这里。

type Loose = ReturnType<typeof JSON.parse>
export type MetricsDelegate = {
  groupBy(args: Loose): Promise<Loose[]>
  aggregate(args: Loose): Promise<Loose>
  count(args: Loose): Promise<number>
}

export interface DatasetSource {
  delegate: (prisma: PrismaService) => MetricsDelegate
  /** 日期列：日表是 reportDate，小时表是 hourStart。 */
  dateColumn: 'reportDate' | 'hourStart'
  /** 固定条件（词级表按层级、活动日表与小时表按对象类型）。 */
  fixed: Record<string, unknown>
  /** 维度 → 分组列（第一列是编号，第二列（如有）是名称）。 */
  columns: Partial<Record<AdsMetricsDimension, readonly string[]>>
  /** 基础指标 → 该表里的列；没有这一列的指标永远是空。 */
  sums: Partial<Record<AdsMetricsBase, string>>
}

const termSums = { impressions: 'impressions', clicks: 'clicks', spend: 'cost', sales: 'sales', orders: 'purchases' } as const
const factSums = { impressions: 'impressions', clicks: 'clicks', spend: 'spend', sales: 'sales', orders: 'orders' } as const

export const DATASET_SOURCES: Record<AdsMetricsDatasetKey, DatasetSource> = {
  CAMPAIGN: {
    delegate: prisma => prisma.adsMetric as unknown as MetricsDelegate,
    dateColumn: 'reportDate',
    fixed: { entityType: 'CAMPAIGN' },
    columns: { date: ['reportDate'], adProduct: ['adProduct'], campaign: ['externalCampaignId', 'campaignName'] },
    sums: { ...termSums, units: 'units' },
  },
  AD_GROUP: {
    delegate: prisma => prisma.adsTermMetric as unknown as MetricsDelegate,
    dateColumn: 'reportDate',
    fixed: { level: 'AD_GROUP' },
    columns: { date: ['reportDate'], adProduct: ['adProduct'], adGroup: ['adGroupId', 'adGroupName'] },
    sums: termSums,
  },
  TARGET: {
    delegate: prisma => prisma.adsTermMetric as unknown as MetricsDelegate,
    dateColumn: 'reportDate',
    fixed: { level: 'KEYWORD' },
    columns: {
      date: ['reportDate'],
      adProduct: ['adProduct'],
      campaign: ['externalCampaignId', 'campaignName'],
      adGroup: ['adGroupId', 'adGroupName'],
      target: ['keywordId', 'keywordText'],
      matchType: ['matchType'],
    },
    sums: termSums,
  },
  SEARCH_TERM: {
    delegate: prisma => prisma.adsTermMetric as unknown as MetricsDelegate,
    dateColumn: 'reportDate',
    fixed: { level: 'SEARCH_TERM' },
    columns: {
      date: ['reportDate'],
      adProduct: ['adProduct'],
      campaign: ['externalCampaignId', 'campaignName'],
      adGroup: ['adGroupId', 'adGroupName'],
      target: ['keywordId', 'keywordText'],
      matchType: ['matchType'],
      searchTerm: ['searchTerm'],
    },
    sums: termSums,
  },
  ADVERTISED_PRODUCT: {
    delegate: prisma => prisma.adsAdvertisedProductMetric as unknown as MetricsDelegate,
    dateColumn: 'reportDate',
    fixed: {},
    columns: { date: ['reportDate'], campaign: ['campaignId'], advertisedAsin: ['advertisedAsin'] },
    sums: { ...factSums, units: 'units' },
  },
  PLACEMENT: {
    delegate: prisma => prisma.adsPlacementMetric as unknown as MetricsDelegate,
    dateColumn: 'reportDate',
    fixed: {},
    columns: { date: ['reportDate'], campaign: ['campaignId'], placement: ['placement'] },
    sums: factSums,
  },
  CONVERTED_PRODUCT: {
    delegate: prisma => prisma.adsConvertedProductDaily as unknown as MetricsDelegate,
    dateColumn: 'reportDate',
    fixed: {},
    columns: { date: ['reportDate'], campaign: ['campaignId'], advertisedAsin: ['advertisedAsin'], purchasedAsin: ['purchasedAsin'], halo: ['isHalo'] },
    sums: { units: 'units', sales: 'sales' },
  },
  HOURLY: {
    delegate: prisma => prisma.adsPerformanceHourly as unknown as MetricsDelegate,
    dateColumn: 'hourStart',
    fixed: { entityType: 'CAMPAIGN' },
    columns: { hour: ['hourStart'], campaign: ['entityId'] },
    sums: factSums,
  },
}
