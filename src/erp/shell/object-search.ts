// 命令面板的对象跳转（P1-04）：各业务模块上线时登记自己的对象搜索（订单、ASIN、SKU、采购单……）。
// 面板只负责展示与跳转；搜索必须走服务端并受数据范围约束，不在前端遍历数据。

export type ObjectHit = { id: string; title: string; subtitle?: string; to: string }

export type ObjectSearcher = {
  /** 对象类型名，显示为分组标题，例如“订单”。 */
  kind: string
  /** 需要的权限点；没有权限的成员搜索不到这类对象。 */
  permission?: string
  search: (query: string, signal: AbortSignal) => Promise<ObjectHit[]>
}

const searchers = new Map<string, ObjectSearcher>()

export function registerObjectSearcher(searcher: ObjectSearcher) {
  searchers.set(searcher.kind, searcher)
  return () => {
    searchers.delete(searcher.kind)
  }
}

export function listObjectSearchers(canPermission: (permission: string) => boolean): ObjectSearcher[] {
  return [...searchers.values()].filter(item => !item.permission || canPermission(item.permission))
}
