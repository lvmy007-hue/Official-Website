import { Tag } from 'antd'
import { MV_FLOW_KEYS, MV_FLOW_LABEL, type MvFlowKey, type MvRow } from '@nova/api-contracts'
import { moneyColumn, numberColumn, renderColumn, textColumn, type ErpColDef } from '../../components'
import { withSource } from './source-header'

// 进销存报表的列（P6-25，16 章第 4 节）：每个 SKU、每个月一行，期初 + 各类变动 = 期末；数量不平衡的行标红并给出差额。
// 货值按月内生效的成本版本（CostVersion）取价；没有成本权限的列不出现，没有成本版本的格显示“—”并在问号里写原因。

export type MovementGridRow = MvRow & Record<`flow_${MvFlowKey}`, number> & { openingValue: number | null; endingValue: number | null; valueDifference: number | null }

export const MV_SORTABLE: Readonly<Record<string, string>> = { month: 'month', sku: 'sku', endingQty: 'endingQty', turnoverDays: 'turnoverDays', difference: 'difference' }

export const flowId = (key: MvFlowKey) => `flow_${key}` as const

export function flattenMovement(row: MvRow): MovementGridRow {
  const flows = Object.fromEntries(MV_FLOW_KEYS.map(key => [flowId(key), row.flows[key]])) as Record<`flow_${MvFlowKey}`, number>
  return { ...row, ...flows, openingValue: row.values?.opening ?? null, endingValue: row.values?.ending ?? null, valueDifference: row.values?.difference ?? null }
}

const LEDGER_SOURCE = '表 InventoryLedgerSummary（库存台账月汇总，按店铺与 SKU 累加）'

export function movementColumns(costRestricted: boolean): ErpColDef<MovementGridRow>[] {
  const columns: ErpColDef<MovementGridRow>[] = [
    textColumn<MovementGridRow>('月份', 'month', { pin: 'left', width: 100, group: '期间', ...withSource('台账汇总的月份；范围内涉及的每个月一行') }),
    renderColumn<MovementGridRow>(
      'SKU',
      'sku',
      row => (
        <span className="erp-cell-stack">
          <span className="erp-num">{row.sku}</span>
          <span className="erp-cell-sub">{row.asin}</span>
        </span>
      ),
      { pin: 'left', width: 190, group: '商品' },
    ),
    numberColumn<MovementGridRow>('期初', 'openingQty', { digits: 0, width: 100, group: '期初', ...withSource(`${LEDGER_SOURCE} 的 openingQty 相加；等于上月期末`) }),
  ]
  for (const key of MV_FLOW_KEYS) {
    columns.push(
      numberColumn<MovementGridRow>(MV_FLOW_LABEL[key], flowId(key), {
        digits: 0,
        width: 110,
        group: '本月变动',
        signed: true,
        ...withSource(`${LEDGER_SOURCE} 的变动类字段，归并为“${MV_FLOW_LABEL[key]}”`),
      } as never),
    )
  }
  columns.push(
    numberColumn<MovementGridRow>('期末', 'endingQty', { digits: 0, width: 100, group: '期末', ...withSource(`${LEDGER_SOURCE} 的 endingQty 相加（报告给出的期末）`) }),
    renderColumn<MovementGridRow>(
      '数量差额',
      'difference',
      row => (row.balanced ? <span className="erp-num">0</span> : <Tag color="red">{`${row.difference > 0 ? '+' : ''}${row.difference}（期末应为 ${row.expectedEnding}）`}</Tag>),
      { width: 190, group: '期末', ...withSource('报告给出的期末 − （期初 + 全部变动）；不为 0 说明台账缺事件或有未识别的变动，需要核对，不会被自动抹平') },
    ),
    numberColumn<MovementGridRow>('发货件数', 'shippedUnits', { digits: 0, width: 110, group: '周转', ...withSource('当月发货变动的绝对值') }),
    numberColumn<MovementGridRow>('周转天数', 'turnoverDays', { digits: 1, width: 110, group: '周转', ...withSource('期末数量 ÷（当月发货件数 ÷ 当月天数）；当月没有发货没有值') }),
    numberColumn<MovementGridRow>('存销比', 'sellThrough', { digits: 2, width: 100, group: '周转', ...withSource('期末数量 ÷ 当月发货件数；当月没有发货没有值') }),
  )
  if (!costRestricted) {
    columns.push(
      moneyColumn<MovementGridRow>('单件成本', 'unitCost', {
        width: 110,
        group: '货值',
        ...withSource('表 CostVersion：当月最后一天生效的成本版本（美元）四项成本相加；没有版本或币种不是美元显示“—”'),
      }),
      moneyColumn<MovementGridRow>('期初货值', 'openingValue', { width: 120, group: '货值', ...withSource('期初数量 × 月内生效成本版本的单件成本') }),
      moneyColumn<MovementGridRow>('期末货值', 'endingValue', { width: 120, group: '货值', ...withSource('期末数量 × 月内生效成本版本的单件成本') }),
      moneyColumn<MovementGridRow>('货值差额', 'valueDifference', { width: 120, group: '货值', signed: true, ...withSource('期末货值 −（期初货值 + 全部变动货值）；数量平衡时为 0') }),
    )
  }
  return columns
}
