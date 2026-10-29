import { useState } from 'react'
import { Checkbox, Form, Input, InputNumber, Typography } from 'antd'
import {
  COST_COMPONENTS,
  COST_COMPONENT_COLUMN,
  COST_COMPONENT_LABEL,
  COST_IMPORT_COLUMNS,
  COST_IMPORT_MAX_BYTES,
  COST_IMPORT_MAX_ROWS,
  type CostImportResult,
  type CostVersionView,
  type CostWriteResult,
} from '@nova/api-contracts'
import { FormAction, type GuardInput } from '../../components'
import { useApiMutation } from '../../query/api-query'

// 商品成本的写入表单（P2b-14）：录入、改草稿、导入文件、丢弃、确认生效。权限 costs.write，并且需要“全部店铺”数据范围（成本在企业层面）。
// 提交只调服务端；服务端的字段错误（含导入文件的逐行错误，挂在 content 上）回填到表单。

export const COSTS_WRITE_PERMISSION = 'costs.write'
const SCOPE_REASON = '成本版本记在企业层面，会影响所有店铺的利润；需要“全部店铺”的数据范围才能录入、导入或确认生效'

export const writeGuard = (canWrite: boolean): GuardInput => ({ permission: COSTS_WRITE_PERMISSION, condition: { ok: canWrite, reason: SCOPE_REASON } })

type Picked = { fileName: string; content: string }

const readText = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file, 'utf-8')
  })

/** 表单里的文件选择：读出文本后把 {文件名, 内容} 交给表单。 */
function FileField({ value, onChange }: { value?: Picked; onChange?: (next: Picked | undefined) => void }) {
  const [error, setError] = useState<string | null>(null)
  return (
    <div>
      <input
        aria-label="成本文件"
        type="file"
        accept=".csv,.txt,text/csv,text/plain"
        onChange={async event => {
          const file = event.target.files?.[0]
          setError(null)
          if (!file) return onChange?.(undefined)
          if (file.size > COST_IMPORT_MAX_BYTES) {
            setError('文件过大（上限约 200 KB）')
            return onChange?.(undefined)
          }
          onChange?.({ fileName: file.name, content: await readText(file) })
        }}
      />
      {value ? <Typography.Text type="secondary"> 已读取 {value.fileName}</Typography.Text> : null}
      {error ? (
        <div role="alert" style={{ color: '#cf1322' }}>
          {error}
        </div>
      ) : null}
    </div>
  )
}

const money = (label: string, name: string, disabled = false) => (
  <Form.Item label={label} name={name}>
    <InputNumber aria-label={label} min={0} max={1_000_000_000} step={0.01} style={{ width: '100%' }} placeholder="没有这一项就留空" disabled={disabled} />
  </Form.Item>
)

/** 录入与改草稿共用的字段；limited 表示系统生成的草稿，采购单价、头程分摊与币种来自单据不能改。 */
function CostFields({ limited = false }: { limited?: boolean }) {
  return (
    <>
      <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: '请选择生效日期' }]}>
        <Input type="date" aria-label="生效日期" />
      </Form.Item>
      <Form.Item
        label="币种"
        name="currency"
        rules={[
          { required: true, message: '请填写币种' },
          { pattern: /^[A-Za-z]{3}$/, message: '币种应为 3 位字母代码，例如 USD、CNY' },
        ]}
      >
        <Input aria-label="币种" maxLength={3} disabled={limited} style={{ textTransform: 'uppercase' }} />
      </Form.Item>
      {COST_COMPONENTS.map(component => money(COST_COMPONENT_LABEL[component], COST_COMPONENT_COLUMN[component], limited && (component === 'product' || component === 'firstMile')))}
      <Form.Item label="备注" name="note">
        <Input.TextArea aria-label="备注" rows={2} maxLength={300} showCount />
      </Form.Item>
    </>
  )
}

const amountOf = (value: unknown) => (typeof value === 'number' ? value : undefined)
const nullable = (value: unknown) => (typeof value === 'number' ? value : null)

export function CostCreateAction({ canWrite, today, sku }: { canWrite: boolean; today: string; sku?: string }) {
  const mutation = useApiMutation<Record<string, unknown>, CostWriteResult>({ method: 'POST', path: '/costs', invalidate: ['list'], silent: true })
  return (
    <FormAction
      label="录入成本"
      title="录入成本版本"
      okText="保存"
      successText="已保存成本版本"
      guard={writeGuard(canWrite)}
      description="成本版本按 SKU 记录，四项成本（采购单价、头程分摊、关税、其他成本）至少填一项，没有的留空，不要填 0。保存后是草稿，不参与利润；确认生效后才计价。"
      initialValues={{ sku, effectiveFrom: today, currency: 'USD' }}
      onSubmit={async values => {
        await mutation.mutateAsync({
          sku: String(values.sku ?? '').trim(),
          effectiveFrom: values.effectiveFrom,
          currency: String(values.currency ?? '').toUpperCase(),
          unitProductCost: amountOf(values.unitProductCost),
          unitFirstMileCost: amountOf(values.unitFirstMileCost),
          unitDutyCost: amountOf(values.unitDutyCost),
          unitOtherCost: amountOf(values.unitOtherCost),
          note: String(values.note ?? '').trim() || undefined,
          activate: values.activate === true,
        })
      }}
    >
      <Form.Item label="SKU" name="sku" rules={[{ required: true, whitespace: true, message: '请填写 SKU' }]}>
        <Input aria-label="SKU" maxLength={120} disabled={Boolean(sku)} />
      </Form.Item>
      <CostFields />
      <Form.Item name="activate" valuePropName="checked">
        <Checkbox>保存后立即确认生效</Checkbox>
      </Form.Item>
    </FormAction>
  )
}

