import { Descriptions, Drawer, Form, Input, Space, Typography } from 'antd'
import { FINANCE_POLICY_STEP_UP, type ApprovalDecisionResult, type ApprovalRow } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { useApiMutation } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { StatusTag } from './approvals-columns'

// 审批抽屉（P6-27）：单据摘要、发起与处理信息，并直接审批。通过时意见选填；驳回必须写原因，发起人自己点就是“撤回”。
// 财务口径、利润公式与业务口径的审批要再次验证身份（与原页面一致）；权限、发起人与审批人分离等规则由服务端转给原模块判断，界面只展示结果。

const NEEDS_STEP_UP = new Set<ApprovalRow['type']>(['FINANCE_POLICY', 'PROFIT_FORMULA'])

type Vars = { decision: 'APPROVED' | 'REJECTED'; comment: string }

function Actions({ row, onDone }: { row: ApprovalRow; onDone: () => void }) {
  const mutation = useApiMutation<Vars, ApprovalDecisionResult>({
    method: 'POST',
    path: `/approvals/${row.id}/decision`,
    body: variables => ({ decision: variables.decision, comment: variables.comment, version: row.version }),
    invalidate: ['list'],
    silent: true,
  })
  const stepUp = NEEDS_STEP_UP.has(row.type) ? FINANCE_POLICY_STEP_UP : undefined
  const reject = row.isRequester ? '撤回' : '驳回'
  return (
    <Space data-testid="approval-actions">
      {row.isRequester ? null : (
        <FormAction
          label="通过"
          title={`通过：${row.title}`}
          okText="通过"
          guard={{}}
          stepUp={stepUp}
          successText="已通过"
          buttonProps={{ type: 'primary' }}
          onSubmit={values => mutation.mutateAsync({ decision: 'APPROVED', comment: String(values.comment ?? '').trim() })}
          onDone={onDone}
        >
          <Form.Item label="审批意见（选填）" name="comment">
            <Input.TextArea aria-label="审批意见" rows={3} maxLength={500} showCount />
          </Form.Item>
        </FormAction>
      )}
      <FormAction
        label={reject}
        title={`${reject}：${row.title}`}
        okText={reject}
        danger
        guard={{}}
        stepUp={stepUp}
        reason={{ label: row.isRequester ? '撤回原因' : '驳回原因', placeholder: '写明原因，发起人和其他审批人都能看到' }}
        successText={row.isRequester ? '已撤回' : '已驳回'}
        onSubmit={values => mutation.mutateAsync({ decision: 'REJECTED', comment: String(values.reason ?? '').trim() })}
        onDone={onDone}
      />
    </Space>
  )
}

export function ApprovalDrawer({ row, onClose, onDone }: { row: ApprovalRow | null; onClose: () => void; onDone: () => void }) {
  const done = () => {
    onDone()
    onClose()
  }
  return (
    <Drawer open={row !== null} onClose={onClose} width={560} title={row?.title ?? '审批单'} destroyOnClose data-testid="approval-drawer">
      {row ? (
        <>
          <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
            <Descriptions.Item label="类型">{row.typeLabel}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <StatusTag row={row} />
            </Descriptions.Item>
            <Descriptions.Item label="发起人">{row.requesterName}</Descriptions.Item>
            <Descriptions.Item label="审批人">{row.approverNames.length > 0 ? row.approverNames.join('、') : '没有其他有权限的成员，请联系管理员开通审批权限'}</Descriptions.Item>
            {row.ccNames.length > 0 ? <Descriptions.Item label="抄送">{row.ccNames.join('、')}</Descriptions.Item> : null}
            <Descriptions.Item label="提交时间">{timeText(row.createdAt)}</Descriptions.Item>
            {row.decidedAt ? <Descriptions.Item label="处理">{`${row.decidedByName ?? '未知'}，${timeText(row.decidedAt)}`}</Descriptions.Item> : null}
            {row.comment ? <Descriptions.Item label="处理意见">{row.comment}</Descriptions.Item> : null}
          </Descriptions>
          <Typography.Title level={5}>单据摘要</Typography.Title>
          {row.summary.length > 0 ? (
            <Descriptions size="small" column={1} data-testid="approval-summary">
              {row.summary.map((item, index) => (
                <Descriptions.Item key={`${item.label}-${index}`} label={item.label}>
                  {item.value}
                </Descriptions.Item>
              ))}
            </Descriptions>
          ) : (
            <Muted>提交时没有记录摘要，请打开原单据查看</Muted>
          )}
          <Space style={{ marginTop: 16 }} direction="vertical">
            {row.detailPath ? (
              <AppLink to={row.detailPath}>
                <Typography.Link>查看原单据</Typography.Link>
              </AppLink>
            ) : null}
            {row.canDecide ? <Actions row={row} onDone={done} /> : <Muted>{row.status === 'PENDING' ? '你不是这张单据的审批人，只能查看' : '这张审批已经处理完毕'}</Muted>}
          </Space>
        </>
      ) : null}
    </Drawer>
  )
}
