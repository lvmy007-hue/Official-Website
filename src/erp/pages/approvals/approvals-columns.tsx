import { Tag, Typography } from 'antd'
import type { ApprovalRow, ApprovalStatus } from '@nova/api-contracts'
import { renderColumn, type ErpColDef } from '../../components'
import { Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'

// 审批收件箱表的列（P6-27）：单据（类型与标题）、发起人、审批人、状态、提交时间、处理人与处理时间。

const STATUS_COLOR: Record<ApprovalStatus, string> = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'error', CANCELLED: 'default' }

export const StatusTag = ({ row }: { row: Pick<ApprovalRow, 'status' | 'statusLabel'> }) => (
  <Tag color={STATUS_COLOR[row.status]} bordered={false}>
    {row.statusLabel}
  </Tag>
)

export const approvalColumns: ErpColDef<ApprovalRow>[] = [
  renderColumn<ApprovalRow>(
    '单据',
    'title',
    row => (
      <div>
        <Typography.Text strong>{row.title}</Typography.Text>
        <div>
          <Muted>{row.typeLabel}</Muted>
        </div>
      </div>
    ),
    { group: '单据', pin: 'left', width: 300 },
  ),
  renderColumn<ApprovalRow>('状态', 'status', row => <StatusTag row={row} />, { group: '单据', width: 100 }),
  renderColumn<ApprovalRow>('发起人', 'requesterName', row => row.requesterName, { group: '人员', width: 120 }),
  renderColumn<ApprovalRow>('审批人', 'approverNames', row => (row.approverNames.length > 0 ? row.approverNames.join('、') : <Muted>没有其他有权限的成员</Muted>), { group: '人员', width: 200 }),
  renderColumn<ApprovalRow>('抄送', 'ccNames', row => (row.ccNames.length > 0 ? row.ccNames.join('、') : <Muted>无</Muted>), { group: '人员', width: 140 }),
  renderColumn<ApprovalRow>('提交时间', 'createdAt', row => timeText(row.createdAt), { group: '时间', width: 170 }),
  renderColumn<ApprovalRow>('处理人', 'decidedByName', row => row.decidedByName ?? <Muted>未处理</Muted>, { group: '处理', width: 120 }),
  renderColumn<ApprovalRow>('处理时间', 'decidedAt', row => (row.decidedAt ? timeText(row.decidedAt) : <Muted>未处理</Muted>), { group: '处理', width: 170 }),
]
