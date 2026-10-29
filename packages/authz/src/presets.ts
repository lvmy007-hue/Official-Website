import { PERMISSION_CATALOG, ROLE_KEYS, type RoleKey } from './catalog'
import type { FieldKey } from './index'

// 预设角色单独成文件：只有成员与角色相关的页面用得到，不放进 index.ts，前端首屏就不会把 150 多条权限清单带进去（首屏预算）。

// 预设角色（7 个，不可修改、不可删除，可复制后修改）
export interface PresetRole {
  key: RoleKey
  id: string
  name: string
  description: string
  permissions: string[]
  fields: FieldKey[]
}

const PRESET_META: Record<RoleKey, { name: string; description: string; fields: FieldKey[] }> = {
  owner: { name: '所有者', description: '企业创建者：全部权限与全部字段权限；唯一能改所有者归属', fields: ['cost', 'profit', 'buyer'] },
  admin: { name: '管理员', description: '企业管理：与所有者相同，但不能转让所有权、不能删除企业', fields: ['cost', 'profit', 'buyer'] },
  ops: { name: '运营', description: '商品、定价、刊登、评价、分析；不可见采购成本，可见利润', fields: ['profit'] },
  ads: { name: '广告', description: '广告投放：广告全部写权限（均受写入开关）；可见利润，不可见采购成本', fields: ['profit'] },
  finance: { name: '财务', description: '对账、利润、关账、赔付、成本；可审批采购单与盘点差异；不可重新开账', fields: ['cost', 'profit'] },
  supply: { name: '供应链', description: '补货、采购、头程、入仓、国内仓、成本录入；不可审批自己的采购单，不可付款', fields: ['cost'] },
  readonly: { name: '只读', description: '只有查看权限，无导出、无字段级敏感权限、无任何写权限', fields: [] },
}

export const PRESET_ROLES: readonly PresetRole[] = /* @__PURE__ */ ROLE_KEYS.map(key => ({
  key,
  id: `preset-${key}`,
  ...PRESET_META[key],
  permissions: key === 'owner' ? ['*'] : PERMISSION_CATALOG.filter(entry => entry.roles.includes(key)).map(entry => entry.key),
}))
