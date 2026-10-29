// 发货地址契约（P6-08，16 章第 4 节；freeze/api.md `/ship-from-addresses*`）。
// 本文件只放常量、标签、纯函数与响应类型，没有 zod（前端首屏路径可以安全引用）；请求体与列表查询的校验在 ship-from-query.ts。

export const SHIP_FROM_READ = 'inbound.read'
export const SHIP_FROM_MANAGE = 'shipfrom.manage'
/** 发货地址页的站内路径（补货转入仓计划缺地址时给“去设置”入口）。 */
export const SHIP_FROM_PATH = '/app/settings/ship-from'

export const SHIP_FROM_STATUSES = ['ACTIVE', 'INACTIVE'] as const
export type ShipFromStatus = (typeof SHIP_FROM_STATUSES)[number]
export const SHIP_FROM_STATUS_LABEL: Record<ShipFromStatus, string> = { ACTIVE: '使用中', INACTIVE: '已停用' }

/** 每个店铺最多保存的发货地址数（防止无限增长；真实使用远低于此）。 */
export const SHIP_FROM_LIMIT_PER_STORE = 50

export const SHIP_FROM_ACTIONS = {
  created: 'SHIP_FROM_ADDRESS_CREATED',
  updated: 'SHIP_FROM_ADDRESS_UPDATED',
  defaulted: 'SHIP_FROM_ADDRESS_DEFAULTED',
  deleted: 'SHIP_FROM_ADDRESS_DELETED',
} as const

export const SHIP_FROM_BLOCKED_NO_PERMISSION = '没有“发货地址维护”权限（企业所有者、管理员与供应链有）'

/** 入仓接口要求的地址字段（与 InboundSourceAddress 一一对应：stateOrProvince ↔ stateOrProvinceCode，phone ↔ phoneNumber）。 */
export interface ShipFromFields {
  name: string
  addressLine1: string
  addressLine2: string | null
  city: string
  stateOrProvince: string
  postalCode: string
  countryCode: string
  phone: string
}

export interface ShipFromRow extends ShipFromFields {
  id: string
  sellerAccountId: string
  storeName: string
  isDefault: boolean
  status: ShipFromStatus
  /** 乐观锁版本号：修改时原样带回。 */
  version: number
  /** 被多少个入仓计划用过：大于 0 时不能删除，只能停用。 */
  usedByPlans: number
  createdAt: string
  updatedAt: string
}

export interface ShipFromListResponse {
  items: ShipFromRow[]
  page: number
  pageSize: number
  total: number
  /** 当前数据范围内全部地址的统计（不受筛选与分页影响）。 */
  summary: { total: number; active: number; inactive: number }
  canManage: boolean
  manageBlockedReason: string | null
}

/** 一行文字：`地址行 1 地址行 2，城市，州 邮编，国家`。 */
export function shipFromSummary(fields: Pick<ShipFromFields, 'addressLine1' | 'addressLine2' | 'city' | 'stateOrProvince' | 'postalCode' | 'countryCode'>): string {
  const line = [fields.addressLine1, fields.addressLine2].filter(Boolean).join(' ')
  return `${line}，${fields.city}，${fields.stateOrProvince} ${fields.postalCode}，${fields.countryCode}`
}

/** 转成入仓计划里存的发货方地址（`FbaInboundPlan.sourceAddress` 的内容，字段名与入仓接口一致）。 */
export function toInboundSourceAddress(fields: ShipFromFields) {
  return {
    name: fields.name,
    addressLine1: fields.addressLine1,
    ...(fields.addressLine2 ? { addressLine2: fields.addressLine2 } : {}),
    city: fields.city,
    stateOrProvinceCode: fields.stateOrProvince,
    countryCode: fields.countryCode,
    postalCode: fields.postalCode,
    phoneNumber: fields.phone,
  }
}
