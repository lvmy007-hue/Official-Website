import { ResolvedScope, storeWhere } from '../auth'

export function movementsWhere(tenantId: string, scope: ResolvedScope, query: Record<string, string>) {
  return {
    tenantId,
    ...storeWhere(scope),
    ...(query.sellerSku ? { sellerSku: query.sellerSku } : {}),
    ...(query.type ? { movementType: query.type } : {}),
  }
}
