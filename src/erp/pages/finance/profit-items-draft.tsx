import { Form, Select } from 'antd'
import { NEW_ID_PREFIX, PROFIT_ITEM_GROUP_LABEL, type ProfitItemGroup, type ProfitItemRow, type ProfitMappingRow } from '@nova/api-contracts'

// 利润项目字典页的暂存草稿（P6-18）：改动先留在页面里，保存时整树一次提交。这里是草稿的纯函数与映射目标选择器。

const SIGN_OF: Record<ProfitItemGroup, 1 | -1> = { REVENUE: 1, PLATFORM_FEE: -1, LOGISTICS_FEE: -1, ADS: -1, PRODUCT_COST: -1, OTHER: 1 }

export interface Draft {
  items: ProfitItemRow[]
  mappings: ProfitMappingRow[]
}

/** 按树的顺序摊平（同级按 sort），用于表格展示。 */
export function flattenItems(items: readonly ProfitItemRow[]): ProfitItemRow[] {
  const children = new Map<string | null, ProfitItemRow[]>()
  for (const item of items) children.set(item.parentId, [...(children.get(item.parentId) ?? []), item])
  const out: ProfitItemRow[] = []
  const walk = (parent: string | null) => {
    for (const item of [...(children.get(parent) ?? [])].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'zh-Hans-CN'))) {
      out.push(item)
      walk(item.id)
    }
  }
  walk(null)
  return out
}

/** 项目自己和它所有的子孙项目编号。 */
export function descendantsOf(items: readonly ProfitItemRow[], id: string): Set<string> {
  const found = new Set<string>([id])
  for (let changed = true; changed;) {
    changed = false
    for (const item of items) {
      if (item.parentId !== null && found.has(item.parentId) && !found.has(item.id)) {
        found.add(item.id)
        changed = true
      }
    }
  }
  return found
}

let seq = 0

/** 新建自定义项目：临时编号以 `new:` 开头，分组跟随所在的一级项目；是否接收交易跟随父项目。 */
export function newItemRow(items: readonly ProfitItemRow[], parent: ProfitItemRow | null, name: string, group: ProfitItemGroup | null): ProfitItemRow {
  const siblings = items.filter(item => item.parentId === (parent?.id ?? null))
  const resolvedGroup = parent?.group ?? group ?? 'OTHER'
  seq += 1
  return {
    id: `${NEW_ID_PREFIX}${seq}`,
    parentId: parent?.id ?? null,
    level: (parent?.level ?? 0) + 1,
    name,
    group: resolvedGroup,
    groupLabel: PROFIT_ITEM_GROUP_LABEL[resolvedGroup],
    sign: parent?.sign ?? SIGN_OF[resolvedGroup],
    isSystem: false,
    systemKey: null,
    sort: siblings.reduce((max, item) => Math.max(max, item.sort), 0) + 10,
    txCount30d: 0,
    mappedTypes: 0,
    acceptsMapping: parent !== null && parent.acceptsMapping,
  }
}

export function ItemPicker({ items, name }: { items: readonly ProfitItemRow[]; name: string }) {
  const options = items.filter(item => item.acceptsMapping).map(item => ({ value: item.id, label: `${'　'.repeat(item.level - 1)}${item.name}` }))
  return (
    <Form.Item name={name} label="归到哪个项目" rules={[{ required: true, message: '请选择项目' }]}>
      <Select showSearch optionFilterProp="label" options={options} placeholder="选择接收交易明细的项目" />
    </Form.Item>
  )
}
