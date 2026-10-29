import { LISTING_FYP_REPORT_TYPE } from '@nova/api-contracts'
import { importRows } from '../../streaming/batch'
import { cells, requireColumns, text } from '../inventory/columns'
import type { RowsImporter } from '../inventory/registry'

// 被搜索抑制的刊登报告（importers.md R-32，GET_MERCHANTS_LISTINGS_FYP_REPORT，P4-10）：每日一份当前状态。每一行是一个被搜索抑制的 SKU 与原因，
// 写成 issueKind = SEARCH_SUPPRESSED 的刊登问题（影响 = 被搜索抑制，严重度 = 错误）。列名依据亚马逊文档整理（Status、Reason、SKU、ASIN、Product name、Issue Description），
// 没有真实报告逐列核对（CR-085 未验证清单）：SKU 列一个别名都对不上就以 PARSE_HEADER 失败并留存原始文件，不把整份报告当成“没有被抑制的商品”。
// 生命周期与刊登同步一致：仍在报告里 → 更新最后出现时间；整份导完后这一店铺里本次没出现的未解决抑制 → 写解决时间；再次出现 → 重开。
// 一份只有表头没有数据行的报告表示“当前没有被搜索抑制的商品”，会把此前的抑制全部标为已解决。

type Scope = { tenantId: string; sellerAccountId: string }
type Options = { reportJobId?: string | null }

export const FYP_COLUMNS = {
  sku: ['sku', 'seller-sku', 'merchant-sku'],
  asin: ['asin', 'asin1'],
  reason: ['reason', 'suppression-reason'],
  description: ['issue-description', 'description', 'issue'],
} as const

const KIND = 'SEARCH_SUPPRESSED'
const MARKER = ''

export function fypReportImporter(scope: Scope, _options: Options = {}): RowsImporter {
  const { tenantId, sellerAccountId } = scope
  return async (ctx, rows) => {
    const startedAt = new Date()
    const result = await importRows(
      ctx,
      rows,
      async ({ prisma }, row, index) => {
        const c = cells(row)
        if (index === 0) requireColumns(c, [FYP_COLUMNS.sku], LISTING_FYP_REPORT_TYPE)
        const sku = text(c, FYP_COLUMNS.sku)
        if (!sku) return 'skipped'
        const reason = text(c, FYP_COLUMNS.reason) ?? ''
        const code = (
          reason
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'SEARCH_SUPPRESSED'
        ).slice(0, 120)
        const now = new Date()
        const fields = {
          asin: (text(c, FYP_COLUMNS.asin) ?? '').toUpperCase(),
          category: '',
          severity: 'ERROR',
          impact: 'SEARCH_SUPPRESSED',
          message: (text(c, FYP_COLUMNS.description) ?? (reason || '商品被搜索抑制')).slice(0, 1000),
          lastSeenAt: now,
        }
        const where = { sellerAccountId_sellerSku_issueKind_issueCode_attributeName: { sellerAccountId, sellerSku: sku, issueKind: KIND, issueCode: code, attributeName: MARKER } }
        const before = await prisma.listingIssue.findUnique({ where })
        if (!before) await prisma.listingIssue.create({ data: { tenantId, sellerAccountId, sellerSku: sku, issueKind: KIND, issueCode: code, attributeName: MARKER, firstSeenAt: now, ...fields } })
        else if (before.resolvedAt)
          await prisma.listingIssue.update({ where, data: { ...fields, firstSeenAt: now, resolvedAt: null, handlingStatus: 'OPEN', handlingRunId: null, version: { increment: 1 } } })
        else await prisma.listingIssue.update({ where, data: fields })
        return 'imported'
      },
      { skippedMessage: 'listings FYP rows without a SKU were skipped', logFields: { tenantId, sellerAccountId } },
    )
    if (!(result.read > 0 && result.imported === 0)) {
      await ctx.prisma.listingIssue.updateMany({ where: { tenantId, sellerAccountId, issueKind: KIND, resolvedAt: null, lastSeenAt: { lt: startedAt } }, data: { resolvedAt: new Date() } })
    }
    return result
  }
}
