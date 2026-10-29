import type { AdsWriteKind } from '@nova/api-contracts'
import type { JsonObject } from '../types'

// 广告统一接口（v1）的写入请求体（P3-17）。所有写入的路径与请求体形状都集中在这个文件，第一次接真实广告账户时只需要核对这里。
//
// 【未对真实账户验证】路径取统一接口的约定形式 POST /adsApi/v1/{create|update}/{resource}，请求体是 { <resource>: [ {...} ] }；
// 预算、竞价、广告位调整、关键词与否定投放的字段嵌套是按统一接口文档的惯例写的，没有对照真实响应；响应里有逐条成败（success / error 数组）时按逐条判断。
// 这些假设已在 CR-072 披露；在核对之前，生产环境的写入开关保持关闭即可，没有开关打开就不会向亚马逊发出任何写入请求。

export type AdsWriteResource = 'campaigns' | 'adGroups' | 'targets'
export type AdsWriteOperation = 'create' | 'update'

/** 构造请求需要的输入：外部编号取自写入记录，取值取自记录里的 requestJson。 */
export interface AdsWriteInput {
  kind: AdsWriteKind
  /** 修改对象的亚马逊编号；新增类是父对象（活动或广告组）的亚马逊编号。 */
  externalId: string
  /** 新增类需要的所属活动编号（关键词挂广告组时用）。 */
  campaignExternalId: string | null
  state?: string
  amount?: number
  strategy?: string
  placement?: string
  text?: string
  matchType?: string
  level?: string
}

export interface AdsWriteCall {
  operation: AdsWriteOperation
  resource: AdsWriteResource
  item: JsonObject
}

const money = (value: number | undefined): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('ADS_WRITE_AMOUNT_MISSING')
  return value
}
const need = (value: string | undefined, name: string): string => {
  if (!value) throw new Error(`ADS_WRITE_${name}_MISSING`)
  return value
}

export function buildAdsWriteCall(input: AdsWriteInput): AdsWriteCall {
  const id = input.externalId
  switch (input.kind) {
    case 'CAMPAIGN_STATE':
      return { operation: 'update', resource: 'campaigns', item: { campaignId: id, state: need(input.state, 'STATE') } }
    case 'CAMPAIGN_BUDGET':
      return {
        operation: 'update',
        resource: 'campaigns',
        item: { campaignId: id, budgets: [{ budgetType: 'MONETARY', recurrenceTimePeriod: 'DAILY', budgetValue: { monetaryBudgetValue: { monetaryBudget: { value: money(input.amount) } } } }] },
      }
    case 'CAMPAIGN_BID_STRATEGY':
      return { operation: 'update', resource: 'campaigns', item: { campaignId: id, optimizations: { bidSettings: { bidStrategy: need(input.strategy, 'STRATEGY') } } } }
    case 'CAMPAIGN_PLACEMENT':
      return {
        operation: 'update',
        resource: 'campaigns',
        item: { campaignId: id, optimizations: { bidSettings: { placementBidAdjustments: [{ placement: need(input.placement, 'PLACEMENT'), percentage: money(input.amount) }] } } },
      }
    case 'AD_GROUP_STATE':
      return { operation: 'update', resource: 'adGroups', item: { adGroupId: id, state: need(input.state, 'STATE') } }
    case 'AD_GROUP_BID':
      return { operation: 'update', resource: 'adGroups', item: { adGroupId: id, bid: { defaultBid: money(input.amount) } } }
    case 'TARGET_STATE':
      return { operation: 'update', resource: 'targets', item: { targetId: id, state: need(input.state, 'STATE') } }
    case 'TARGET_BID':
      return { operation: 'update', resource: 'targets', item: { targetId: id, bid: { bid: money(input.amount) } } }
    case 'NEGATIVE_ADD': {
      const keywordTarget = { keywordTarget: { keyword: need(input.text, 'TEXT'), matchType: need(input.matchType, 'MATCH_TYPE') } }
      const parent = input.level === 'CAMPAIGN' ? { campaignId: id } : { adGroupId: id, ...(input.campaignExternalId ? { campaignId: input.campaignExternalId } : {}) }
      return { operation: 'create', resource: 'targets', item: { ...parent, negative: true, targetType: 'KEYWORD', targetDetails: keywordTarget } }
    }
    case 'KEYWORD_ADD': {
      const keywordTarget = { keywordTarget: { keyword: need(input.text, 'TEXT'), matchType: need(input.matchType, 'MATCH_TYPE') } }
      return {
        operation: 'create',
        resource: 'targets',
        item: {
          adGroupId: id,
          ...(input.campaignExternalId ? { campaignId: input.campaignExternalId } : {}),
          negative: false,
          targetType: 'KEYWORD',
          state: 'ENABLED',
          targetDetails: keywordTarget,
          ...(input.amount === undefined ? {} : { bid: { bid: input.amount } }),
        },
      }
    }
    default:
      throw new Error('ADS_WRITE_KIND_UNKNOWN')
  }
}

const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter((item): item is JsonObject => item !== null && typeof item === 'object' && !Array.isArray(item)) : [])

/**
 * 响应里有逐条成败时（success / error 数组，或 resource 名下带 error 的条目）判断这次写入有没有被亚马逊拒绝。
 * 只返回短码，不带亚马逊返回的原文（可能含对象内容）。没有逐条成败信息的响应按成功处理（HTTP 状态已经通过）。
 */
export function adsWriteRejection(response: JsonObject): string | null {
  const errors = records(response.error ?? response.errors)
  if (errors.length > 0) return 'ADS_WRITE_REJECTED'
  for (const key of ['campaigns', 'adGroups', 'targets', 'items']) {
    const list = response[key]
    if (!Array.isArray(list)) continue
    const failed = records(list).some(entry => entry.error !== undefined || entry.errors !== undefined || (typeof entry.status === 'string' && /fail|error|reject/i.test(entry.status)))
    if (failed) return 'ADS_WRITE_REJECTED'
  }
  return null
}

/** 新增类写入返回的新对象编号（取不到返回 null，不影响成功判断）。 */
export function createdIdOf(response: JsonObject): string | null {
  for (const key of ['targets', 'items', 'success']) {
    for (const entry of records(response[key])) {
      const direct = entry.targetId ?? entry.id
      if (typeof direct === 'string' && direct) return direct
      const nested = entry.target && typeof entry.target === 'object' ? (entry.target as JsonObject).targetId : undefined
      if (typeof nested === 'string' && nested) return nested
    }
  }
  return null
}
