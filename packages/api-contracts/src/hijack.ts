import type { CursorPageInfo } from './query.js'
import { PRICING_LIMITS } from './pricing.js'

// 跟卖监控（P6-17，16 章第 3.2、9、10 节）：我方 Listing（店铺 × SKU）上出现的其他报价方。常量、类型与口径文字；请求校验在 hijack-query.ts。
// 数据只来自官方竞争摘要（Product Pricing API 的竞争摘要，定价同步器每 2 小时读一次），不抓前台页面，所以一定有延迟，页面要写明。
// 竞争摘要只给价格最低的几个报价（我们只保留最低的 30 个），所以“消失”有两种可能：对方真的下架了，或者价格被抬高排到了 30 名之外；页面不区分，如实写“摘要里已经没有”。
// 卖家编号只存哈希（与竞争报价表同一算法：sha256 取前 16 位十六进制），不存别家卖家编号原文；白名单录入时同样只存哈希与前后各两位的提示。

export const HIJACK_READ = 'tools.read'
export const HIJACK_MANAGE = 'tools.manage'
export const HIJACK_ACTIONS = { whitelistAdded: 'HIJACK_WHITELIST_ADDED', whitelistRemoved: 'HIJACK_WHITELIST_REMOVED' } as const
export const HIJACK_LIMITS = { whitelistMax: 200, noteMax: 200, sellerIdMin: 8, sellerIdMax: 20, pageSizeMax: 200 } as const

/** 亚马逊卖家编号：大写字母与数字，通常 13 到 14 位（A 开头）；这里放宽到 8 到 20 位，只挡明显写错的。 */
export const HIJACK_SELLER_ID_PATTERN = /^[A-Z0-9]{8,20}$/

export const HIJACK_STATUSES = ['active', 'gone', 'all'] as const
export type HijackStatus = (typeof HIJACK_STATUSES)[number]
export const HIJACK_STATUS_LABEL: Readonly<Record<HijackStatus, string>> = { active: '仍在报价', gone: '已消失', all: '全部' }

/** 白名单筛选：默认不显示白名单里的卖家（自己的其他店铺不算跟卖）。 */
export const HIJACK_WHITELIST_MODES = ['exclude', 'only', 'all'] as const
export type HijackWhitelistMode = (typeof HIJACK_WHITELIST_MODES)[number]
export const HIJACK_WHITELIST_MODE_LABEL: Readonly<Record<HijackWhitelistMode, string>> = { exclude: '不含白名单', only: '只看白名单', all: '全部' }

export const HIJACK_DELAY_NOTE_PREFIX = '数据来自官方竞争摘要，不抓前台页面'

/** 录入时留下的提示：前两位与后两位，中间省略；太短的只留首尾各一位。 */
export function sellerHintOf(sellerId: string): string {
  const id = sellerId.trim().toUpperCase()
  return id.length > 6 ? `${id.slice(0, 2)}…${id.slice(-2)}` : `${id.slice(0, 1)}…${id.slice(-1)}`
}
/** 列表里显示对方卖家：哈希只给前 6 位，让人能区分不同的卖家，又不暴露原文。 */
export const sellerRefOf = (sellerKey: string): string => `卖家 ${sellerKey.slice(0, 6)}`

/**
 * 竞争摘要的最长延迟（小时）：同步每 2 小时一次；ASIN 数超过一次同步的容量（每批 20 个 × 最多 30 批）时按时间槽轮转，
 * 一个 ASIN 最长要等 ceil(ASIN 数 ÷ 容量) 个同步周期才轮到。至少 2 小时。
 */
export function hijackMaxDelayHours(asinCount: number): number {
  const capacity = PRICING_LIMITS.summaryBatch * PRICING_LIMITS.syncBatchesMax
  const slots = Math.max(1, Math.ceil(Math.max(0, asinCount) / capacity))
  return slots * (PRICING_LIMITS.syncSlotMs / 3_600_000)
}
export const hijackDelayNote = (hours: number): string =>
  `${HIJACK_DELAY_NOTE_PREFIX}，最长延迟 ${hours} 小时（同步每 2 小时一次，商品很多时按轮转，每个 ASIN 隔几次才读一遍）；排在价格最低的 30 个报价之外的卖家看不到。`

export interface HijackRow {
  id: string
  storeId: string
  storeName: string
  sku: string
  asin: string
  title: string | null
  /** 对方卖家的哈希（前 6 位已够区分），不是卖家编号原文。 */
  sellerKey: string
  sellerRef: string
  whitelisted: boolean
  firstSeenAt: string
  lastSeenAt: string
  goneAt: string | null
  status: 'active' | 'gone'
  price: number
  currency: string
  isFba: boolean
  hasBuybox: boolean
}

export interface HijackSummary {
  active: number
  gone: number
  whitelisted: number
  /** 仍在报价且不在白名单里的（预警按它算）。 */
  activeNotWhitelisted: number
}

export interface HijackListResponse {
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'
  note: string | null
  items: HijackRow[]
  pageInfo: CursorPageInfo
  summary: HijackSummary
  maxDelayHours: number
  delayNote: string
  /** 当前账号能不能改白名单（tools.manage）。 */
  canManage: boolean
  manageBlockedReason: string | null
}

export interface HijackWhitelistRow {
  id: string
  sellerKey: string
  sellerRef: string
  sellerHint: string
  note: string | null
  createdBy: string
  createdAt: string
  /** 现在还有多少个 SKU 上能看到这个卖家（仍在报价的）。 */
  activeSkus: number
}

export interface HijackWhitelistResponse {
  items: HijackWhitelistRow[]
  page: number
  pageSize: number
  total: number
  limit: number
  canManage: boolean
  manageBlockedReason: string | null
}

export const HIJACK_BLOCKED_NO_PERMISSION = '你没有管理跟卖白名单的权限（需要“管理跟卖白名单”）'
