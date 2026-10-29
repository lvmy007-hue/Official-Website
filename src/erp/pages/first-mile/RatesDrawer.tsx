import { useCallback, useMemo, useState } from 'react'
import { Alert, Button, Drawer, Form, Input, InputNumber, Select, Space } from 'antd'
import { BILLING_MODES, BILLING_MODE_LABEL, type RateListResponse, type RateRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FormAction, PagedGrid, actionColumn, numberColumn, renderColumn, textColumn, type ErpColDef, type PageFetcher } from '../../components'
import { buildPath, useApiMutation } from '../../query/api-query'
import { money } from '../procurement/procurement-ui'
import type { CarrierGridRow } from './carriers-columns'

// 渠道阶梯报价抽屉（P6-26）：按目的地区与重量段（含下限、不含上限）列出单价，同一地区重量段与生效区间不能重叠。
// 单价属于成本字段，没有“成本可见”权限时显示“无权查看”；表格走服务端分页。

const guard = { permission: 'firstmile.write' }
const dateText = (value: unknown) => (typeof value === 'string' && value ? value : null)

type Vars = { path: string; method: 'POST' | 'PUT' | 'DELETE'; body?: Record<string, unknown> }

function RateItems() {
  return (
    <>
      <Form.Item label="目的地区" name="region" rules={[{ required: true, whitespace: true, message: '请填写目的地区' }]} extra="例如 US-West、EU；预估时按这个地区找报价">
        <Input aria-label="目的地区" maxLength={40} style={{ width: 200 }} />
      </Form.Item>
      <Space size={16} align="start">
        <Form.Item label="重量下限（公斤，含）" name="weightFrom" rules={[{ required: true, message: '请填写下限' }]}>
          <InputNumber aria-label="重量下限" min={0} style={{ width: 160 }} />
        </Form.Item>
        <Form.Item label="重量上限（公斤，不含）" name="weightTo" extra="留空表示不封顶">
          <InputNumber aria-label="重量上限" min={0} style={{ width: 160 }} />
        </Form.Item>
      </Space>
      <Space size={16} align="start">
        <Form.Item label="计费方式" name="billingMode" rules={[{ required: true, message: '请选择计费方式' }]}>
          <Select aria-label="计费方式" style={{ width: 160 }} options={BILLING_MODES.map(mode => ({ value: mode, label: BILLING_MODE_LABEL[mode] }))} />
        </Form.Item>
        <Form.Item label="单价" name="unitPrice" rules={[{ required: true, message: '请填写单价' }]}>
          <InputNumber aria-label="单价" min={0} style={{ width: 140 }} />
        </Form.Item>
        <Form.Item label="币种" name="currency" rules={[{ required: true, pattern: /^[A-Za-z]{3}$/, message: '三位字母，例如 USD' }]}>
          <Input aria-label="币种" maxLength={3} style={{ width: 90 }} />
        </Form.Item>
      </Space>
      <Space size={16} align="start">
        <Form.Item label="生效日" name="effectiveFrom" rules={[{ required: true, message: '请选择生效日' }]}>
          <Input aria-label="生效日" type="date" style={{ width: 170 }} />
        </Form.Item>
        <Form.Item label="截止日（选填）" name="effectiveTo" extra="留空表示长期有效">
          <Input aria-label="截止日" type="date" style={{ width: 170 }} />
        </Form.Item>
      </Space>
    </>
  )
}

const bodyOf = (values: Record<string, unknown>) => ({
  region: String(values.region ?? '').trim(),
  weightFrom: values.weightFrom,
  weightTo: values.weightTo ?? null,
  unitPrice: values.unitPrice,
  currency: String(values.currency ?? '')
    .trim()
    .toUpperCase(),
  billingMode: values.billingMode,
  effectiveFrom: dateText(values.effectiveFrom),
  effectiveTo: dateText(values.effectiveTo),
})

const initialOf = (row: RateRow) => ({
  region: row.region,
  weightFrom: row.weightFrom,
  weightTo: row.weightTo ?? undefined,
  unitPrice: row.unitPrice === undefined ? undefined : Number(row.unitPrice),
  currency: row.currency,
  billingMode: row.billingMode,
  effectiveFrom: row.effectiveFrom,
  effectiveTo: row.effectiveTo ?? '',
})

const weightText = (row: RateRow) => `${row.weightFrom} ≤ 重量${row.weightTo === null ? '' : ` < ${row.weightTo}`}`

export function RatesAction({ row, onChanged }: { row: CarrierGridRow; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>
        报价
      </Button>
      {open ? <RatesDrawer row={row} onClose={() => setOpen(false)} onChanged={onChanged} /> : null}
    </>
  )
}

