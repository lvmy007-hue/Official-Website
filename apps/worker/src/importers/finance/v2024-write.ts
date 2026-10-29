import { classifyFeeLine } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { US_MARKETPLACE } from '../../connectors/sp-api-v2'
import type { ImportContext } from '../../types'
import type { ParsedTransaction } from './v2024-parse'

// 财务新版接口落库（importers.md S2）：一笔交易 = 一行交易 + 若干费用明细行 + 可选的结算关联。
// 幂等键：交易 = 店铺 + 交易编号 + 入账时间；费用明细 = 店铺 + 明细编号（交易编号 + 行位置）+ 入账时间。
// 同一笔交易的状态会变化（递延 → 已释放），所以重复拉取时覆盖状态与金额，而不是跳过。

export type FinanceScope = { tenantId: string; sellerAccountId: string }

export async function writeTransaction(ctx: ImportContext, scope: FinanceScope, transaction: ParsedTransaction): Promise<void> {
  const { prisma } = ctx
  const { tenantId, sellerAccountId } = scope
  const postedAt = transaction.postedAt
  const sourceUpdatedAt = postedAt

  // 结算关联：交易带结算编号时关联到结算记录；结算记录可能由结算报告先建，这里不覆盖已有内容。
  const settlement = transaction.settlementId
    ? await prisma.fbaSettlement.upsert({
        where: { sellerAccountId_externalSettlementId: { sellerAccountId, externalSettlementId: transaction.settlementId } },
        create: {
          tenantId,
          sellerAccountId,
          marketplaceId: US_MARKETPLACE,
          externalSettlementId: transaction.settlementId,
          currency: transaction.currency,
          status: 'RECEIVED',
          sourceUpdatedAt,
          sourceRecordId: transaction.settlementId,
        },
        update: {},
      })
    : null

  const fields = {
    settlementId: settlement?.id ?? null,
    amazonOrderId: transaction.amazonOrderId,
    transactionType: transaction.transactionType,
    transactionStatus: transaction.status ?? null,
    // 接口没给预计释放日时是 undefined，Prisma 更新时不改这一列：已写入的释放日不会被后来的空值冲掉
    maturityAt: transaction.maturityAt,
    relatedIdentifiers: transaction.relatedIdentifiers.length > 0 ? (transaction.relatedIdentifiers as unknown as Prisma.InputJsonValue) : undefined,
    amount: transaction.amount,
    currency: transaction.currency,
    description: transaction.description,
    // 状态为空时留下接口原值，便于排查官方新增状态
    raw: { accountType: transaction.accountType, ...(transaction.status ? {} : { statusRaw: transaction.statusRaw ?? null }) } as Prisma.InputJsonValue,
    sourceUpdatedAt,
  }
  await prisma.fbaFinancialTransaction.upsert({
    where: { sellerAccountId_externalTransactionId_postedAt: { sellerAccountId, externalTransactionId: transaction.transactionId, postedAt } },
    create: { tenantId, sellerAccountId, marketplaceId: US_MARKETPLACE, externalTransactionId: transaction.transactionId, postedAt, sourceRecordId: transaction.transactionId, ...fields },
    update: fields,
  })

  for (const line of transaction.lines) {
    // P2b-05：9 类费用分类与子类型（按交易类型 + 明细路径的关键字，见 api-contracts 的 classifyFeeLine）；交易状态随交易刷新。对账状态与备注是人工录入，重复拉取不覆盖。
    const { category, subtype } = classifyFeeLine({ path: line.path, eventType: line.eventType, transactionType: transaction.transactionType })
    const lineFields = {
      amazonOrderId: transaction.amazonOrderId,
      asin: line.asin,
      sellerSku: line.sellerSku,
      eventType: line.eventType,
      amount: line.amount,
      currency: line.currency,
      description: line.path,
      settlementId: transaction.settlementId,
      feeCategory: category,
      feeSubtype: subtype,
      transactionStatus: transaction.status ?? null,
      sourceUpdatedAt,
    }
    await prisma.fbaFeeEvent.upsert({
      where: { sellerAccountId_sourceEventId_postedAt: { sellerAccountId, sourceEventId: line.sourceEventId, postedAt } },
      create: { tenantId, sellerAccountId, marketplaceId: US_MARKETPLACE, sourceEventId: line.sourceEventId, postedAt, sourceRecordId: transaction.transactionId, ...lineFields },
      update: lineFields,
    })
  }
}
