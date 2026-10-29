import type { AmazonAdsApiClient } from '../../connectors/amazon-ads-api'
import { importRows, type ImportResult } from '../../streaming/batch'
import { drain } from '../../streaming/download'
import type { RawFileOpener, RawFileRecord } from '../../streaming/raw-files'
import { decodeUtf8, jsonRows, type Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { dateFrom, decimal } from '../shared'

/** 广告报告里的词级报告（关键词、搜索词）：每批一个事务写入词级指标表。 */
export function syncAdsTermReport(
  ctx: ImportContext,
  reportJob: { id: string; fromDate: Date | null; adsProfileId: string; adProduct: string },
  tenantId: string,
  rows: AsyncIterable<Row>,
  level: 'KEYWORD' | 'SEARCH_TERM',
): Promise<ImportResult> {
  const str = (value: unknown) => (value == null ? '' : String(value)).trim()
  return importRows(ctx, rows, async ({ prisma }, row) => {
    const reportDate = dateFrom(row.date ?? row.reportDate ?? reportJob.fromDate ?? new Date())
    const externalCampaignId = str(row.campaignId ?? row.campaign_id) || null
    const campaignName = str(row.campaignName ?? row.campaign_name) || null
    const adGroupId = str(row.adGroupId ?? row.ad_group_id) || null
    const adGroupName = str(row.adGroupName ?? row.ad_group_name) || null
    const keywordId = str(row.keywordId ?? row.targetId ?? row.keyword_id ?? row.target_id) || null
    const keywordText = str(row.keyword ?? row.keywordText ?? row.targeting ?? row.targetingExpression ?? row.targetingText) || null
    const matchType = str(row.matchType ?? row.keywordMatchType ?? row.match_type) || null
    const searchTerm = str(row.searchTerm ?? row.query ?? row.customerSearchTerm ?? row.search_term) || null
    const rowKey = [externalCampaignId ?? '', adGroupId ?? '', keywordId ?? '', keywordText ?? '', searchTerm ?? ''].join('|').slice(0, 300)
    const metrics = {
      campaignName,
      adGroupName,
      keywordText,
      matchType,
      searchTerm,
      impressions: Number(row.impressions ?? 0),
      clicks: Number(row.clicks ?? 0),
      cost: decimal(row.cost ?? row.spend),
      sales: decimal(row.sales7d ?? row.sales ?? row.attributedSales14d ?? row.attributed_sales_14d),
      purchases: Number(row.purchases7d ?? row.purchases ?? row.purchases14d ?? row.attributedConversions14d ?? 0),
      raw: JSON.parse(JSON.stringify(row)),
      sourceUpdatedAt: new Date(),
    }
    await prisma.adsTermMetric.upsert({
      where: { adsProfileId_reportDate_adProduct_level_rowKey: { adsProfileId: reportJob.adsProfileId, reportDate, adProduct: reportJob.adProduct, level, rowKey } },
      create: {
        tenantId,
        adsProfileId: reportJob.adsProfileId,
        reportJobId: reportJob.id,
        reportDate,
        adProduct: reportJob.adProduct,
        level,
        externalCampaignId,
        adGroupId,
        keywordId,
        targetId: keywordId, // P3-02：旧版报告里投放对象与关键词同一个编号
        rowKey,
        currency: String(row.currency ?? 'USD'),
        ...metrics,
      },
      update: metrics,
    })
    return 'imported'
  })
}

type AdsReportJobRef = { id: string; downloadUrl: string | null; fromDate: Date | null; adsProfileId: string; adProduct: string; reportType: string }

/** 原始文件留存：打开函数、文件名与登记信息；不提供时只解析不留存。 */
export interface AdsRawRetention {
  open: RawFileOpener
  fileName: string
  record: Omit<RawFileRecord, 'rowCount'>
}

/**
 * 下载并流式导入广告报告：下载流 → 解压流 → 逐条解析 → 每 1000 条一批写库；
 * 原始文件同时写入对象存储：导入成功后登记，失败则丢弃。
 */
export async function syncAdsReport(ctx: ImportContext, client: AmazonAdsApiClient, reportJob: AdsReportJobRef, tenantId: string, url: string, retention?: AdsRawRetention): Promise<ImportResult> {
  const raw = retention?.open({ tenantId, domain: 'ads-reports', name: retention.fileName })
  try {
    const stream = await client.openReport(url, { sink: raw?.sink })
    const result = await importAdsRows(ctx, jsonRows(decodeUtf8(stream)), reportJob, tenantId)
    await drain(stream)
    await raw?.complete({ ...retention!.record, rowCount: result.read })
    return result
  } catch (error) {
    await raw?.discard()
    throw error
  }
}

/** 按报告类型把行流写入对应的指标表（与下载解耦，便于用样例文件直接测试）。 */
export function importAdsRows(ctx: ImportContext, rows: AsyncIterable<Row>, reportJob: AdsReportJobRef, tenantId: string): Promise<ImportResult> {
  const reportType = reportJob.reportType || ''
  if (/search[_ ]?term/i.test(reportType)) return syncAdsTermReport(ctx, reportJob, tenantId, rows, 'SEARCH_TERM')
  if (/keyword|target/i.test(reportType)) return syncAdsTermReport(ctx, reportJob, tenantId, rows, 'KEYWORD')
  return importRows(ctx, rows, async ({ prisma }, row) => {
    const reportDate = dateFrom(row.date ?? row.reportDate ?? reportJob.fromDate ?? new Date())
    const externalCampaignId = String(row.campaignId ?? row.campaign_id ?? row.advertisedAsin ?? row.advertisedSku ?? row.searchTerm ?? '').trim() || ''
    await prisma.adsMetric.upsert({
      where: { adsProfileId_reportDate_adProduct_externalCampaignId: { adsProfileId: reportJob.adsProfileId, reportDate, adProduct: reportJob.adProduct, externalCampaignId: externalCampaignId } },
      create: {
        tenantId,
        adsProfileId: reportJob.adsProfileId,
        reportJobId: reportJob.id,
        reportDate,
        adProduct: reportJob.adProduct,
        externalCampaignId: externalCampaignId,
        // P3-02：旧版报告按活动汇总，对象类型固定为活动；没有编号时对象编号留空，不写空串
        entityType: 'CAMPAIGN',
        entityId: externalCampaignId || null,
        campaignName: String(row.campaignName ?? row.campaign_name ?? '') || undefined,
        impressions: Number(row.impressions ?? 0),
        clicks: Number(row.clicks ?? 0),
        cost: decimal(row.cost ?? row.spend),
        sales: decimal(row.sales7d ?? row.sales ?? row.attributedSales14d ?? row.attributed_sales_14d),
        purchases: Number(row.purchases7d ?? row.purchases ?? row.purchases14d ?? row.attributedConversions14d ?? 0),
        currency: String(row.currency ?? 'USD'),
        raw: JSON.parse(JSON.stringify(row)),
        sourceUpdatedAt: new Date(),
      },
      update: {
        campaignName: String(row.campaignName ?? row.campaign_name ?? '') || undefined,
        impressions: Number(row.impressions ?? 0),
        clicks: Number(row.clicks ?? 0),
        cost: decimal(row.cost ?? row.spend),
        sales: decimal(row.sales7d ?? row.sales ?? row.attributedSales14d ?? row.attributed_sales_14d),
        purchases: Number(row.purchases7d ?? row.purchases ?? row.purchases14d ?? row.attributedConversions14d ?? 0),
        raw: JSON.parse(JSON.stringify(row)),
        sourceUpdatedAt: new Date(),
      },
    })
    return 'imported'
  })
}
