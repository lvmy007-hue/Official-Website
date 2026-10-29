import { useState } from 'react'
import { Alert, Form, Input, InputNumber, Modal, Select, Space, Switch, Tag } from 'antd'
import {
  GUARDRAIL_SCOPES,
  GUARDRAIL_SCOPE_LABEL,
  GUARDRAIL_SPECIFICITY,
  PRICING_RULE_WRITE,
  type GuardrailListResponse,
  type GuardrailScope,
  type GuardrailView,
  type PricingWriteStatuses,
} from '@nova/api-contracts'
import { ActionGuard, SimpleGrid } from '../../components'
import { formatDateTime, formatMoney, formatPercent } from '../../format'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { guardOf } from './pricing-state'

// 价格护栏（P4-11）：给店铺、类目、ASIN 或 SKU 设置最低价、最高价、最低利润率与单次调幅上限。
// 手工改价与规则执行都要先过护栏，服务端再核一遍；同一个限制有多层时，越具体的优先（SKU > ASIN > 类目 > 店铺）。

interface FormValues {
  storeId: string
  scope: GuardrailScope
  scopeRef: string
  minPrice: number | null
  maxPrice: number | null
  minMarginPct: number | null
  maxChangePct: number | null
  enabled: boolean
}

const toPercent = (value: number | null) => (value === null ? null : Math.round(value * 10_000) / 100)
const fromPercent = (value: number | null | undefined) => (value === null || value === undefined ? null : Math.round(value * 100) / 10_000)
const blank = (storeId: string): FormValues => ({ storeId, scope: 'STORE', scopeRef: '', minPrice: null, maxPrice: null, minMarginPct: null, maxChangePct: null, enabled: true })
const valuesOf = (row: GuardrailView): FormValues => ({
  storeId: row.storeId,
  scope: row.scope,
  scopeRef: row.scopeRef,
  minPrice: row.minPrice,
  maxPrice: row.maxPrice,
  minMarginPct: toPercent(row.minMarginPct),
  maxChangePct: toPercent(row.maxChangePct),
  enabled: row.enabled,
})

function GuardrailModal({ editing, stores, onClose }: { editing: GuardrailView | 'new' | null; stores: Array<{ id: string; name: string }>; onClose: () => void }) {
  const [form] = Form.useForm<FormValues>()
  const [error, setError] = useState<string | null>(null)
  const save = useApiMutation<Record<string, unknown>>({ method: 'PUT', path: '/pricing/guardrails', invalidate: ['list', 'analytics', 'config'], silent: true })
  const scope = Form.useWatch('scope', form)
  const isNew = editing === 'new'
  const initial = editing && editing !== 'new' ? valuesOf(editing) : blank(stores[0]?.id ?? '')

  const submit = async () => {
    setError(null)
    const values = form.getFieldsValue(true) as FormValues
    try {
      await save.mutateAsync({
        storeId: values.storeId,
        scope: values.scope,
        scopeRef: values.scope === 'STORE' ? '' : (values.scopeRef ?? '').trim(),
        minPrice: values.minPrice,
        maxPrice: values.maxPrice,
        minMarginPct: fromPercent(values.minMarginPct),
        maxChangePct: fromPercent(values.maxChangePct),
        enabled: values.enabled,
        ...(editing && editing !== 'new' ? { expectedVersion: editing.version } : {}),
      })
      onClose()
    } catch (failure) {
      const info = describeError(failure)
      setError(info.requestId ? `${info.message}（请求编号 ${info.requestId}）` : info.message)
    }
  }

  return (
    <Modal
      open={editing !== null}
      onCancel={onClose}
      destroyOnClose
      title={isNew ? '新增价格护栏' : '修改价格护栏'}
      okText="保存"
      cancelText="取消"
      confirmLoading={save.isPending}
      onOk={() => void submit()}
    >
      <Form<FormValues> form={form} layout="vertical" requiredMark={false} initialValues={initial} preserve={false}>
        <Form.Item label="店铺" name="storeId">
          <Select aria-label="店铺" disabled={!isNew} options={stores.map(store => ({ value: store.id, label: store.name }))} />
        </Form.Item>
        <Form.Item label="适用范围" name="scope">
          <Select aria-label="适用范围" disabled={!isNew} options={GUARDRAIL_SCOPES.map(value => ({ value, label: GUARDRAIL_SCOPE_LABEL[value] }))} />
        </Form.Item>
        {scope && scope !== 'STORE' ? (
          <Form.Item label={scope === 'CATEGORY' ? '类目名称' : scope === 'ASIN' ? 'ASIN' : 'SKU'} name="scopeRef">
            <Input aria-label="适用对象" disabled={!isNew} maxLength={200} />
          </Form.Item>
        ) : null}
        <Space wrap align="start">
          <Form.Item label="最低价" name="minPrice">
            <InputNumber aria-label="最低价" min={0} max={100_000} precision={2} style={{ width: 150 }} />
          </Form.Item>
          <Form.Item label="最高价" name="maxPrice">
            <InputNumber aria-label="最高价" min={0} max={100_000} precision={2} style={{ width: 150 }} />
          </Form.Item>
          <Form.Item label="最低利润率（%）" name="minMarginPct">
            <InputNumber aria-label="最低利润率" min={0} max={95} precision={1} style={{ width: 150 }} />
          </Form.Item>
          <Form.Item label="单次调幅上限（%）" name="maxChangePct">
            <InputNumber aria-label="单次调幅上限" min={0} max={100} precision={1} style={{ width: 150 }} />
          </Form.Item>
        </Space>
        <Form.Item label="启用" name="enabled" valuePropName="checked">
          <Switch aria-label="启用" />
        </Form.Item>
        {error ? <Alert type="error" showIcon role="alert" message={error} /> : null}
      </Form>
    </Modal>
  )
}

