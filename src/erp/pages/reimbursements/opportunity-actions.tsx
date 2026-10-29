import { Alert, Form, Input, InputNumber, Space } from 'antd'
import { REIMBURSEMENTS_WRITE, type OpportunityRow } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { LiveLink } from '../inventory/inventory-ui'
import { useApiMutation } from '../../query/api-query'
import { optional } from '../procurement/procurement-ui'

// 赔付机会行上的动作：生成案件、忽略、恢复。亚马逊的卖家支持接口不能创建案件，所以“生成案件”只是在系统里立案跟踪，
// 提交要到卖家后台完成，之后在案件详情里回填亚马逊案件编号。每次写入都带页面看到的版本号，别人先改了会提示刷新。

const WRITE = REIMBURSEMENTS_WRITE

const amountOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export function OpportunityActions({ row }: { row: OpportunityRow }) {
  const create = useApiMutation<Record<string, unknown>, { id: string }>({ method: 'POST', path: '/reimbursements', invalidate: ['list', 'analytics'] })
  const ignore = useApiMutation<Record<string, unknown>>({ method: 'POST', path: `/reimbursements/opportunities/${encodeURIComponent(row.id)}/ignore`, invalidate: ['list', 'analytics'] })
  const restore = useApiMutation<Record<string, unknown>>({ method: 'POST', path: `/reimbursements/opportunities/${encodeURIComponent(row.id)}/restore`, invalidate: ['list', 'analytics'] })
  const needAmount = row.estimatedAmount === null

  if (row.caseId) {
    return (
      <LiveLink component="ReimbursementDetailPage" id={row.caseId}>
        {row.caseNo ?? '查看案件'}
      </LiveLink>
    )
  }
  if (row.status === 'IGNORED') {
    return (
      <FormAction
        label="恢复"
        buttonProps={{ type: 'link', size: 'small' }}
        guard={{ permission: WRITE }}
        title="恢复这条机会"
        description={row.note ? `忽略原因：${row.note}` : undefined}
        okText="恢复"
        successText="已恢复为待处理"
        onSubmit={() => restore.mutateAsync({ version: row.version })}
      />
    )
  }
  if (row.status !== 'PENDING') return null

  return (
    <Space size={0}>
      <FormAction
        label="生成案件"
        buttonProps={{ type: 'link', size: 'small' }}
        guard={{ permission: WRITE }}
        title="生成赔付案件"
        description={
          <Alert
            type="info"
            showIcon
            message="系统只在这里立案跟踪；亚马逊的案件需要在卖家后台提交，提交后到案件详情回填亚马逊案件编号。"
            description={needAmount ? '这条机会没有商品成本，无法估算应收金额；请自行填写应收金额与币种（也可以先不填，之后再补）。' : `应收金额默认取估算金额，可以改。`}
          />
        }
        initialValues={{ expectedAmount: row.estimatedAmount ?? undefined, currency: row.currency ?? undefined }}
        okText="生成案件"
        successText="案件已生成"
        onSubmit={values =>
          create.mutateAsync({
            opportunityId: row.id,
            ...(amountOf(values.expectedAmount) !== null ? { expectedAmount: amountOf(values.expectedAmount) } : {}),
            ...(optional(values.currency) ? { currency: String(values.currency).trim().toUpperCase() } : {}),
            ...(optional(values.note) ? { note: optional(values.note) } : {}),
          })
        }
      >
        <Form.Item label="应收金额" name="expectedAmount">
          <InputNumber aria-label="应收金额" min={0} precision={2} style={{ width: 200 }} />
        </Form.Item>
        <Form.Item label="币种" name="currency" rules={[{ pattern: /^[A-Za-z]{3}$/, message: '3 位字母币种代码，例如 USD' }]}>
          <Input aria-label="币种" maxLength={3} style={{ width: 100 }} disabled={row.currency !== null} />
        </Form.Item>
        <Form.Item label="备注" name="note">
          <Input.TextArea aria-label="备注" rows={2} maxLength={500} />
        </Form.Item>
      </FormAction>
      <FormAction
        label="忽略"
        danger
        buttonProps={{ type: 'link', size: 'small' }}
        guard={{ permission: WRITE }}
        title="忽略这条机会"
        description="忽略后不再进入待处理，也不会生成案件；以后随时可以恢复。"
        reason={{ label: '忽略原因', placeholder: '例如：已与亚马逊线下沟通、金额太小、确认不是亚马逊责任' }}
        okText="忽略"
        successText="已忽略"
        onSubmit={values => ignore.mutateAsync({ version: row.version, reason: values.reason })}
      />
    </Space>
  )
}
