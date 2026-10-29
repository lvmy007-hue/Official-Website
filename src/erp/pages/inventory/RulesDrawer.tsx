import { Alert, Checkbox, DatePicker, Descriptions, Drawer, Form, InputNumber, Select, Tag, Typography } from 'antd'
import { AGING_FROM_DAYS, INBOUND_KINDS, INBOUND_KIND_LABEL, type InboundKind, type InventoryPolicy, type InventoryPolicyResponse } from '@nova/api-contracts'
import { DataState, FormAction, stateFromError, SimpleGrid } from '../../components'
import { formatDate } from '../../format'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'

// 库存规则抽屉（06 章 6.1“健康规则”）：当前生效版本、版本历史、保存新版本。
// 规则不使用固定阈值：没有配置过时所有参数留空，由有权限的人填写；每次保存新增一个版本（旧版本不改），原因必填。

export const WRITE = 'replenishment.policy.write'

type Vars = { expectedVersionNo: number } & Record<string, unknown>

function PolicyFields() {
  return (
    <>
      <Form.Item label="补货提前期（天）" name="leadTimeDays" rules={[{ required: true, message: '请输入提前期' }]} extra="从下采购单到货物可售的总天数（采购链）">
        <InputNumber min={1} max={365} precision={0} style={{ width: 200 }} />
      </Form.Item>
      <Form.Item label="上游仓储调拨时效（天）" name="awdLeadTimeDays" extra="选填：上游仓储（AWD）有货时补到 FBA 的天数；没有就留空">
        <InputNumber min={1} max={365} precision={0} style={{ width: 200 }} />
      </Form.Item>
      <Form.Item label="安全库存（天）" name="safetyDays" rules={[{ required: true, message: '请输入安全库存天数' }]}>
        <InputNumber min={0} max={365} precision={0} style={{ width: 200 }} />
      </Form.Item>
      <Form.Item label="目标覆盖（天）" name="coverageDays" rules={[{ required: true, message: '请输入目标覆盖天数' }]}>
        <InputNumber min={1} max={730} precision={0} style={{ width: 200 }} />
      </Form.Item>
      <Form.Item label="冗余倍数" name="redundancyMultiplier" rules={[{ required: true, message: '请输入冗余倍数' }]} extra="覆盖天数超过 目标覆盖 × 倍数 判为冗余">
        <InputNumber min={1} max={10} step={0.1} precision={2} style={{ width: 200 }} />
      </Form.Item>
      <Form.Item label="计入可售天数的在途" name="inboundCounted" extra="可以全不选，表示在途不计入可售天数">
        <Checkbox.Group options={INBOUND_KINDS.map(kind => ({ value: kind, label: INBOUND_KIND_LABEL[kind] }))} />
      </Form.Item>
      <Form.Item label="库龄风险起算（天）" name="agingFromDays" rules={[{ required: true, message: '请选择' }]}>
        <Select style={{ width: 200 }} options={AGING_FROM_DAYS.map(days => ({ value: days, label: `${days} 天起` }))} />
      </Form.Item>
      <Form.Item label="生效日期" name="effectiveFrom" extra="不填则今天起生效；最多提前一年，不能早于今天">
        <DatePicker allowClear />
      </Form.Item>
    </>
  )
}

const initialOf = (policy: InventoryPolicy | null) =>
  policy
    ? {
        leadTimeDays: policy.leadTimeDays,
        awdLeadTimeDays: policy.awdLeadTimeDays ?? undefined,
        safetyDays: policy.safetyDays,
        coverageDays: policy.coverageDays,
        redundancyMultiplier: policy.redundancyMultiplier,
        inboundCounted: policy.inboundCounted,
        agingFromDays: policy.agingFromDays,
      }
    : { inboundCounted: [] as InboundKind[] }

