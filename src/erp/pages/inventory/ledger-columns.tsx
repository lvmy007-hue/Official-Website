import { Tag, Tooltip } from 'antd'
import type { LedgerDetailRow, LedgerSummaryRow } from '@nova/api-contracts'
import { renderColumn, RIGHT_ALIGNED, textColumn, type ErpColDef } from '../../components'
import { formatNumber } from '../../format'
import { Muted } from './inventory-ui'

// 库存台账两张表的列（06 章 6.4；P6-28 迁到 PagedGrid 与 MassiveGrid）：汇总按“期初 + 各类变动 = 期末”展开，平衡校验不通过的行标红并给出差额；
// 明细逐条流水。没有数字的单元格写“尚无记录”，不显示成 0。台账接口没有排序参数，列都不可排序。

const num = (value: number | null | undefined, options: { sign?: boolean } = {}) =>
  value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(value, { digits: 0, ...options })}</span>

const numColumn = <T extends object>(title: string, id: string, get: (row: T) => number | null, width: number, sign = false): ErpColDef<T> =>
  renderColumn<T>(title, id, row => num(get(row), { sign }), { width, sortable: false, ...RIGHT_ALIGNED })

const flow = (title: string, key: 'receipts' | 'customerShipments' | 'customerReturns' | 'vendorReturns' | 'transfers' | 'found' | 'lost' | 'damaged' | 'disposed' | 'other', width = 100) =>
  numColumn<LedgerSummaryRow>(title, key, row => row[key], width, true)

function Difference({ row }: { row: LedgerSummaryRow }) {
  if (row.balanced)
    return (
      <Tag color="success" bordered={false}>
        平衡
      </Tag>
    )
  return (
    <Tooltip title={`报告期末 ${row.endingQty}，期初 ${row.startingQty} 加各类变动应为 ${row.expectedEnding}`}>
      <Tag color="error" bordered={false}>
        不平衡 {formatNumber(row.difference, { digits: 0, sign: true })}
      </Tag>
    </Tooltip>
  )
}

function LiveCompare({ row }: { row: LedgerSummaryRow }) {
  const live = row.live
  if (!live) return <Muted>仅最近一个月比对</Muted>
  if (live.liveQty === null || live.difference === null) return <Muted>库存接口尚无记录</Muted>
  return (
    <Tooltip title={`台账 ${live.ledgerDate} 期末 ${live.ledgerEnding}；库存接口仓内 ${live.liveQty}（可售 + 预留 + 不可售）。仅供参考，两者时点不同。`}>
      <span className="erp-num">
        {live.liveQty}
        {live.difference === 0 ? '' : `（差 ${formatNumber(live.difference, { digits: 0, sign: true })}）`}
      </span>
    </Tooltip>
  )
}

export function summaryColumns(): ErpColDef<LedgerSummaryRow>[] {
  return [
    textColumn<LedgerSummaryRow>('月份', 'month', { width: 100, pin: 'left' }),
    textColumn<LedgerSummaryRow>('店铺', 'storeName', { width: 140 }),
    renderColumn<LedgerSummaryRow>(
      'SKU / FNSKU',
      'sku',
      row => (
        <span className="erp-cell-stack">
          <span>{row.sku || <Muted>尚无记录</Muted>}</span>
          <span className="erp-cell-sub">{row.fnsku}</span>
        </span>
      ),
      { width: 200 },
    ),
    numColumn<LedgerSummaryRow>('期初', 'startingQty', row => row.startingQty, 90),
    flow('接收', 'receipts'),
    flow('客户发货', 'customerShipments'),
    flow('客户退货', 'customerReturns'),
    flow('供应商退货', 'vendorReturns', 110),
    flow('仓间转运', 'transfers'),
    flow('找到', 'found', 90),
    flow('丢失', 'lost', 90),
    flow('损坏', 'damaged', 90),
    flow('处置', 'disposed', 90),
    flow('其他', 'other', 90),
    renderColumn<LedgerSummaryRow>('未识别事件', 'unknownEvents', row => <Tooltip title="事件类型不在已知分类里的变动，按原符号计入期末核对">{num(row.unknownEvents, { sign: true })}</Tooltip>, {
      width: 110,
      sortable: false,
      ...RIGHT_ALIGNED,
    }),
    numColumn<LedgerSummaryRow>('期末（报告）', 'endingQty', row => row.endingQty, 120),
    renderColumn<LedgerSummaryRow>('平衡校验', 'balance', row => <Difference row={row} />, { width: 150 }),
    renderColumn<LedgerSummaryRow>('库存接口比对', 'live', row => <LiveCompare row={row} />, { width: 160 }),
  ]
}

// 单据编号是亚马逊的订单号或货件编号，与系统内部编号不同，所以只显示文字与类型，不生成可能指错对象的链接。
const REFERENCE_LABEL = { ORDER: '订单', INBOUND_SHIPMENT: '入库货件' } as const
const text = (value: string | null | undefined) => value || <Muted>尚无记录</Muted>

export function detailColumns(): ErpColDef<LedgerDetailRow>[] {
  return [
    textColumn<LedgerDetailRow>('事件日期', 'eventDate', { width: 110, pin: 'left' }),
    textColumn<LedgerDetailRow>('店铺', 'storeName', { width: 130 }),
    renderColumn<LedgerDetailRow>(
      'SKU / FNSKU',
      'sku',
      row => (
        <span className="erp-cell-stack">
          <span>{row.sku || <Muted>尚无记录</Muted>}</span>
          <span className="erp-cell-sub">{row.fnsku}</span>
        </span>
      ),
      { width: 180 },
    ),
    renderColumn<LedgerDetailRow>(
      '事件类型',
      'event',
      row => (
        <span className="erp-cell-stack">
          <span>
            <Tag bordered={false}>{row.groupLabel}</Tag>
            {row.adjustmentLabel ? (
              <Tag color="warning" bordered={false}>
                {row.adjustmentLabel}
              </Tag>
            ) : null}
          </span>
          <span className="erp-cell-sub">{row.eventType}</span>
        </span>
      ),
      { width: 220 },
    ),
    numColumn<LedgerDetailRow>('数量', 'quantity', row => row.quantity, 90, true),
    renderColumn<LedgerDetailRow>('库位', 'fulfillmentCenter', row => text(row.fulfillmentCenter), { width: 100 }),
    renderColumn<LedgerDetailRow>('处置状态', 'disposition', row => text(row.disposition), { width: 120 }),
    renderColumn<LedgerDetailRow>('原因代码', 'reasonCode', row => text(row.reasonCode), { width: 110 }),
    renderColumn<LedgerDetailRow>(
      '单据编号',
      'reference',
      row =>
        row.referenceId ? (
          <span className="erp-cell-stack">
            <span>{row.referenceId}</span>
            {row.referenceKind ? <span className="erp-cell-sub">{REFERENCE_LABEL[row.referenceKind]}</span> : null}
          </span>
        ) : (
          <Muted>尚无记录</Muted>
        ),
      { width: 220 },
    ),
    numColumn<LedgerDetailRow>('已对账', 'reconciledQty', row => row.reconciledQty, 90),
    numColumn<LedgerDetailRow>('未对账', 'unreconciledQty', row => row.unreconciledQty, 90),
  ]
}
