import { ENTITY_WRITE, ENTITY_WRITE_BLOCKED_NOT_UNRESTRICTED, ENTITY_WRITE_BLOCKED_NO_PERMISSION, type LegalEntityRow } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import type { LegalEntity } from '@prisma/client'
import type { ResolvedScope } from '../auth'

// 法律主体模块的共用小件：行转换、审计快照、数据范围条件、写入前置条件。

/** 当前账号数据范围内的主体：受限成员只看到名下有范围内店铺的主体；全部范围看到全部（含还没有店铺的新主体）。 */
export const entityScopeWhere = (scope: ResolvedScope) => (scope.unrestricted ? {} : { sellerAccounts: { some: { id: { in: scope.sellerAccountIds } } } })

export const entityRowOf = (entity: LegalEntity, storeCount: number, adsAccountCount: number): LegalEntityRow => ({
  id: entity.id,
  name: entity.name,
  registeredCountry: entity.registeredCountry,
  registrationNo: entity.registrationNo,
  status: entity.status,
  version: entity.version,
  storeCount,
  adsAccountCount,
  createdAt: entity.createdAt.toISOString(),
})

/** 审计快照：四个业务字段，修改前后同形，详情页的“变更记录”据此算出变化。 */
export const entitySnapshot = (entity: Pick<LegalEntity, 'name' | 'registeredCountry' | 'registrationNo' | 'status'>) => ({
  name: entity.name,
  registeredCountry: entity.registeredCountry,
  registrationNo: entity.registrationNo,
  status: entity.status,
})

/** 能不能写、不能写的原因（页面把按钮置灰并给出原因）。写入必须有权限，且改主体会影响全部店铺，要“全部店铺”范围。 */
export function entityWriteBlock(permissions: readonly string[], scope: ResolvedScope): string | null {
  if (!hasPermission(permissions, ENTITY_WRITE)) return ENTITY_WRITE_BLOCKED_NO_PERMISSION
  return scope.unrestricted ? null : ENTITY_WRITE_BLOCKED_NOT_UNRESTRICTED
}
