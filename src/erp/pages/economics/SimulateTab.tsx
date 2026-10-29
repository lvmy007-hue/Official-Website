import { useState } from 'react'
import { Alert, Button, Card, Descriptions, Form, Input, InputNumber, Radio, Select, Space, Tag } from 'antd'
import { ECONOMICS_SIM_ACTIONS, ECONOMICS_SIM_ACTION_LABEL, ECONOMICS_SIM_MAX_DAYS, type EconomicsSimAction, type EconomicsSimulation, type EconomicsSimulateBody } from '@nova/api-contracts'
import { formatNumber } from '../../format'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import type { ScopeOptions } from '../../shell/ScopeBar'
import { Muted } from '../inventory/inventory-ui'
import { plainMoney } from './economics-ui'

// 情景模拟（07 章 7.10 第 3 个页签）：向亚马逊数据中心提交“如果把这个 SKU 发往上游仓储（AWD）或原包装发货（SIPP），官方估算的销售额、费用、净收益”。
// 结果是异步的（排队 → 完成/失败），页面每 5 秒轮询。官方只给出该动作下的估算，没有给“不做该动作”的对照，所以页面不推算“省了多少钱”。

const POLL_MS = 5000
const STATUS_LABEL = { PENDING: '排队中', DONE: '已完成', FAILED: '失败' } as const
const STATUS_COLOR = { PENDING: 'processing', DONE: 'success', FAILED: 'error' } as const

type FormValues = { sellerAccountId: string; sku: string; actionType: EconomicsSimAction; quantity?: number; itemPrice?: number; endInDays: number }

function RunCard({ initial }: { initial: EconomicsSimulation }) {
  const query = useApiQuery<EconomicsSimulation>({
    domain: 'list',
    path: `/finance/economics/simulations/${initial.runId}`,
    scoped: false,
    enabled: initial.status === 'PENDING',
    refetchIntervalMs: data => (data && data.status !== 'PENDING' ? false : POLL_MS),
  })
  const run = query.data ?? initial
  const { input, result } = run
  return (
    <Card size="small" style={{ marginTop: 8 }} data-testid="economics-run">
      <Space wrap style={{ marginBottom: 8 }}>
        <Tag color={STATUS_COLOR[run.status]} bordered={false}>
          {STATUS_LABEL[run.status]}
        </Tag>
        <span className="erp-num">{input.sku}</span>
        <span>{ECONOMICS_SIM_ACTION_LABEL[input.actionType]}</span>
        {input.quantity === null ? null : <span>数量 {formatNumber(input.quantity, { digits: 0 })}</span>}
        <span>{input.itemPrice === null ? '单价取商品当前价格' : `单价 ${input.itemPrice}`}</span>
        <span className="erp-num">{`${input.startDate} 至 ${input.endDate}`}</span>
      </Space>
      {run.status === 'DONE' && result ? (
        <Descriptions size="small" column={4} data-testid="economics-run-result">
          <Descriptions.Item label="销售额">{plainMoney(result.sales)}</Descriptions.Item>
          <Descriptions.Item label="费用">{plainMoney(result.fees)}</Descriptions.Item>
          <Descriptions.Item label="净收益">{plainMoney(result.netProceeds, <Muted>官方未提供</Muted>)}</Descriptions.Item>
          <Descriptions.Item label="件数">{result.units === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(result.units, { digits: 0 })}</span>}</Descriptions.Item>
        </Descriptions>
      ) : null}
      {run.status === 'DONE' && !result ? <Alert type="info" showIcon message="官方没有返回这次模拟的结果" /> : null}
      {run.note ? <Alert type={run.status === 'FAILED' ? 'error' : 'info'} showIcon message={run.note} /> : null}
    </Card>
  )
}

export function SimulateTab() {
  const [form] = Form.useForm<FormValues>()
  const [runs, setRuns] = useState<EconomicsSimulation[]>([])
  const action = Form.useWatch('actionType', form) ?? 'AWD'
  const options = useApiQuery<ScopeOptions>({ domain: 'reference', path: '/scope/options', scoped: false })
  const submit = useApiMutation<EconomicsSimulateBody, EconomicsSimulation>({
    method: 'POST',
    path: '/finance/economics/simulate',
    onSuccess: run => setRuns(current => [run, ...current].slice(0, 10)),
  })
  const stores = options.data?.stores ?? []
  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ margin: '8px 0' }}
        message="这里提交的是官方估算，不会改动任何库存或订单。官方只给出所选动作下的估算值，没有“不做该动作”的对照，所以不据此推算节省了多少钱。"
      />
      <Form<FormValues>
        form={form}
        layout="inline"
        initialValues={{ actionType: 'AWD', endInDays: 30 }}
        onFinish={values =>
          submit.mutate({
            sellerAccountId: values.sellerAccountId,
            sku: values.sku.trim(),
            actionType: values.actionType,
            quantity: values.actionType === 'AWD' ? values.quantity : undefined,
            itemPrice: values.itemPrice ?? undefined,
            endInDays: values.endInDays,
          })
        }
        style={{ rowGap: 8 }}
      >
        <Form.Item name="sellerAccountId" rules={[{ required: true, message: '请选择店铺' }]}>
          <Select style={{ width: 200 }} placeholder="选择店铺" aria-label="模拟店铺" options={stores.map(store => ({ value: store.id, label: store.name }))} />
        </Form.Item>
        <Form.Item name="sku" rules={[{ required: true, whitespace: true, message: '请输入 SKU' }]}>
          <Input style={{ width: 200 }} placeholder="SKU" aria-label="SKU" maxLength={200} />
        </Form.Item>
        <Form.Item name="actionType">
          <Radio.Group
            optionType="button"
            options={ECONOMICS_SIM_ACTIONS.map(value => ({ value, label: ECONOMICS_SIM_ACTION_LABEL[value] }))}
            onChange={() => form.setFieldValue('quantity', undefined)}
          />
        </Form.Item>
        {action === 'AWD' ? (
          <Form.Item name="quantity" rules={[{ required: true, message: '发往上游仓储需要填写数量' }]}>
            <InputNumber style={{ width: 140 }} min={1} precision={0} placeholder="数量" aria-label="数量" />
          </Form.Item>
        ) : null}
        <Form.Item name="itemPrice">
          <InputNumber style={{ width: 150 }} min={0.01} precision={2} placeholder="单价（可不填）" aria-label="单价" />
        </Form.Item>
        <Form.Item name="endInDays" label="模拟天数">
          <InputNumber style={{ width: 90 }} min={1} max={ECONOMICS_SIM_MAX_DAYS} precision={0} aria-label="模拟天数" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={submit.isPending}>
            提交模拟
          </Button>
        </Form.Item>
      </Form>
      {submit.error ? <Alert type="error" showIcon style={{ marginTop: 8 }} message={submit.error.message} /> : null}
      {runs.length === 0 ? <p style={{ marginTop: 16, color: 'rgba(0,0,0,0.45)' }}>本次打开页面后还没有提交过模拟；结果出来前会一直显示“排队中”。</p> : null}
      {runs.map(run => (
        <RunCard key={run.runId} initial={run} />
      ))}
    </div>
  )
}
