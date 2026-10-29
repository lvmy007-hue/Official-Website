import { Alert, Form, InputNumber, Space, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { OPPORTUNITY_RULES, OPPORTUNITY_RULE_LABEL, isRuleConnected, type OpportunityRule, type ReimbursementStatsResponse } from '@nova/api-contracts'
import { FormAction, SimpleGrid } from '../../components'
import { useApiMutation } from '../../query/api-query'

// 机会时限设置：每类机会两个数字——等待期（先等亚马逊自己调查与自动赔付）与申请期限（过了就过期），都从该类机会的起算日算起。
// 默认值没有逐条对照亚马逊当期政策核实（只有入仓差异沿用 45 天与 540 天），页面如实写明；改动保存到企业设置，下一次扫描起生效，已识别的机会不回改。

const WRITE = 'settings.write'
type Row = { rule: OpportunityRule; waitDays: number; windowDays: number }

const columns: ColumnsType<Row> = [
  { title: '机会类型', dataIndex: 'rule', width: 140, render: (value: OpportunityRule) => OPPORTUNITY_RULE_LABEL[value] },
  { title: '等待期（天）', dataIndex: 'waitDays', width: 130, align: 'right', render: (value: number) => <span className="erp-num">{value}</span> },
  { title: '申请期限（天）', dataIndex: 'windowDays', width: 140, align: 'right', render: (value: number) => <span className="erp-num">{value}</span> },
  { title: '说明', key: 'note', render: (_value, row) => (isRuleConnected(row.rule) ? '' : '尚未接入，设置先保存') },
]

type Picked = Partial<Record<OpportunityRule, { waitDays?: number; windowDays?: number }>>

export function WindowsSettings({ stats }: { stats: ReimbursementStatsResponse }) {
  const save = useApiMutation<{ value: unknown; version: number; reason: string }>({ method: 'PUT', path: '/settings/preferences/reimbursement.windows', invalidate: ['analytics', 'list', 'config'] })
  const rows: Row[] = OPPORTUNITY_RULES.map(rule => ({ rule, ...stats.windows[rule] }))
  const initial = Object.fromEntries(OPPORTUNITY_RULES.map(rule => [rule, { ...stats.windows[rule] }]))

  return (
    <div data-testid="windows-settings">
      <Alert
        type={stats.windowsDefault ? 'warning' : 'info'}
        showIcon
        style={{ marginBottom: 8 }}
        message={stats.windowsDefault ? '当前使用系统默认时限：没有对照亚马逊当期政策逐条核实，请按你们实际适用的政策修改' : '当前使用企业自己保存的时限'}
        description="等待期内先等亚马逊自己调查与自动赔付，过了才算“可以申请”；超过申请期限的机会标为已过期。起算日：入仓差异＝货件关闭日；仓内丢失与损坏＝台账调整日；退款未退货＝第一笔退款入账日；退货处置异常＝退货日；移除丢失＝移除订单最近更新日。"
      />
      <Space style={{ marginBottom: 8 }}>
        <FormAction
          label="修改时限"
          buttonProps={{ type: 'primary' }}
          guard={{ permission: WRITE }}
          title="修改机会时限"
          description={<Typography.Text type="secondary">等待期不能长于申请期限；改动从下一次扫描起生效，已经识别的机会不回改。</Typography.Text>}
          initialValues={initial}
          reason={{ label: '修改原因', placeholder: '例如：按亚马逊最新政策把退款未退货的申请期限改为 105 天' }}
          okText="保存"
          successText="时限已保存"
          onSubmit={values =>
            save.mutateAsync({
              version: stats.windowsVersion,
              reason: String(values.reason ?? ''),
              value: Object.fromEntries(OPPORTUNITY_RULES.map(rule => [rule, { waitDays: (values as Picked)[rule]?.waitDays, windowDays: (values as Picked)[rule]?.windowDays }])),
            })
          }
        >
          {OPPORTUNITY_RULES.map(rule => (
            <Space key={rule} align="start" wrap>
              <Typography.Text style={{ display: 'inline-block', width: 110, paddingTop: 5 }}>{OPPORTUNITY_RULE_LABEL[rule]}</Typography.Text>
              <Form.Item name={[rule, 'waitDays']} rules={[{ required: true, message: '必填' }]} style={{ marginBottom: 8 }}>
                <InputNumber aria-label={`${OPPORTUNITY_RULE_LABEL[rule]}等待期`} addonBefore="等待" addonAfter="天" min={0} max={365} precision={0} style={{ width: 170 }} />
              </Form.Item>
              <Form.Item name={[rule, 'windowDays']} rules={[{ required: true, message: '必填' }]} style={{ marginBottom: 8 }}>
                <InputNumber aria-label={`${OPPORTUNITY_RULE_LABEL[rule]}申请期限`} addonBefore="期限" addonAfter="天" min={1} max={1095} precision={0} style={{ width: 180 }} />
              </Form.Item>
            </Space>
          ))}
        </FormAction>
      </Space>
      <SimpleGrid<Row> gridId="reimbursements.windows" columns={columns} rows={rows} rowKey={row => row.rule} emptyState={{ kind: 'empty', domain: '机会时限', prerequisite: '' }} />
    </div>
  )
}
