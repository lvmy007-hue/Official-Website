import { Alert, Form, Input, InputNumber, Select } from 'antd'
import { AMAZON_CASE_ID_PATTERN, CASE_STATUS_LABEL, REIMBURSEMENTS_WRITE, type CaseDetailResponse, type CaseStatus } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { optional } from '../procurement/procurement-ui'

// 案件详情上的动作：改状态、回填亚马逊案件编号、改应收与备注、生成证据包。可用的状态由服务端算出（nextStatuses），
// 已到账只由官方赔付明细匹配产生，页面没有手工标已到账或手填实收的入口。每次写入带页面看到的版本号，别人先改了会提示刷新。

const WRITE = REIMBURSEMENTS_WRITE
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export function CaseActions({ detail, onChanged }: { detail: CaseDetailResponse; onChanged: () => void }) {
  const row = detail.case
  const base = `/reimbursements/${encodeURIComponent(row.id)}`
  const patch = useApiMutation<Record<string, unknown>>({ method: 'PATCH', path: base, invalidate: ['list', 'analytics'] })
  const pack = useApiMutation<Record<string, unknown>, { exportJobId: string; lineCount: number }>({ method: 'POST', path: `${base}/evidence-pack`, invalidate: ['list'] })
  const writable = detail.canWrite
  const status = (value: CaseStatus) => ({ value, label: CASE_STATUS_LABEL[value] })

  return (
    <>
      <FormAction
        label="更新状态"
        buttonProps={{ type: 'primary' }}
        guard={{ permission: WRITE, condition: { ok: writable && detail.nextStatuses.length > 0, reason: row.status === 'PAID' ? '案件已到账，没有后续状态' : '当前没有可以改的状态' } }}
        title="更新案件状态"
        description={<Alert type="info" showIcon message="“已到账”不能手工标记：官方赔付明细同步后系统自动匹配，实收金额也只来自赔付明细。批准或部分批准时请填写亚马逊批准的金额。" />}
        okText="更新"
        successText="状态已更新"
        onDone={onChanged}
        onSubmit={values => patch.mutateAsync({ version: row.version, status: values.status, ...(num(values.approvedAmount) !== null ? { approvedAmount: num(values.approvedAmount) } : {}) })}
      >
        <Form.Item label="改为" name="status" rules={[{ required: true, message: '请选择状态' }]}>
          <Select aria-label="改为" options={detail.nextStatuses.map(status)} style={{ width: 200 }} />
        </Form.Item>
        <Form.Item label="亚马逊批准金额" name="approvedAmount" extra={`币种 ${row.currency ?? '未设置'}；批准、部分批准时必填`}>
          <InputNumber aria-label="亚马逊批准金额" min={0} precision={2} style={{ width: 200 }} />
        </Form.Item>
      </FormAction>
      <FormAction
        label={row.amazonCaseId ? '修改亚马逊案件编号' : '回填亚马逊案件编号'}
        guard={{ permission: WRITE, condition: { ok: writable, reason: '没有写入权限或不在你的数据范围内' } }}
        title="回填亚马逊案件编号"
        description="在卖家后台提交案件后，把亚马逊给的案件编号填在这里；官方赔付明细带有案件编号时会按它优先匹配。"
        initialValues={{ amazonCaseId: row.amazonCaseId ?? '' }}
        okText="保存"
        successText="案件编号已保存"
        onDone={onChanged}
        onSubmit={values => patch.mutateAsync({ version: row.version, amazonCaseId: optional(values.amazonCaseId) ?? null })}
      >
        <Form.Item label="亚马逊案件编号" name="amazonCaseId" rules={[{ pattern: AMAZON_CASE_ID_PATTERN, message: '只能含字母、数字与短横线，最长 40 位' }]}>
          <Input aria-label="亚马逊案件编号" maxLength={40} style={{ width: 260 }} />
        </Form.Item>
      </FormAction>
      <FormAction
        label="修改应收与备注"
        guard={{ permission: WRITE, condition: { ok: writable && row.status !== 'PAID', reason: row.status === 'PAID' ? '案件已到账，金额不能再修改' : '没有写入权限或不在你的数据范围内' } }}
        title="修改应收金额与备注"
        initialValues={{ expectedAmount: row.expectedAmount ?? undefined, currency: row.currency ?? undefined, note: row.note ?? '' }}
        okText="保存"
        successText="已保存"
        onDone={onChanged}
        onSubmit={values =>
          patch.mutateAsync({
            version: row.version,
            ...(num(values.expectedAmount) !== null ? { expectedAmount: num(values.expectedAmount) } : {}),
            ...(row.currency === null && optional(values.currency) ? { currency: String(values.currency).trim().toUpperCase() } : {}),
            note: optional(values.note) ?? null,
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
          <Input.TextArea aria-label="备注" rows={3} maxLength={500} />
        </Form.Item>
      </FormAction>
      <FormAction
        label="生成证据包"
        guard={{ permission: 'export.create', condition: { ok: writable, reason: '没有写入权限或不在你的数据范围内' } }}
        title="生成证据包"
        description="把案件信息、识别依据、证据引用、附件清单、已匹配的官方赔付明细固化成一份清单，并生成可下载的导出文件（在下方“证据包”列表或导出中心下载）。附件本身请在案件的附件里下载，一并提交给亚马逊。"
        okText="生成"
        successText="证据包已生成，文件生成后可在下方下载"
        onDone={onChanged}
        onSubmit={() => pack.mutateAsync({})}
      />
    </>
  )
}
