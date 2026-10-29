import { FEE_AUDIT_STORAGE_MONTHS, FEE_AUDIT_VOLUME_TOLERANCE, overchargeOf, roundMoney } from '@nova/api-contracts'
import {
  AUDIT_LIMIT,
  addLine,
  buildDims,
  chunked,
  dimsNote,
  emptyAccumulator,
  latestBaselines,
  loadProducts,
  skuKeyOf,
  subjectOf,
  type AuditContext,
  type AuditResult,
  type AuditSubject,
  type LineAccumulator,
} from './shared'

// 仓储费核查（P2b-06，07 章 7.6 第 3 类，“按体积核对”）：月度仓储费按体积收，亚马逊测量体积比我方登记体积大时，仓储费也会按比例偏多。
// 只有两边都有尺寸时才核查：亚马逊测量尺寸来自 R-23，我方登记尺寸来自商品记录的包装尺寸。
// 亚马逊测量体积 ÷ 我方登记体积超过 1 + 容差时，应收 = 月度仓储费预估 ÷ 体积比（按我方体积折算），再与实收（报告里的预估费用）比较；其余月份视为正常。
// 限制：只比较体积，不重新计算费率与利用率附加费；月度仓储费报告给的是预估费用，不是已结算金额；我方登记尺寸若本身有误，结论会被带偏——依据里写出两边的数字。

export async function auditStorage(ctx: AuditContext, now: Date = ctx.now): Promise<AuditResult> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (FEE_AUDIT_STORAGE_MONTHS - 1), 1))
  const records = await ctx.db.storageFeeRecord.findMany({
    where: { tenantId: ctx.tenantId, feeKind: 'STORAGE', chargeMonth: { gte: from }, amount: { gt: 0 } },
    select: { sellerAccountId: true, sku: true, fnsku: true, asin: true, chargeMonth: true, amount: true, currency: true },
    orderBy: { chargeMonth: 'desc' },
    take: AUDIT_LIMIT + 1,
  })
  const truncated = records.length > AUDIT_LIMIT
  const kept = records.slice(0, AUDIT_LIMIT)
  // 报告没有 SKU 列时，用商品记录的 FNSKU 反查 SKU
  const missing = [...new Set(kept.filter(row => !row.sku && row.fnsku).map(row => row.fnsku))]
  const skuOfFnsku = new Map<string, string>()
  for (const part of chunked(missing, 500)) {
    const rows = await ctx.db.fbaProduct.findMany({ where: { tenantId: ctx.tenantId, fnsku: { in: part } }, select: { sellerAccountId: true, sellerSku: true, fnsku: true }, take: 5000 })
    for (const row of rows) if (row.fnsku) skuOfFnsku.set(`${row.sellerAccountId}|${row.fnsku}`, row.sellerSku)
  }
  const { latest: baselines, truncated: baselineCut } = await latestBaselines(ctx, 'lengthCm')
  const monthly = new Map<string, { sellerAccountId: string; sku: string; asin: string | null; currency: string; month: Date; amount: number }>()
  for (const row of kept) {
    const sku = row.sku || skuOfFnsku.get(`${row.sellerAccountId}|${row.fnsku}`)
    if (!sku) continue
    const key = `${row.sellerAccountId}|${sku}|${row.chargeMonth.toISOString().slice(0, 7)}|${row.currency}`
    const hit = monthly.get(key)
    const amount = Number(row.amount.toString())
    if (hit) hit.amount += amount
    else monthly.set(key, { sellerAccountId: row.sellerAccountId, sku, asin: row.asin || null, currency: row.currency, month: row.chargeMonth, amount })
  }
  const products = await loadProducts(
    ctx,
    [...monthly.values()].map(row => row.sku),
  )
  const slots = new Map<string, { acc: LineAccumulator; identity: Pick<AuditSubject, 'sellerAccountId' | 'subjectKey' | 'sku' | 'asin' | 'shipmentRef' | 'currency'>; ratio: number }>()
  for (const row of monthly.values()) {
    const skuKey = skuKeyOf(row.sellerAccountId, row.sku)
    const dims = buildDims(baselines.get(skuKey), products.get(skuKey))
    const ratio = dims?.volumeRatio ?? null
    if (ratio === null || !dims) continue
    const slot = slots.get(skuKey) ?? {
      acc: emptyAccumulator(),
      identity: { sellerAccountId: row.sellerAccountId, subjectKey: row.sku, sku: row.sku, asin: row.asin, shipmentRef: null, currency: row.currency },
      ratio,
    }
    slots.set(skuKey, slot)
    if (slot.identity.currency !== row.currency) continue
    const actual = roundMoney(row.amount)
    const oversized = ratio > 1 + FEE_AUDIT_VOLUME_TOLERANCE
    const expected = oversized ? roundMoney(actual / ratio) : actual
    const month = row.month.toISOString().slice(0, 7)
    addLine(slot.acc, {
      at: row.month,
      ref: month,
      label: `${month} 月度仓储费（亚马逊测量体积 ÷ 我方登记体积 = ${ratio.toFixed(2)}）`,
      quantity: null,
      expected,
      actual,
      overcharge: oversized ? overchargeOf(expected, actual) : 0,
    })
  }
  const subjects: AuditSubject[] = []
  for (const slot of slots.values()) {
    const { acc, identity, ratio } = slot
    if (acc.checked === 0) continue
    const skuKey = skuKeyOf(identity.sellerAccountId, identity.sku ?? '')
    const dims = buildDims(baselines.get(skuKey), products.get(skuKey))
    const money = (value: number) => `${value.toFixed(2)} ${identity.currency}`
    const verdict = acc.occurrences > 0 ? `其中 ${acc.occurrences} 个月实收高于按我方体积折算的应收，累计多收 ${money(roundMoney(acc.overcharge))}` : '没有发现体积造成的多收'
    const notes = [
      '只比较体积，不重新计算费率与利用率附加费；实收是月度仓储费报告里的预估费用，不是已结算金额',
      truncated || baselineCut ? '读取的仓储费或基准行数触到上限，本轮结果可能不完整' : null,
      dimsNote(dims),
    ].filter((note): note is string => note !== null)
    subjects.push(
      subjectOf(identity, acc, { summary: `近 ${FEE_AUDIT_STORAGE_MONTHS} 个收费月核对 ${acc.checked} 个月，亚马逊测量体积是我方登记体积的 ${ratio.toFixed(2)} 倍；${verdict}`, dims, notes }),
    )
  }
  return { kind: 'STORAGE', subjects, truncated: truncated || baselineCut }
}
