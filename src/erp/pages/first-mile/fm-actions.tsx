import { useRef } from 'react'
import { Alert, App, Button, Form, Input, InputNumber, Select, Space, Typography } from 'antd'
import {
  ALLOCATION_METHOD_LABEL,
  ALLOCATION_METHODS,
  FIRST_MILE_COST_ITEMS,
  FIRST_MILE_COST_LABEL,
  MILESTONE_LABEL,
  MILESTONE_PRESETS,
  type AllocationMethod,
  type FirstMileActionResult,
  type FirstMileDetail,
  type MilestoneImportResponse,
} from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { optional } from '../procurement/procurement-ui'

// 头程运单详情上的动作。可用的动作由服务端算出（detail.actions），页面只负责显示；每次写入都带页面看到的版本号：
// 别人先改了会提示刷新，不会覆盖。提交后以服务端结果为准，成功才提示。

const WRITE = 'firstmile.write'

type Call = { suffix: string; body?: Record<string, unknown> }

export function useFmCalls(id: string) {
  const base = `/first-mile/${encodeURIComponent(id)}`
  const post = useApiMutation<Call, FirstMileActionResult & Partial<MilestoneImportResponse>>({
    method: 'POST',
    path: call => `${base}/${call.suffix}`,
    body: call => call.body ?? {},
    invalidate: ['list', 'reference'],
    silent: true,
  })
  const del = useApiMutation<Call, FirstMileActionResult>({ method: 'DELETE', path: call => `${base}/${call.suffix}`, body: () => undefined, invalidate: ['list', 'reference'], silent: true })
  return { post, del }
}

const toIso = (local: unknown) => (typeof local === 'string' && local ? new Date(local).toISOString() : undefined)

export function AddMilestoneAction({ detail }: { detail: FirstMileDetail }) {
  const { post } = useFmCalls(detail.shipment.id)
  return (
    <FormAction
      label="录入节点"
      guard={{ permission: WRITE, condition: { ok: detail.actions.includes('ADD_MILESTONE'), reason: '当前不能录入节点' } }}
      title="录入物流节点"
      description="节点时间不能晚于今天；同一节点同一时间只能录一次。货代给了文件时，用“导入货代文件”更省事。"
      initialValues={{ milestone: 'DEPARTED' }}
      okText="录入"
      successText="节点已录入"
      onSubmit={values =>
        post.mutateAsync({
          suffix: 'milestones',
          body: {
            version: detail.shipment.version,
            milestone: values.milestone,
            occurredAt: toIso(values.occurredAt),
            location: optional(values.location) ?? null,
            note: optional(values.note) ?? null,
          },
        })
      }
    >
      <Form.Item label="节点" name="milestone" rules={[{ required: true, message: '请选择节点' }]}>
        <Select aria-label="节点" options={MILESTONE_PRESETS.map(value => ({ value, label: MILESTONE_LABEL[value] }))} style={{ width: 200 }} />
      </Form.Item>
      <Form.Item label="发生时间" name="occurredAt" rules={[{ required: true, message: '请填写发生时间' }]}>
        <Input type="datetime-local" aria-label="发生时间" />
      </Form.Item>
      <Form.Item label="地点（选填）" name="location">
        <Input aria-label="地点" maxLength={80} />
      </Form.Item>
      <Form.Item label="备注（选填）" name="note">
        <Input aria-label="备注" maxLength={300} />
      </Form.Item>
    </FormAction>
  )
}

/** 选一个货代给的 CSV 或制表符文件，读成文本填进表单；也可以直接粘贴。 */
function ImportFields() {
  const form = Form.useFormInstance()
  const input = useRef<HTMLInputElement>(null)
  const pick = async (file: File) => {
    form.setFieldsValue({ fileName: file.name, content: await file.text() })
  }
  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="文件第一行是表头，需要列：头程单号、节点、发生时间（YYYY-MM-DD 或 YYYY-MM-DD HH:mm，不带时区按北京时间），可选：地点、备注。头程单号必须是本运单的运单号；有一行不对就整份不导入。"
      />
      <input ref={input} type="file" hidden accept=".csv,.tsv,.txt" aria-label="选择货代文件" onChange={event => event.target.files?.[0] && void pick(event.target.files[0])} />
      <Button onClick={() => input.current?.click()}>选择文件</Button>
      <Form.Item label="文件名" name="fileName" rules={[{ required: true, whitespace: true, message: '请选择文件或填写文件名' }]} style={{ marginTop: 12 }}>
        <Input aria-label="文件名" maxLength={200} />
      </Form.Item>
      <Form.Item label="文件内容" name="content" rules={[{ required: true, message: '请选择文件或粘贴内容' }]}>
        <Input.TextArea aria-label="文件内容" rows={8} />
      </Form.Item>
    </>
  )
}

export function ImportMilestonesAction({ detail }: { detail: FirstMileDetail }) {
  const { post } = useFmCalls(detail.shipment.id)
  const { message } = App.useApp()
  return (
    <FormAction
      label="导入货代文件"
      guard={{ permission: WRITE, condition: { ok: detail.actions.includes('ADD_MILESTONE'), reason: '当前不能导入节点' } }}
      title="导入货代节点文件"
      okText="导入"
      onSubmit={async values => {
        const result = await post.mutateAsync({
          suffix: 'milestones/import',
          body: { version: detail.shipment.version, fileName: String(values.fileName ?? '').trim(), content: String(values.content ?? '') },
        })
        void message.success(`导入 ${result.imported ?? 0} 条节点，跳过重复 ${result.skippedDuplicates ?? 0} 条`)
        return result
      }}
    >
      <ImportFields />
    </FormAction>
  )
}

