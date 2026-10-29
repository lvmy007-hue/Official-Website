import { AppError } from '../../platform/http'

// 数据范围的解析结果与查询条件构造（纯函数，无外部依赖，便于单测）。

export type ResolvedScope = {
  /** 为真表示成员拥有租户内全部店铺且请求未收窄，查询只需租户条件，无需店铺条件。 */
  unrestricted: boolean
  /** 解析后允许访问的店铺编号；unrestricted 为真时为空数组。 */
  sellerAccountIds: string[]
  /** 固定为亚马逊美国站，可选。 */
  marketplaceId?: string
}

/** 店铺条件：直接带 sellerAccountId 的业务表使用。 */
export function storeWhere(scope: ResolvedScope, field = 'sellerAccountId') {
  return scope.unrestricted ? {} : { [field]: { in: scope.sellerAccountIds } }
}

/**
 * 广告账户条件：广告表通过 adsProfile 关联到店铺。
 * 未绑定店铺的广告账户只有“全部范围且未收窄”的成员可见，避免越权看到未归属的数据。
 */
export function adsProfileWhere(scope: ResolvedScope) {
  return scope.unrestricted ? {} : { sellerAccountId: { in: scope.sellerAccountIds } }
}

/** 写操作针对某个具体店铺时，要求该店铺在成员的数据范围内，否则 403。 */
export function assertStoreInScope(scope: ResolvedScope, sellerAccountId: string) {
  if (scope.unrestricted || scope.sellerAccountIds.includes(sellerAccountId)) return
  throw new AppError(403, 'SCOPE_STORE_FORBIDDEN', '当前账号没有该店铺的数据访问范围')
}

/**
 * 平台连接条件：卖家连接按店铺归属，广告连接按其广告账户绑定的店铺归属。
 * 受限成员看不到未归属任何店铺的连接。
 */
export function connectionWhere(scope: ResolvedScope) {
  return scope.unrestricted
    ? {}
    : {
        OR: [{ sellerAccountId: { in: scope.sellerAccountIds } }, { adsProfile: { sellerAccountId: { in: scope.sellerAccountIds } } }],
      }
}

/** 租户级资源（未归属到店铺的连接、广告账户同步等）只允许拥有全部范围的成员操作。 */
export function assertUnrestricted(scope: ResolvedScope) {
  if (scope.unrestricted) return
  throw new AppError(403, 'SCOPE_TENANT_LEVEL_ONLY', '该操作影响企业全部店铺，需要“全部店铺”数据范围')
}

/** 广告表（campaign / report / metric / term）的范围条件。 */
export function adsRelationWhere(scope: ResolvedScope) {
  return scope.unrestricted ? {} : { adsProfile: adsProfileWhere(scope) }
}