function RatesDrawer({ row, onClose, onChanged }: { row: CarrierGridRow; onClose: () => void; onChanged: () => void }) {
  const base = `/first-mile/carriers/${encodeURIComponent(row.carrierId)}/channels/${encodeURIComponent(row.id)}/rates`
  const [version, setVersion] = useState(0)
  const [blocked, setBlocked] = useState<string | null>(null)
  const write = useApiMutation<Vars, unknown>({ method: 'POST', path: variables => variables.path, body: variables => variables.body, invalidate: ['list'], silent: true })
  const refresh = useCallback(() => {
    setVersion(current => current + 1)
    onChanged()
  }, [onChanged])

  const fetchPage = useCallback<PageFetcher<RateRow>>(
    async ({ page, pageSize, signal }) => {
      const response = await apiFetch<RateListResponse>(buildPath(base, { page, pageSize }), { signal })
      setBlocked(response.items.length > 0 && response.items.every(item => item.unitPrice === undefined) ? '你没有“成本可见”权限，单价不显示。' : null)
      return { items: response.items, total: response.total }
    },
    [base],
  )

  const columns = useMemo<ErpColDef<RateRow>[]>(
    () => [
      textColumn<RateRow>('目的地区', 'region', { width: 130, pin: 'left', sortable: false }),
      renderColumn<RateRow>('重量段（公斤）', 'weightFrom', item => <span className="erp-num">{weightText(item)}</span>, { width: 170, sortable: false }),
      renderColumn<RateRow>('计费方式', 'billingMode', item => <span>{item.billingModeLabel}</span>, { width: 110, sortable: false }),
      renderColumn<RateRow>('单价', 'unitPrice', item => money(item.unitPrice ?? undefined, item.currency), { width: 120, sortable: false }),
      textColumn<RateRow>('币种', 'currency', { width: 80, sortable: false }),
      renderColumn<RateRow>(
        '生效区间',
        'effectiveFrom',
        item => (
          <span className="erp-num">
            {item.effectiveFrom} ~ {item.effectiveTo ?? '长期'}
          </span>
        ),
        { width: 210, sortable: false },
      ),
      numberColumn<RateRow>('版本', 'version', { width: 70, digits: 0, sortable: false }),
      actionColumn<RateRow>(
        item => (
          <Space size={4}>
            <FormAction
              label="编辑"
              guard={guard}
              title={`编辑报价（${item.region}，${weightText(item)}）`}
              okText="保存修改"
              successText="已保存修改"
              width={560}
              buttonProps={{ size: 'small' }}
              initialValues={initialOf(item)}
              onSubmit={values => write.mutateAsync({ path: `${base}/${encodeURIComponent(item.id)}`, method: 'PUT', body: { version: item.version, ...bodyOf(values) } })}
              onDone={refresh}
            >
              <RateItems />
            </FormAction>
            <FormAction
              label="删除"
              guard={guard}
              title={`删除报价（${item.region}，${weightText(item)}）`}
              description="删除后不能恢复；已经采用这条报价预估的运单不受影响。"
              okText="删除"
              successText="已删除"
              danger
              buttonProps={{ size: 'small' }}
              onSubmit={() => write.mutateAsync({ path: `${base}/${encodeURIComponent(item.id)}`, method: 'DELETE' })}
              onDone={refresh}
            />
          </Space>
        ),
        { width: 150 },
      ),
    ],
    [base, write, refresh],
  )

  return (
    <Drawer
      open
      title={`${row.name} 的阶梯报价`}
      width={960}
      onClose={onClose}
      destroyOnClose
      extra={
        <FormAction
          label="新增报价"
          guard={guard}
          title="新增阶梯报价"
          description="同一地区的重量段与生效区间不能和已有报价重叠；上一档的上限填成下一档的下限即可首尾相接。"
          okText="保存"
          successText="已新增报价"
          width={560}
          buttonProps={{ type: 'primary' }}
          initialValues={{ billingMode: 'PER_KG', currency: 'USD', weightFrom: 0 }}
          onSubmit={values => write.mutateAsync({ path: base, method: 'POST', body: bodyOf(values) })}
          onDone={refresh}
        >
          <RateItems />
        </FormAction>
      }
    >
      {blocked ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={blocked} /> : null}
      <PagedGrid<RateRow>
        gridId="first-mile.carrier-rates"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={item => item.id}
        resetKey={JSON.stringify([base, version])}
        emptyState={{ kind: 'empty', domain: '渠道报价', prerequisite: '这个渠道还没有报价。点右上角“新增报价”按目的地区与重量段录入；没有报价时头程预估会明确提示，不会按 0 计算。' }}
        height={480}
      />
    </Drawer>
  )
}
