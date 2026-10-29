// 广告账户与店铺的自动匹配（P1-12，依据 06 章 6.3、07 章）。
// 规则：广告账户里的卖家编号与店铺的卖家编号一致，且同一企业内只有唯一一个候选店铺时才自动绑定；
// 人工绑定（MANUAL）的结果永不被自动匹配覆盖；候选为零或多个时不猜测，保持未绑定，等待人工指定。

type JsonObject = Record<string, unknown>

/** 从广告接口返回的账户信息里取卖家编号：优先顶层 accountId，其次卖家类型账户的 accountInfo.id。 */
export function pickAdsAccountId(item: JsonObject): string | undefined {
  if (typeof item.accountId === 'string' && item.accountId) return item.accountId
  const info = (item.accountInfo ?? {}) as JsonObject
  if (info.type === 'seller' && typeof info.id === 'string' && info.id) return info.id
  return undefined
}

/** 候选店铺恰好一个时返回其编号，否则返回 null。 */
export function uniqueCandidate(candidates: readonly { id: string }[]): string | null {
  return candidates.length === 1 ? candidates[0].id : null
}

type BindingDb = {
  sellerAccount: { findMany(args: { where: { tenantId: string; sellerId: string }; select: { id: true } }): Promise<{ id: string }[]> }
  adsProfile: { update(args: { where: { id: string }; data: { sellerAccountId: string | null; bindingStatus: string } }): Promise<unknown> }
}

export type AdsBindingResult = 'MANUAL_KEPT' | 'AUTO_MATCHED' | 'UNBOUND'

export async function autoBindAdsProfile(
  db: BindingDb,
  profile: { id: string; tenantId: string; accountId: string | null; bindingStatus: string; sellerAccountId: string | null },
): Promise<AdsBindingResult> {
  if (profile.bindingStatus === 'MANUAL') return 'MANUAL_KEPT'
  const candidates = profile.accountId ? await db.sellerAccount.findMany({ where: { tenantId: profile.tenantId, sellerId: profile.accountId }, select: { id: true } }) : []
  const matched = uniqueCandidate(candidates)
  const next = matched ? 'AUTO_MATCHED' : 'UNBOUND'
  if (matched !== profile.sellerAccountId || next !== profile.bindingStatus) {
    await db.adsProfile.update({ where: { id: profile.id }, data: { sellerAccountId: matched, bindingStatus: next } })
  }
  return next
}
