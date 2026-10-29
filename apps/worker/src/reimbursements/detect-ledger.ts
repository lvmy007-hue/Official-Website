import { classifyLedgerEvent, netLedgerClaims, type LedgerClaimEvent, type OpportunityEvidence, type OpportunityRule } from '@nova/api-contracts'
import { paidQuantity } from './opportunity-write.js'
import { SCAN_LIMIT, commitRule, dayText, shiftDay, type DraftInput, type ScanContext, type ScanResult } from './scan.js'

// 第 2、3 类：库存台账里的“丢失”“损坏”调整（07 章 7.3）。
// 口径：台账的库存调整事件，原因判成丢失（损坏）的，事件日起过了等待期、没过申请期限的，按 店铺 + SKU 汇总；
// 同一个 SKU 之后“找到”的数量，和官方赔付明细里原因吻合的已赔付数量，从最早的缺口开始依次抵扣，剩下的才是赔付机会。
// 找到的数量不区分对应哪一笔丢失（台账里没有这个关联），按事件日不早于最早缺口的合计抵扣，是偏保守的口径。

interface Entry {
  id: string
  sellerAccountId: string
  key: string
  sku: string
  date: string
  qty: number
}

const RULE_KIND: ReadonlyArray<{ rule: Extract<OpportunityRule, 'LEDGER_LOST' | 'LEDGER_DAMAGED'>; kind: 'lost' | 'damaged'; label: string }> = [
  { rule: 'LEDGER_LOST', kind: 'lost', label: '丢失' },
  { rule: 'LEDGER_DAMAGED', kind: 'damaged', label: '损坏' },
]

export async function detectLedger(ctx: ScanContext): Promise<ScanResult[]> {
  const { db, tenantId, now, windows } = ctx
  const since = shiftDay(now, -Math.max(windows.LEDGER_LOST.windowDays, windows.LEDGER_DAMAGED.windowDays))
  const rows = await db.inventoryLedgerEntry.findMany({
    where: { tenantId, eventDate: { gte: since }, eventType: { contains: 'adjust', mode: 'insensitive' } },
    select: { id: true, sellerAccountId: true, eventDate: true, fnsku: true, sku: true, eventType: true, reasonCode: true, quantity: true },
    orderBy: { eventDate: 'asc' },
    take: SCAN_LIMIT + 1,
  })
  const truncated = rows.length > SCAN_LIMIT
  const byKind: Record<'lost' | 'damaged' | 'found', Entry[]> = { lost: [], damaged: [], found: [] }
  for (const row of rows.slice(0, SCAN_LIMIT)) {
    const kind = classifyLedgerEvent(row.eventType, row.reasonCode).adjustment
    if (kind !== 'lost' && kind !== 'damaged' && kind !== 'found') continue
    const key = row.sku || row.fnsku
    if (!key || row.quantity === 0) continue
    byKind[kind].push({ id: row.id, sellerAccountId: row.sellerAccountId, key, sku: row.sku, date: dayText(row.eventDate), qty: Math.abs(row.quantity) })
  }
  const found = new Map<string, Entry[]>()
  for (const entry of byKind.found) found.set(`${entry.sellerAccountId}|${entry.key}`, [...(found.get(`${entry.sellerAccountId}|${entry.key}`) ?? []), entry])

  const results: ScanResult[] = []
  for (const { rule, kind, label } of RULE_KIND) {
    const { waitDays, windowDays } = windows[rule]
    const eligibleTo = dayText(shiftDay(now, -waitDays))
    const earliest = dayText(shiftDay(now, -windowDays))
    const groups = new Map<string, Entry[]>()
    for (const entry of byKind[kind]) {
      if (entry.date > eligibleTo || entry.date < earliest) continue
      const group = `${entry.sellerAccountId}|${entry.key}`
      groups.set(group, [...(groups.get(group) ?? []), entry])
    }
    const drafts: DraftInput[] = []
    for (const [group, entries] of groups) {
      const first = entries.reduce((min, entry) => (entry.date < min ? entry.date : min), entries[0].date)
      const foundQty = kind === 'lost' ? (found.get(group) ?? []).filter(entry => entry.date >= first).reduce((sum, entry) => sum + entry.qty, 0) : 0
      const sample = entries[0]
      const paid = sample.sku ? await paidQuantity(db, tenantId, sample.sellerAccountId, sample.sku, rule, new Date(`${first}T00:00:00.000Z`), ctx.paidCache) : 0
      const events: LedgerClaimEvent[] = entries.map(entry => ({ id: entry.id, date: entry.date, qty: entry.qty }))
      const byId = new Map(entries.map(entry => [entry.id, entry]))
      for (const left of netLedgerClaims(events, foundQty + paid)) {
        const entry = byId.get(left.id)
        if (!entry) continue
        const evidence: OpportunityEvidence[] = [
          { kind: 'LEDGER', id: entry.id, label: `库存台账 ${entry.date} ${label} ${entry.qty} 件` },
          { kind: 'SKU', id: entry.key, label: entry.key },
        ]
        drafts.push({ sellerAccountId: entry.sellerAccountId, ruleCode: rule, dedupKey: entry.id, sku: entry.sku || null, qty: left.qty, anchor: new Date(`${entry.date}T00:00:00.000Z`), evidence })
      }
    }
    results.push(await commitRule(ctx, rule, drafts, truncated))
  }
  return results
}
