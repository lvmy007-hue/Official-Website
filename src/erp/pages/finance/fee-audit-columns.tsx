import { Tag } from 'antd'
import { FEE_AUDIT_CONVERT, type FeeAuditRow, type FeeAuditStatus, type SizeTierChangeRow } from '@nova/api-contracts'
import { FormAction, renderColumn, RIGHT_ALIGNED, textColumn, type ErpColDef } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { useApiMutation } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { money, timeText } from '../orders/orders-ui'

// 费用核查列表的列（07 章 7.6）：对象、应收、实收、差额、发生次数、累计差额、状态；“转为赔付机会”只在疑似多收且有赔付写权限时出现。

const STATUS_COLOR: Record<FeeAuditStatus, string> = { NORMAL: 'success', SUSPECTED: 'error', APPEALED: 'processing' }

function ConvertAction({ row, onDone }: { row: FeeAuditRow; onDone: () => void }) {
  const convert = useApiMutation<Record<string, never>>({ method: 'POST', path: `/finance/fee-audit/${encodeURIComponent(row.id)}/reimbursement`, invalidate: ['list'], silent: true })
  return (
    <FormAction
      label="转为赔付机会"
      buttonProps={{ size: 'small', type: 'link' }}
      guard={{ permission: FEE_AUDIT_CONVERT }}
      title="转为赔付机会"
      description="把这个疑似多收的对象转成赔付中心的“费用多收”机会，之后在赔付中心立案跟进。金额是核查算出的累计差额，不代表亚马逊会认可；同一对象只会转一次。"
      okText="转为机会"
      successText="已转为赔付机会，可到赔付中心跟进"
      onDone={onDone}
      onSubmit={() => convert.mutateAsync({})}
    />
  )
}

/** 服务端只允许这两个排序字段（FeeAuditQuerySchema）。 */
export const AUDIT_SORTABLE: Readonly<Record<string, string>> = { overchargeAmount: 'overchargeAmount', occurrences: 'occurrences' }

const amountColumn = (title: string, key: 'expectedAmount' | 'actualAmount' | 'diffAmount' | 'overchargeAmount', width: number, extra: ErpColDef<FeeAuditRow> = {}) =>
  renderColumn<FeeAuditRow>(title, key, row => money(row[key], row.currency), { width, sortable: false, ...RIGHT_ALIGNED, ...extra })

export function auditColumns(options: { canConvert: () => boolean; canReimbursements: () => boolean; onChanged: () => void }): ErpColDef<FeeAuditRow>[] {
  return [
    renderColumn<FeeAuditRow>(
      '核查对象',
      'subject',
      row => (
        <span className="erp-cell-stack">
          <span className="erp-num">{row.sku ?? row.shipmentRef ?? row.subjectKey}</span>
          <span className="erp-cell-sub">
            {row.storeName}
            {row.asin ? ` · ${row.asin}` : ''}
          </span>
        </span>
      ),
      { width: 220, pin: 'left', sortable: false },
    ),
    amountColumn('应收（预期）', 'expectedAmount', 120),
    amountColumn('实收', 'actualAmount', 120),
    amountColumn('差额', 'diffAmount', 110),
    renderColumn<FeeAuditRow>(
      '多收次数',
      'occurrences',
      row => (
        <span className="erp-num">
          {row.occurrences} / {row.checkedCount}
        </span>
      ),
      { width: 120, sortable: true, ...RIGHT_ALIGNED },
    ),
    amountColumn('累计差额', 'overchargeAmount', 120, { sortable: true }),
    renderColumn<FeeAuditRow>('最近一次', 'lastSeenAt', row => timeText(row.lastSeenAt), { width: 160, sortable: false }),
    renderColumn<FeeAuditRow>(
      '状态',
      'status',
      row => (
        <Tag color={STATUS_COLOR[row.status]} bordered={false}>
          {row.statusLabel}
        </Tag>
      ),
      { width: 130, sortable: false },
    ),
    renderColumn<FeeAuditRow>(
      '操作',
      'actions',
      row => {
        if (row.status === 'APPEALED') return options.canReimbursements() ? <AppLink to="/app/reimbursements">在赔付中心跟进</AppLink> : <Muted>已转赔付机会</Muted>
        if (row.status === 'SUSPECTED' && options.canConvert()) {
          return (
            <span data-no-row-open>
              <ConvertAction row={row} onDone={options.onChanged} />
            </span>
          )
        }
        return <Muted>无</Muted>
      },
      { width: 150, pin: 'right', sortable: false },
    ),
  ]
}

export const sizeTierColumns: ErpColDef<SizeTierChangeRow>[] = [
  textColumn<SizeTierChangeRow>('店铺', 'storeName', { width: 140 }),
  renderColumn<SizeTierChangeRow>('SKU', 'sku', row => <span className="erp-num">{row.sku}</span>, { width: 180 }),
  renderColumn<SizeTierChangeRow>('ASIN', 'asin', row => (row.asin ? <span className="erp-num">{row.asin}</span> : <Muted>无</Muted>), { width: 130 }),
  textColumn<SizeTierChangeRow>('原分段', 'previousTier', { width: 220 }),
  textColumn<SizeTierChangeRow>('现分段', 'currentTier', { width: 220 }),
  renderColumn<SizeTierChangeRow>('变化日期', 'changedOn', row => <span className="erp-num">{row.changedOn}</span>, { width: 120 }),
]
