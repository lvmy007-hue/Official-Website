import { AW_COLUMNS, AW_KIND_LABEL, type AwCells, type AwChild, type AwColumnKey, type AwRow } from '@nova/api-contracts'
import { moneyColumn, numberColumn, renderColumn, type ErpColDef } from '../../components'
import { withSource } from './source-header'

// 跨仓总览的列（P6-25，16 章第 4 节）：SKU 聚合行，可展开到每个仓（FBA、AWD、国内仓、头程在途）。
// 每个数量列的问号写明“从哪个表取哪个字段”（登记在契约 AW_COLUMNS 里）；已到仓、在途、合计互斥相加，
// “仅展示”列（AWD 发往 FBA）与 FBA 入库中是同一批货，不计入合计。没有来源的格显示“—”，不是 0。

/** 行与子行共用一个形状：子行没有标题、成本，也没有子行；数量单元格铺平到行上（列标识就是单元格键，汇总行与排序都按它取值）。 */
export type AwFlatRow = Omit<AwRow, 'children' | 'title'> &
  Partial<Record<AwColumnKey, number | null>> & { title: string | null; label: string | null; kind: string | null; isChild: boolean; childRows: AwFlatRow[] }

export const AW_SORTABLE: Readonly<Record<string, string>> = { sku: 'sku', total: 'total', onHand: 'onHand', inTransit: 'inTransit' }

function childRow(parent: AwRow, child: AwChild): AwFlatRow {
  return {
    ...(child.cells as AwCells),
    id: `${parent.id}|${child.id}`,
    sku: parent.sku,
    title: null,
    label: child.label,
    kind: AW_KIND_LABEL[child.kind],
    cells: child.cells,
    onHand: null,
    inTransit: null,
    total: child.total,
    unitCost: null,
    stockValue: null,
    isChild: true,
    childRows: [],
  }
}

/** 一个 SKU 行连同它下面每个仓的子行。 */
export function toFlatRow(row: AwRow): AwFlatRow {
  const { children, ...rest } = row
  return { ...rest, ...(row.cells as AwCells), label: null, kind: null, isChild: false, childRows: children.map(child => childRow(row, child)) }
}

export function allWarehousesColumns(options: { restricted: ReadonlySet<AwColumnKey>; costRestricted: boolean }): ErpColDef<AwFlatRow>[] {
  const columns: ErpColDef<AwFlatRow>[] = [
    renderColumn<AwFlatRow>(
      'SKU',
      'sku',
      row =>
        row.isChild ? (
          <span className="erp-cell-stack">
            <span>{row.label}</span>
            <span className="erp-cell-sub">{row.kind}</span>
          </span>
        ) : (
          <span className="erp-cell-stack">
            <span className="erp-num">{row.sku}</span>
            {row.title ? <span className="erp-cell-sub erp-cell-ellipsis">{row.title}</span> : null}
          </span>
        ),
      { pin: 'left', width: 240, group: '商品' },
    ),
  ]
  for (const item of AW_COLUMNS) {
    if (options.restricted.has(item.key)) continue
    const group = item.part === 'ON_HAND' ? '已到仓' : item.part === 'IN_TRANSIT' ? '在途' : '仅展示（不计入合计）'
    columns.push(numberColumn<AwFlatRow>(item.label, item.key as never, { digits: 0, width: 118, group, ...withSource(item.source) }))
  }
  columns.push(
    numberColumn<AwFlatRow>('已到仓合计', 'onHand', { digits: 0, width: 120, group: '合计', ...withSource('已到仓各列相加：FBA 可售、预留、不可售，AWD 在库，国内仓在库') }),
    numberColumn<AwFlatRow>('在途合计', 'inTransit', { digits: 0, width: 110, group: '合计', ...withSource('在途各列相加：FBA 入库中、AWD 入库中、头程在途；AWD 发往 FBA 不计入') }),
    numberColumn<AwFlatRow>('合计', 'total', { digits: 0, width: 100, group: '合计', ...withSource('已到仓合计 + 在途合计；已到仓与在途互斥，同一件货只算一次') }),
  )
  if (!options.costRestricted) {
    columns.push(
      moneyColumn<AwFlatRow>('单件成本', 'unitCost', { width: 110, group: '货值', ...withSource('表 CostVersion：今天生效的成本版本（美元）的商品、头程、关税、其他成本相加；没有版本显示“—”') }),
      moneyColumn<AwFlatRow>('货值', 'stockValue', { width: 120, group: '货值', ...withSource('合计数量 × 单件成本（含在途）；没有成本版本、币种不是美元时不估算，显示“—”') }),
    )
  }
  return columns
}
