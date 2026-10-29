import { BA_TERMS_RANK_LIMIT } from '@nova/api-contracts'
import { importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { asinOf, dateOnly, fraction, rank, readPeriod, textOf, type BrandReportOptions } from './parse'

// 品牌分析·热门搜索词（importers.md R-37，GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT，JSON）→ BrandSearchTerm（P4-04）。
// 报告形状：{ reportSpecification, dataByDepartmentAndSearchTerm: [{ startDate, endDate, departmentName, searchTerm, searchFrequencyRank,
//   clickedAsin, clickedItemName, clickShareRank, clickShare, conversionShare }] }。官方每行是“搜索词 × 点击份额排名 1 至 3 的商品”：
// 同一个词最多三行，导入时按 clickShareRank 合并进同一行的三组列（clickedAsin1..3 等），所以一个词一行。
// 整份报告可达数百万行，只导入搜索频率排名 ≤ BA_TERMS_RANK_LIMIT 的词，更靠后的行计入“忽略”而不是“跳过”。
// 搜索词统一小写（亚马逊搜索词不区分大小写，便于与广告关键词对照）。
// **字段名对照官方样例整理，没有对真实店铺核对**；官方没给的值是 null（不补 0）。

export function readTermRow(row: Row, options: BrandReportOptions) {
  const period = readPeriod(row, options)
  const searchTerm = textOf(row.searchTerm)?.toLowerCase() ?? null
  if (!period || !searchTerm) return null
  return {
    period,
    searchTerm,
    department: textOf(row.departmentName, 200) ?? '',
    searchFrequencyRank: rank(row.searchFrequencyRank),
    slot: rank(row.clickShareRank),
    asin: asinOf(row.clickedAsin),
    title: textOf(row.clickedItemName, 500),
    clickShare: fraction(row.clickShare),
    conversionShare: fraction(row.conversionShare),
  }
}

export function syncSearchTermsReport(ctx: ImportContext, rows: AsyncIterable<Row>, tenantId: string, sellerAccountId: string, options: BrandReportOptions = {}): Promise<ImportResult> {
  const now = options.now ?? new Date()
  const scope = { tenantId, sellerAccountId }
  return importRows(
    ctx,
    rows,
    async (inner, row) => {
      const parsed = readTermRow(row, options)
      if (!parsed) return 'skipped'
      // 排名缺失的行不进榜单（没有排名无法比较）；排名超过上限、点击份额排名不在 1 至 3 的行不导入
      if (parsed.searchFrequencyRank === null) return 'skipped'
      if (parsed.searchFrequencyRank > BA_TERMS_RANK_LIMIT || parsed.slot === null || parsed.slot > 3) return 'ignored'
      const { period, department, searchTerm, slot } = parsed
      const periodStart = dateOnly(period.start)
      const slotData = { [`clickedAsin${slot}`]: parsed.asin, [`clickedTitle${slot}`]: parsed.title, [`clickShare${slot}`]: parsed.clickShare, [`conversionShare${slot}`]: parsed.conversionShare }
      const data = {
        searchFrequencyRank: parsed.searchFrequencyRank,
        periodEnd: dateOnly(period.end),
        sourceReportJobId: options.reportJobId ?? null,
        sourceUpdatedAt: now,
        syncedAt: now,
        ...slotData,
      }
      await inner.prisma.brandSearchTerm.upsert({
        where: { tenantId_sellerAccountId_reportPeriod_periodStart_department_searchTerm: { ...scope, reportPeriod: period.kind, periodStart, department, searchTerm } },
        create: { ...scope, reportPeriod: period.kind, periodStart, department, searchTerm, ...data },
        update: data,
      })
      return 'imported'
    },
    { skippedMessage: 'brand search term rows without a usable period, term or rank were skipped', logFields: scope },
  )
}