export function AddCostAction({ detail }: { detail: FirstMileDetail }) {
  const { post } = useFmCalls(detail.shipment.id)
  return (
    <FormAction
      label="录入费用"
      guard={{ permission: WRITE, condition: { ok: detail.actions.includes('ADD_COST'), reason: '费用已分摊，要录入新费用请先撤销分摊' } }}
      title="录入头程费用"
      description={<Typography.Text type="secondary">币种与运单一致（{detail.shipment.currency}）；金额必须大于 0。</Typography.Text>}
      initialValues={{ item: 'FREIGHT' }}
      okText="录入"
      successText="费用已录入"
      onSubmit={values =>
        post.mutateAsync({ suffix: 'costs', body: { version: detail.shipment.version, item: values.item, amount: values.amount, incurredAt: values.incurredAt, note: optional(values.note) ?? null } })
      }
    >
      <Form.Item label="费用项" name="item" rules={[{ required: true, message: '请选择费用项' }]}>
        <Select aria-label="费用项" options={FIRST_MILE_COST_ITEMS.map(value => ({ value, label: FIRST_MILE_COST_LABEL[value] }))} style={{ width: 200 }} />
      </Form.Item>
      <Form.Item label="金额" name="amount" rules={[{ required: true, message: '请填写金额' }]}>
        <InputNumber aria-label="金额" min={0.01} style={{ width: 200 }} />
      </Form.Item>
      <Form.Item label="发生日期" name="incurredAt" rules={[{ required: true, message: '请填写发生日期' }]}>
        <Input type="date" aria-label="发生日期" />
      </Form.Item>
      <Form.Item label="备注（选填）" name="note">
        <Input aria-label="备注" maxLength={300} />
      </Form.Item>
    </FormAction>
  )
}

export function AllocateAction({ detail }: { detail: FirstMileDetail }) {
  const { post } = useFmCalls(detail.shipment.id)
  const ready = detail.allocationReady
  return (
    <FormAction
      label="费用分摊"
      guard={{ permission: WRITE, condition: { ok: detail.actions.includes('ALLOCATE'), reason: detail.actions.includes('UNALLOCATE') ? '已经分摊，要重新分摊请先撤销' : '需要先录入费用' } }}
      title="分摊头程费用到 SKU"
      description={
        <Alert
          type="info"
          showIcon
          message="费用合计按所选口径分摊到每个 SKU，并为每个 SKU 生成一条“成本版本草稿”（单位头程成本）；草稿要到商品成本页面确认后才生效。分摊后费用与明细锁定，撤销分摊会删除这些草稿。"
        />
      }
      initialValues={{ method: 'VOLUME' }}
      okText="分摊"
      successText="已分摊"
      onSubmit={values => post.mutateAsync({ suffix: 'allocate', body: { version: detail.shipment.version, method: values.method } })}
    >
      <Form.Item label="分摊口径" name="method" rules={[{ required: true, message: '请选择口径' }]}>
        <Select
          aria-label="分摊口径"
          style={{ width: 260 }}
          options={ALLOCATION_METHODS.map((value: AllocationMethod) => ({
            value,
            label: ready?.[value] ? `${ALLOCATION_METHOD_LABEL[value]}（${ready[value]}）` : ALLOCATION_METHOD_LABEL[value],
            disabled: Boolean(ready?.[value]),
          }))}
        />
      </Form.Item>
    </FormAction>
  )
}

export function RevertAction({ detail }: { detail: FirstMileDetail }) {
  const { del } = useFmCalls(detail.shipment.id)
  return (
    <FormAction
      label="撤销分摊"
      danger
      guard={{ permission: WRITE, condition: { ok: detail.actions.includes('UNALLOCATE'), reason: '这张运单还没有分摊' } }}
      title="撤销费用分摊"
      description="撤销会删除这次分摊生成的成本版本草稿；如果其中有成本版本已经生效，不能撤销，需要到商品成本页面处理。"
      okText="撤销"
      successText="已撤销分摊"
      onSubmit={() => del.mutateAsync({ suffix: `allocation?version=${detail.shipment.version}` })}
    />
  )
}

export function OutboundAction({ detail }: { detail: FirstMileDetail }) {
  const { post } = useFmCalls(detail.shipment.id)
  const reason = detail.shipment.outboundAt ? '这张运单已经出库' : !detail.shipment.warehouseId ? '没有选择出库的国内仓，请先编辑运单选择仓库' : '当前不能出库'
  return (
    <FormAction
      label="出库"
      guard={{ permission: WRITE, condition: { ok: detail.actions.includes('OUTBOUND'), reason } }}
      title="国内仓出库"
      description={
        <Space direction="vertical">
          <span>按运单明细在“{detail.shipment.warehouseName ?? '国内仓'}”记头程发货出库流水（库存减少）。</span>
          <span>任何一个 SKU 的可用库存不够，整张都不出库。</span>
        </Space>
      }
      okText="出库"
      successText="已出库"
      onSubmit={values => post.mutateAsync({ suffix: 'outbound', body: { version: detail.shipment.version, ...(optional(values.outboundAt) ? { outboundAt: optional(values.outboundAt) } : {}) } })}
    >
      <Form.Item label="出库日期（不填为今天）" name="outboundAt">
        <Input type="date" aria-label="出库日期" />
      </Form.Item>
    </FormAction>
  )
}
