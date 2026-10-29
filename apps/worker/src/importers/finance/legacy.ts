import type { AmazonSpApiClient } from '../../connectors/amazon-sp-api'
import type { FinanceEntry } from '../../parity/compare-finance'
import type { JsonObject } from '../../types'
import { validDate } from '../shared'
import { collectFeeLines } from './fee-lines'

// 旧财务接口（v0 财务事件）只读取数：仅用于新旧并行核对，不写库。升级后财务数据全部来自新接口（v2024-06-19）。

export async function fetchLegacyFinance(client: Pick<AmazonSpApiClient, 'getFinancialEvents'>, window: { after: string; before: string }): Promise<FinanceEntry[]> {
  const entries: FinanceEntry[] = []
  let nextToken: string | undefined
  do {
    const response = await client.getFinancialEvents(nextToken, { postedAfter: window.after, postedBefore: window.before })
    const root = (response.payload ?? response) as JsonObject
    const eventsRoot = (root.FinancialEvents ?? root) as JsonObject
    for (const line of collectFeeLines(eventsRoot)) {
      const postedAt = validDate(line.postedAt)
      if (postedAt) entries.push({ amazonOrderId: line.amazonOrderId, amount: line.amount, currency: line.currency, postedAt })
    }
    const token = root.NextToken ?? response.NextToken
    nextToken = typeof token === 'string' && token.length > 0 ? token : undefined
  } while (nextToken)
  return entries
}
