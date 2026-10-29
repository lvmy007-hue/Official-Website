// 变体结构变更事件（P4-03，父体详情“变体结构变更历史”页签的数据来源）：纯函数，不访问数据库。
// 目录同步（I-09）每天比较商品上一次与这一次的父体与变体属性，变了就记事件：
//   - 子体的父体变了：对旧父体记“移除子体”、对新父体记“新增子体”（对象类型 PARENT_ASIN，对象编号是父体 ASIN）；
//   - 子体的变体属性取值变了：记在这个商品上（对象类型 ASIN，对象编号是商品编号，详情里带父体 ASIN）。
// 首次填入不算变更：商品从没同步过目录（catalogSyncedAt 为空）时不记；属性只比较前后都有值的维度。

export interface VariationEvent {
  entityType: 'PARENT_ASIN' | 'ASIN'
  entityId: string
  kind: 'variation.child_added' | 'variation.child_removed' | 'variation.attribute_change'
  title: string
  detailJson: Record<string, string | null>
  sourceRef: string
}

export function parentChangeEvents(input: { childAsin: string; before: string | null; after: string | null; previouslySynced: boolean; day: string }): VariationEvent[] {
  const { childAsin, before, after, previouslySynced, day } = input
  if (!previouslySynced || before === after) return []
  const events: VariationEvent[] = []
  if (before) {
    events.push({
      entityType: 'PARENT_ASIN',
      entityId: before,
      kind: 'variation.child_removed',
      title: `子体 ${childAsin} 已从这个父体移除`,
      detailJson: { childAsin, before, after },
      sourceRef: `catalog:child_removed:${childAsin}:${day}`,
    })
  }
  if (after) {
    events.push({
      entityType: 'PARENT_ASIN',
      entityId: after,
      kind: 'variation.child_added',
      title: `新增子体 ${childAsin}`,
      detailJson: { childAsin, before, after },
      sourceRef: `catalog:child_added:${childAsin}:${day}`,
    })
  }
  return events
}

const objectOf = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => (typeof item === 'string' ? [[key, item]] : [])))
}

export function attributeChangeEvents(input: {
  productId: string
  childAsin: string
  parentAsin: string | null
  before: unknown
  after: Record<string, string>
  previouslySynced: boolean
  day: string
}): VariationEvent[] {
  if (!input.previouslySynced || !input.parentAsin) return []
  const before = objectOf(input.before)
  return Object.keys(input.after)
    .sort()
    .flatMap<VariationEvent>(name => {
      const was = before[name]
      const now = input.after[name]!
      if (!was || was === now) return []
      return [
        {
          entityType: 'ASIN',
          entityId: input.productId,
          kind: 'variation.attribute_change',
          title: `变体属性 ${name} 由「${was}」变为「${now}」`,
          detailJson: { field: name, before: was, after: now, childAsin: input.childAsin, parentAsin: input.parentAsin },
          sourceRef: `catalog:attr:${name}:${input.day}`,
        },
      ]
    })
}
