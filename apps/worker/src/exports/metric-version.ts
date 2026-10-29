import type { PrismaClient } from '@prisma/client'

// 导出文件写明口径版本（P6-31，14 章 P6-31 第 4 点；R6-30 补）：
// 带经营数字的导出（经营报告、商品、自定义报表）在表格最后加一列“口径版本”，每行写生成时企业生效的利润公式与业务口径版本，
// 表头仍在第一行，不影响电子表格筛选与透视。没有生效版本时写“默认”，与页面问号一致。

export const METRIC_VERSIONED_KINDS: ReadonlySet<string> = new Set(['overview-report', 'products', 'custom-report'])

export const METRIC_VERSION_HEADER = '口径版本'

export async function metricVersionLabel(db: PrismaClient, tenantId: string): Promise<string> {
  const rows = await db.metricVersion.findMany({
    where: { tenantId, kind: { in: ['PROFIT_FORMULA', 'BUSINESS_RULES'] }, status: 'ACTIVE' },
    select: { kind: true, versionNo: true },
    take: 10,
  })
  const of = (kind: string) => {
    const row = rows.find(item => item.kind === kind)
    return row ? `v${row.versionNo}` : '默认'
  }
  return `利润公式 ${of('PROFIT_FORMULA')}；业务口径 ${of('BUSINESS_RULES')}`
}
