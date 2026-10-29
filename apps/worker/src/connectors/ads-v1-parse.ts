import type { JsonObject } from '../types'
import type { AdsV1Resource } from './ads-v1-api'

// 广告统一接口响应的解析（纯函数，不碰网络与数据库）。字段名是按统一接口的命名约定写的，**没有对照真实响应**：
// 找不到编号的条目一律跳过并计数，不猜编号。第一次接真实账户时对着真实响应核对 ENTITY_ID_FIELDS 与 PARENT_FIELDS。

export type AdsEntityType = 'CAMPAIGN' | 'AD_GROUP' | 'AD' | 'TARGET' | 'AD_ASSOCIATION' | 'AD_EXTENSION' | 'BRAND_STORE'

export const ENTITY_TYPE_OF: Record<AdsV1Resource, AdsEntityType> = {
  campaigns: 'CAMPAIGN',
  adGroups: 'AD_GROUP',
  ads: 'AD',
  targets: 'TARGET',
  adAssociations: 'AD_ASSOCIATION',
  adExtensions: 'AD_EXTENSION',
  brandStores: 'BRAND_STORE',
}

const ENTITY_ID_FIELDS: Record<AdsV1Resource, string[]> = {
  campaigns: ['campaignId', 'id'],
  adGroups: ['adGroupId', 'id'],
  ads: ['adId', 'id'],
  targets: ['targetId', 'id'],
  adAssociations: ['adAssociationId', 'id'],
  adExtensions: ['adExtensionId', 'id'],
  brandStores: ['brandStoreId', 'storeId', 'id'],
}

/** 上级编号字段：广告组属于活动，广告与投放对象属于广告组，广告关联与扩展挂在广告上；活动与品牌旗舰店没有上级。 */
const PARENT_FIELDS: Record<AdsV1Resource, string[]> = {
  campaigns: [],
  adGroups: ['campaignId'],
  ads: ['adGroupId'],
  targets: ['adGroupId'],
  adAssociations: ['adId'],
  adExtensions: ['adId', 'adGroupId'],
  brandStores: [],
}

export type AdsEntityRecord = {
  entityType: AdsEntityType
  entityId: string
  parentId?: string
  name?: string
  state?: string
  raw: JsonObject
}

const text = (value: unknown) => {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}
const firstText = (item: JsonObject, fields: string[]) => {
  for (const field of fields) {
    const found = text(item[field])
    if (found) return found
  }
  return undefined
}
const record = (value: unknown): JsonObject | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null)

/** 统一接口的条目 → 通用实体记录；没有编号返回 null（调用方计入跳过）。 */
export function parseEntity(resource: AdsV1Resource, item: JsonObject): AdsEntityRecord | null {
  const entityId = firstText(item, ENTITY_ID_FIELDS[resource])
  if (!entityId) return null
  return {
    entityType: ENTITY_TYPE_OF[resource],
    entityId,
    parentId: firstText(item, PARENT_FIELDS[resource]),
    name: firstText(item, ['name', 'title']),
    state: firstText(item, ['state', 'status']),
    raw: item,
  }
}

export type AdsRecommendationRecord = {
  recommendationId: string
  type: string
  entityType: string
  entityId: string
  payload: JsonObject
}

/**
 * 官方推荐：编号与类型必填；关联对象优先取 entity { type, id }，其次 campaignId、adGroupId 这类顶层编号，
 * 都没有的推荐是账户级的，对象类型记 ACCOUNT、对象编号记空串（保持唯一键与列非空）。
 */
export function parseRecommendation(item: JsonObject): AdsRecommendationRecord | null {
  const recommendationId = firstText(item, ['recommendationId', 'id'])
  const type = firstText(item, ['type', 'recommendationType'])
  if (!recommendationId || !type) return null
  const entity = record(item.entity) ?? record(item.target)
  const entityType = firstText(entity ?? {}, ['type', 'entityType'])
  const entityId = firstText(entity ?? {}, ['id', 'entityId'])
  if (entityType && entityId) return { recommendationId, type, entityType: entityType.toUpperCase(), entityId, payload: item }
  for (const [field, kind] of [
    ['adGroupId', 'AD_GROUP'],
    ['campaignId', 'CAMPAIGN'],
  ] as const) {
    const id = text(item[field])
    if (id) return { recommendationId, type, entityType: kind, entityId: id, payload: item }
  }
  return { recommendationId, type, entityType: 'ACCOUNT', entityId: '', payload: item }
}

/** 预测响应原样保存（区间字段随亚马逊版本变化），只检查它是个非空对象。 */
export function parseForecast(body: JsonObject): JsonObject | null {
  return Object.keys(body).length > 0 ? body : null
}
