import { useMemo, useRef } from 'react'
import { Alert, Card, Form, Input, InputNumber } from 'antd'
import { CASHFLOW_CONFIRM, DISBURSEMENT_NOTE_MAX, type CashflowDisbursements, type DisbursementRow } from '@nova/api-contracts'
import { FormAction, LocalGrid } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { money } from '../orders/orders-ui'
import { disbursementColumns } from './cashflow-columns'

// 到账核对（P2b-08，07 章 7.8）：结算报告里的打款金额是“应到账”，财务手工登记实际到账；两边对得上才算已到账。
// 没有银行流水接口，所以到账只能人工登记（日期、金额、收款账户末四位、备注）；登记后可以改正，改正带版本号，别人先改了会提示。
// 币种不同不比较金额；差额 = 登记 − 报告，容差 0.05（我们定的）以内算一致。

function ConfirmAction({ row, onDone }: { row: DisbursementRow; onDone: () => void }) {
  const confirm = useApiMutation<Record<string, unknown>>({ method: 'POST', path: '/finance/disbursements/confirm', invalidate: ['list'], silent: true })
  const saved = row.registered
  return (
    <FormAction
      label={saved ? '改正' : '登记到账'}
      buttonProps={{ size: 'small', type: 'link' }}
      guard={{ permission: CASHFLOW_CONFIRM }}
      title={saved ? `改正到账登记：${row.externalSettlementId}` : `登记到账：${row.externalSettlementId}`}
      description={
        <>
          结算报告上的打款金额是 {money(row.expectedAmount, row.currency)}（{row.expectedDate ?? '没有打款日'}）。请按银行流水填写实际到账的日期与金额；币种固定为 {row.currency}。
          {saved ? ' 这条已有登记，保存会覆盖它，原值留在变更记录里。' : ''}
        </>
      }
      initialValues={{ disbursedAt: saved?.disbursedAt ?? row.expectedDate ?? '', amount: saved?.amount ?? row.expectedAmount, bankLast4: saved?.bankLast4 ?? '', note: saved?.note ?? '' }}
      okText={saved ? '保存改正' : '登记'}
      successText="到账已登记"
      onDone={onDone}
      onSubmit={values =>
        confirm.mutateAsync({
          settlementId: row.settlementId,
          disbursedAt: String(values.disbursedAt ?? ''),
          amount: Number(values.amount),
          currency: row.currency,
          ...(String(values.bankLast4 ?? '').trim() ? { bankLast4: String(values.bankLast4).trim() } : {}),
          ...(String(values.note ?? '').trim() ? { note: String(values.note).trim() } : {}),
          ...(saved ? { version: saved.version } : {}),
        })
      }
    >
      <Form.Item label="到账日期" name="disbursedAt" rules={[{ required: true, pattern: /^\d{4}-\d{2}-\d{2}$/, message: '请填写到账日期（年-月-日）' }]}>
        <Input type="date" aria-label="到账日期" />
      </Form.Item>
      <Form.Item label={`到账金额（${row.currency}）`} name="amount" rules={[{ required: true, type: 'number', min: 0.01, message: '到账金额必须大于 0' }]}>
        <InputNumber aria-label="到账金额" style={{ width: '100%' }} min={0} precision={2} />
      </Form.Item>
      <Form.Item label="收款账户末四位（可选）" name="bankLast4" rules={[{ pattern: /^(\d{4})?$/, message: '请填四位数字' }]}>
        <Input aria-label="收款账户末四位" maxLength={4} inputMode="numeric" />
      </Form.Item>
      <Form.Item label="备注（可选）" name="note">
        <Input.TextArea aria-label="备注" rows={2} maxLength={DISBURSEMENT_NOTE_MAX} showCount />
      </Form.Item>
    </FormAction>
  )
}

export function DisbursementsSection({ data, onChanged }: { data: CashflowDisbursements; onChanged: () => void }) {
  const { summary } = data
  const done = useRef(onChanged)
  done.current = onChanged
  const columns = useMemo(() => disbursementColumns(row => <ConfirmAction row={row} onDone={() => done.current()} />), [])
  return (
    <Card size="small" title="到账核对" style={{ marginTop: 16 }} data-testid="cashflow-disbursements">
      <p style={{ margin: '0 0 8px' }} data-testid="disbursement-summary">
        最近 <span className="erp-num">{summary.total}</span> 张有打款的结算单：已到账且一致 <span className="erp-num">{summary.matched}</span>，金额或币种对不上{' '}
        <span className="erp-num">{summary.mismatched}</span>，等待登记 <span className="erp-num">{summary.awaiting}</span>，超期未登记 <span className="erp-num">{summary.unregistered}</span>
      </p>
      <LocalGrid<DisbursementRow>
        gridId="finance.cashflow.disbursements"
        columns={columns}
        rows={data.items}
        getRowId={row => row.settlementId}
        height={480}
        emptyState={{ kind: 'empty', domain: '到账核对', prerequisite: '尚无带打款金额的结算单；结算报告同步后显示。' }}
      />
      {data.truncated ? <Alert type="info" showIcon style={{ marginTop: 8 }} message="只列出最近的结算单；更早的请在结算交易页查看。" /> : null}
      <p style={{ margin: '8px 0 0', color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>没有银行流水接口，到账只能人工登记；登记与改正都会留审计记录。</p>
    </Card>
  )
}