export function VersionEditAction({ canWrite, version, sku }: { canWrite: boolean; version: CostVersionView; sku: string }) {
  const mutation = useApiMutation<Record<string, unknown>, CostWriteResult>({ method: 'PATCH', path: `/costs/versions/${encodeURIComponent(version.id)}`, invalidate: ['list'], silent: true })
  const limited = version.editable === 'LIMITED'
  return (
    <FormAction
      label="修改"
      title={`修改 ${sku} 第 ${version.versionNo} 版草稿`}
      okText="保存"
      successText="已保存草稿"
      guard={writeGuard(canWrite)}
      buttonProps={{ size: 'small' }}
      description={limited ? '这是由采购收货或头程分摊生成的草稿：采购单价、头程分摊与币种来自单据，这里只能改关税、其他成本、生效日期与备注。' : '清空一项表示“没有这一项”；四项成本不能全部清空。'}
      initialValues={{
        effectiveFrom: version.effectiveFrom,
        currency: version.currency,
        unitProductCost: version.product === null ? undefined : Number(version.product),
        unitFirstMileCost: version.firstMile === null ? undefined : Number(version.firstMile),
        unitDutyCost: version.duty === null ? undefined : Number(version.duty),
        unitOtherCost: version.other === null ? undefined : Number(version.other),
        note: version.note ?? '',
      }}
      onSubmit={async values => {
        const common = {
          version: version.version,
          effectiveFrom: values.effectiveFrom,
          unitDutyCost: nullable(values.unitDutyCost),
          unitOtherCost: nullable(values.unitOtherCost),
          note: String(values.note ?? '').trim(),
        }
        await mutation.mutateAsync(
          limited
            ? common
            : { ...common, currency: String(values.currency ?? '').toUpperCase(), unitProductCost: nullable(values.unitProductCost), unitFirstMileCost: nullable(values.unitFirstMileCost) },
        )
      }}
    >
      <CostFields limited={limited} />
    </FormAction>
  )
}

export function VersionDiscardAction({ canWrite, version, sku }: { canWrite: boolean; version: CostVersionView; sku: string }) {
  const mutation = useApiMutation<void, CostWriteResult>({ method: 'DELETE', path: `/costs/versions/${encodeURIComponent(version.id)}?version=${version.version}`, invalidate: ['list'], silent: true })
  return (
    <FormAction
      label="丢弃"
      title={`丢弃 ${sku} 第 ${version.versionNo} 版草稿`}
      okText="丢弃"
      danger
      successText="已丢弃草稿"
      guard={writeGuard(canWrite)}
      buttonProps={{ size: 'small' }}
      description="草稿从未生效，丢弃后不可恢复；已生效的版本不能丢弃。"
      onSubmit={async () => {
        await mutation.mutateAsync()
      }}
    />
  )
}

export function VersionActivateAction({ canWrite, version, sku }: { canWrite: boolean; version: CostVersionView; sku: string }) {
  const mutation = useApiMutation<{ items: Array<{ id: string; version: number }> }, unknown>({ method: 'POST', path: '/costs/activate', invalidate: ['list'], silent: true })
  const guard = writeGuard(canWrite)
  return (
    <FormAction
      label="确认生效"
      title={`确认 ${sku} 第 ${version.versionNo} 版生效`}
      okText="确认生效"
      successText="已确认生效"
      guard={version.blockedReason ? { ...guard, condition: { ok: false, reason: version.blockedReason } } : guard}
      buttonProps={{ size: 'small', type: 'primary' }}
      description={
        <>
          <p style={{ margin: 0 }}>生效日期 {version.effectiveFrom}：已关账期间的利润不受影响，之后的利润在下一次重算后按新成本计价。</p>
          {version.willReplace.length > 0 ? <p style={{ margin: 0 }}>同一生效日已有生效的价格版本，生效后会替换第 {version.willReplace.join('、')} 版（旧版本留作历史）。</p> : null}
        </>
      }
      onSubmit={async () => {
        await mutation.mutateAsync({ items: [{ id: version.id, version: version.version }] })
      }}
    />
  )
}

export function CostImportAction({ canWrite }: { canWrite: boolean }) {
  const mutation = useApiMutation<{ fileName: string; content: string }, CostImportResult>({ method: 'POST', path: '/costs/import', invalidate: ['list'], silent: true })
  return (
    <FormAction
      label="导入成本文件"
      title="导入成本文件"
      okText="导入"
      successText="已导入成本草稿"
      guard={writeGuard(canWrite)}
      description={
        <>
          <p style={{ margin: 0 }}>
            文件为 CSV（逗号分隔，UTF-8），第一行是表头。必填列：{COST_IMPORT_COLUMNS.sku[0]}、{COST_IMPORT_COLUMNS.effectiveFrom[0]}、{COST_IMPORT_COLUMNS.currency[0]}；成本列至少一列：
            {COST_IMPORT_COLUMNS.product[0]}、{COST_IMPORT_COLUMNS.firstMile[0]}、{COST_IMPORT_COLUMNS.duty[0]}、{COST_IMPORT_COLUMNS.other[0]}；可选：{COST_IMPORT_COLUMNS.note[0]}（英文表头也可）。
          </p>
          <p style={{ margin: 0 }}>最多 {COST_IMPORT_MAX_ROWS} 行；一行有错整份拒绝。导入后每行是一个草稿，到“待确认”里确认后才生效。</p>
        </>
      }
      onSubmit={async values => {
        const file = values.content as Picked
        await mutation.mutateAsync({ fileName: file.fileName, content: file.content })
      }}
    >
      <Form.Item label="成本文件" name="content" rules={[{ required: true, message: '请选择文件' }]}>
        <FileField />
      </Form.Item>
    </FormAction>
  )
}