function PolicyView({ policy }: { policy: InventoryPolicy }) {
  return (
    <Descriptions size="small" column={1} bordered>
      <Descriptions.Item label="版本">
        第 {policy.versionNo} 版，{policy.effectiveFrom} 起生效
      </Descriptions.Item>
      <Descriptions.Item label="补货提前期">{policy.leadTimeDays} 天</Descriptions.Item>
      <Descriptions.Item label="上游仓储调拨时效">{policy.awdLeadTimeDays === null ? '未设置' : `${policy.awdLeadTimeDays} 天`}</Descriptions.Item>
      <Descriptions.Item label="安全库存">{policy.safetyDays} 天</Descriptions.Item>
      <Descriptions.Item label="目标覆盖">{policy.coverageDays} 天</Descriptions.Item>
      <Descriptions.Item label="冗余倍数">{policy.redundancyMultiplier}</Descriptions.Item>
      <Descriptions.Item label="计入的在途">{policy.inboundCounted.length ? policy.inboundCounted.map(kind => INBOUND_KIND_LABEL[kind]).join('、') : '不计入在途'}</Descriptions.Item>
      <Descriptions.Item label="库龄风险起算">{policy.agingFromDays} 天</Descriptions.Item>
      <Descriptions.Item label="设置人 / 原因">
        {policy.createdBy}：{policy.changeReason}
      </Descriptions.Item>
    </Descriptions>
  )
}

export function RulesDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rules = useApiQuery<InventoryPolicyResponse>({ domain: 'config', path: '/inventory/rules', scoped: false, enabled: open })
  const save = useApiMutation<Vars, unknown>({ method: 'PUT', path: '/inventory/rules', invalidate: ['config', 'list', 'analytics'], silent: true })
  const current = rules.data?.current ?? null
  const latestNo = rules.data?.history[0]?.versionNo ?? 0

  return (
    <Drawer open={open} onClose={onClose} width={560} title="库存规则" destroyOnClose>
      {rules.error ? <DataState {...stateFromError(describeError(rules.error), { onRetry: () => void rules.refetch() })} /> : null}
      {rules.isPending && !rules.error ? <DataState kind="skeleton" rows={6} /> : null}
      {rules.data ? (
        <>
          <Typography.Paragraph type="secondary">风险等级由这里的规则版本和近期销量算出，不使用固定阈值；每次保存都会新增一个版本，旧版本不会被改写。</Typography.Paragraph>
          {current ? <PolicyView policy={current} /> : <Alert type="info" showIcon message="尚未配置规则" description={rules.data.note ?? undefined} />}
          <div style={{ margin: '12px 0' }}>
            <FormAction
              label={current ? '保存新版本' : '设置规则'}
              guard={{ permission: WRITE }}
              title={current ? '保存新版本规则' : '设置库存规则'}
              reason={{ label: '调整原因', placeholder: '例如：旺季前把提前期调长' }}
              initialValues={initialOf(current)}
              okText="保存"
              successText="已保存新版本规则"
              onSubmit={values =>
                save.mutateAsync({
                  expectedVersionNo: latestNo,
                  leadTimeDays: Number(values.leadTimeDays),
                  awdLeadTimeDays: values.awdLeadTimeDays === undefined || values.awdLeadTimeDays === null ? null : Number(values.awdLeadTimeDays),
                  safetyDays: Number(values.safetyDays),
                  coverageDays: Number(values.coverageDays),
                  redundancyMultiplier: Number(values.redundancyMultiplier),
                  inboundCounted: values.inboundCounted,
                  agingFromDays: values.agingFromDays,
                  effectiveFrom: values.effectiveFrom ? (values.effectiveFrom as { format: (pattern: string) => string }).format('YYYY-MM-DD') : undefined,
                  changeReason: values.reason,
                })
              }
              onDone={() => void rules.refetch()}
            >
              <PolicyFields />
            </FormAction>
          </div>
          <Typography.Title level={5}>版本历史</Typography.Title>
          <SimpleGrid<InventoryPolicy>
            gridId="inventory.rules-drawer"
            columns={[
              {
                title: '版本',
                dataIndex: 'versionNo',
                width: 70,
                render: (value: number, row) => (
                  <>
                    {`第 ${value} 版`}
                    {row.versionNo === current?.versionNo ? (
                      <Tag color="success" bordered={false} style={{ marginLeft: 4 }}>
                        当前
                      </Tag>
                    ) : null}
                  </>
                ),
              },
              { title: '生效日期', dataIndex: 'effectiveFrom', width: 110 },
              { title: '设置人', dataIndex: 'createdBy', width: 90 },
              { title: '原因', dataIndex: 'changeReason' },
              { title: '保存时间', dataIndex: 'createdAt', width: 150, render: (value: string) => formatDate(value) },
            ]}
            rows={rules.data.history}
            rowKey={row => row.versionNo}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无版本' }}
          />
        </>
      ) : null}
    </Drawer>
  )
}
