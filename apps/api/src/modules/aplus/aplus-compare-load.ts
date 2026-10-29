import type { AplusDailyPoint } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { asDate, dateText } from '../overview'
import { chunk } from './aplus-common'

// 发布前后对照的取数（P4-14）：只读销售与流量的 ASIN 日表（P4-01 同步），口径同业务报告（business-reports-load.ts）：
// 只取“子 ASIN”粒度（父体与 SKU 粒度的行会重复计数）与美元行；同一 ASIN、SKU、日期两个来源都有时只用数据中心的（没有才用报告补充）。
// 官方没给的列是空（不是 0）：一个日期里全部行的会话都为空，这一天按“没有数据”处理。

const CURRENCY = 'USD'
/** 每次最多查这么多个 ASIN：每个 ASIN 一天至多几行（来源 × SKU），分批后每批远低于单次读取上限 19,999。 */
const ASIN_CHUNK = 100
const ROW_LIMIT = 19_999

interface DailyRow {
  asin: string
  sku: string
  source: string
  date: string
  sessions: number | null
  units: number | null
}

/** 同键两个来源只留数据中心的。 */
function preferred(rows: readonly DailyRow[]): DailyRow[] {
  const best = new Map<string, DailyRow>()
  for (const row of rows) {
    const key = `${row.asin}|${row.sku}|${row.date}`
    const current = best.get(key)
    if (!current || (row.source === 'DATA_KIOSK' && current.source !== 'DATA_KIOSK')) best.set(key, row)
  }
  return [...best.values()]
}

/**
 * 一批 ASIN 在店铺里按日合计的会话与订购件数；整个区间没有任何销售流量行返回 null（尚未接入），不是 0。
 * 某个日期里全部行的会话（或件数）都为空时，该日的合计为空。
 */
export async function loadCompareDaily(prisma: PrismaService, input: { tenantId: string; storeId: string; asins: readonly string[]; from: string; to: string }): Promise<AplusDailyPoint[] | null> {
  const rows: DailyRow[] = []
  for (const part of chunk([...new Set(input.asins)], ASIN_CHUNK)) {
    const found = await prisma.salesTrafficAsinDaily.findMany({
      where: {
        tenantId: input.tenantId,
        sellerAccountId: input.storeId,
        asin: { in: part },
        asinGranularity: 'CHILD',
        currency: CURRENCY,
        date: { gte: asDate(input.from), lte: asDate(input.to) },
      },
      select: { asin: true, sku: true, source: true, date: true, sessions: true, units: true },
      orderBy: [{ date: 'asc' }, { asin: 'asc' }, { sku: 'asc' }, { source: 'asc' }],
      take: ROW_LIMIT,
    })
    for (const row of found) rows.push({ asin: row.asin, sku: row.sku, source: row.source, date: dateText(row.date), sessions: row.sessions, units: row.units })
  }
  if (rows.length === 0) return null
  const days = new Map<string, { sessions: number | null; units: number | null }>()
  for (const row of preferred(rows)) {
    const day = days.get(row.date) ?? { sessions: null, units: null }
    if (row.sessions !== null) day.sessions = (day.sessions ?? 0) + row.sessions
    if (row.units !== null) day.units = (day.units ?? 0) + row.units
    days.set(row.date, day)
  }
  return [...days.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, day]) => ({ date, sessions: day.sessions, units: day.units }))
}
