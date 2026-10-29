import type { ImportContext, JsonObject } from '../types'
import type { AmazonSpApiClient } from './amazon-sp-api'

const REGION_MARKETS: Record<string, Set<string>> = {
  na: new Set(['ATVPDKIKX0DER', 'A2EUQ1WTGCTBG2', 'A1AM78C64UM0Y8', 'A2Q3Y263D00KWC']),
  eu: new Set(['A1F83G8C2ARO7P', 'A1PA6795UKMFR9', 'A13V1IB3VIYZZH', 'APJ6JRA9NG5V4', 'A1RKKUPIHCS9HS', 'A1805IZSGTT6HS', 'A2NODRKZP88ZB9', 'A1C3SOZRARQ6R3', 'AMEN7PMS3EDWL']),
  fe: new Set(['A1VC38T7YXB528', 'A39IBJ37TRP1C6', 'A19VAU5U5O7RUS']),
}
function endpointRegion() {
  const host = process.env.AMAZON_SP_API_ENDPOINT ?? ''
  if (host.includes('-eu.')) return 'eu'
  if (host.includes('-fe.')) return 'fe'
  return 'na'
}
export async function participatingMarketplaces(ctx: ImportContext, client: AmazonSpApiClient, sellerAccountId: string, fallback: string) {
  const { prisma, logger } = ctx
  const allowed = REGION_MARKETS[endpointRegion()]
  try {
    const response = await client.getMarketplaceParticipations()
    const payload = (response.payload ?? response) as unknown
    const rows = Array.isArray(payload) ? (payload as JsonObject[]) : []
    const ids = rows.flatMap(item => {
      const marketplace = (item.marketplace ?? {}) as JsonObject
      const participation = (item.participation ?? {}) as JsonObject
      const id = String(marketplace.id ?? '')
      if (!id || participation.isParticipating === false || !allowed.has(id)) return []
      return [id]
    })
    if (ids.length) {
      await prisma.sellerAccount.update({ where: { id: sellerAccountId }, data: { marketplaceIds: ids } })
      return ids
    }
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'marketplace participation lookup failed')
  }
  return [fallback]
}