export function GuardrailPanel({ write, stores }: { write: PricingWriteStatuses | undefined; stores: Array<{ id: string; name: string }> }) {
  const [editing, setEditing] = useState<GuardrailView | 'new' | null>(null)
  const query = useApiQuery<GuardrailListResponse>({ domain: 'list', path: '/pricing/guardrails', scoped: false })
  const guard = guardOf(PRICING_RULE_WRITE, write?.rule)
  const items = query.data?.items
  const limit = (value: number | null, render: (n: number) => string) => (value === null ? <Muted>不限</Muted> : <span className="erp-num">{render(value)}</span>)

  return (
    <div data-testid="pricing-guardrails">
      <Space style={{ marginBottom: 8 }} wrap>
        <ActionGuard label="新增护栏" guard={guard} onExecute={async () => setEditing('new')} buttonProps={{ type: 'primary' }} />
        <span style={{ color: 'rgba(0,0,0,0.45)' }}>优先级：{GUARDRAIL_SPECIFICITY.map(value => GUARDRAIL_SCOPE_LABEL[value]).join(' > ')}（越具体越优先）</span>
      </Space>
      {query.data?.truncated ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="护栏数量很多，只显示了前 2000 条" /> : null}
      <SimpleGrid<GuardrailView>
        gridId="pricing.guardrail-panel"
        rows={items}
        rowKey={row => row.id}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '价格护栏', prerequisite: '还没有设置护栏；新增后，改价与规则执行都会先按护栏检查。' }}
        columns={[
          { title: '店铺', dataIndex: 'storeName', width: 140 },
          { title: '范围', key: 'scope', width: 220, render: (_v, row) => (row.scope === 'STORE' ? GUARDRAIL_SCOPE_LABEL.STORE : `${GUARDRAIL_SCOPE_LABEL[row.scope]}：${row.scopeRef}`) },
          { title: '最低价', key: 'min', width: 100, render: (_v, row) => limit(row.minPrice, n => formatMoney(n, 'USD', { digits: 2 })) },
          { title: '最高价', key: 'max', width: 100, render: (_v, row) => limit(row.maxPrice, n => formatMoney(n, 'USD', { digits: 2 })) },
          { title: '最低利润率', key: 'margin', width: 110, render: (_v, row) => limit(row.minMarginPct, n => formatPercent(n, { digits: 1 })) },
          { title: '单次调幅上限', key: 'step', width: 120, render: (_v, row) => limit(row.maxChangePct, n => formatPercent(n, { digits: 1 })) },
          { title: '状态', key: 'enabled', width: 80, render: (_v, row) => <Tag color={row.enabled ? 'success' : 'default'}>{row.enabled ? '启用' : '停用'}</Tag> },
          { title: '更新时间', key: 'updatedAt', width: 160, render: (_v, row) => formatDateTime(row.updatedAt) },
          {
            title: '操作',
            key: 'actions',
            width: 80,
            render: (_v, row) => <ActionGuard label="修改" guard={guard} onExecute={async () => setEditing(row)} buttonProps={{ type: 'link', size: 'small' }} />,
          },
        ]}
      />
      <GuardrailModal key={editing === null ? 'closed' : editing === 'new' ? 'new' : editing.id} editing={editing} stores={stores} onClose={() => setEditing(null)} />
    </div>
  )
}
