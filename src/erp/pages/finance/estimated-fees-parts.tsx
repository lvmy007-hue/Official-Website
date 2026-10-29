import { useState } from 'react'
import { Alert, App, Button, Form, Input, InputNumber, Select, Typography } from 'antd'
import {
  ESTIMATED_FEE_FILE_HINT,
  ESTIMATED_FEE_LIMITS,
  ESTIMATED_FEE_WRITE,
  ESTIMATED_MODES,
  ESTIMATED_MODE_LABEL,
  ESTIMATED_PERIODS,
  ESTIMATED_PERIOD_LABEL,
  ESTIMATED_SCOPE_LABEL,
  ESTIMATED_SCOPE_TYPES,
  ESTIMATED_STATUSES,
  ESTIMATED_STATUS_LABEL,
  estimatedFeeExportCsv,
  estimatedFeeFileName,
  estimatedFeeTemplateCsv,
  isDayText,
  parseEstimatedFeeFile,
  type EstimatedFeeImportResponse,
  type EstimatedFeeItemOption,
  type EstimatedFeeRow,
  type EstimatedFeeStoreOption,
  type EstimatedFeesResponse,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FormAction } from '../../components'
import { describeError } from '../../query/errors'
import { readCsvFile } from '../inbound/box-editor/decode-csv'

// 预估与自定义费用页的零件（P6-20）：规则表单项、表单值转请求体、文件导入、导出。

export const FEE_GUARD = { permission: ESTIMATED_FEE_WRITE } as const
const option = <T extends string>(values: readonly T[], labels: Readonly<Record<T, string>>) => values.map(value => ({ value, label: labels[value] }))

/** 表单值转接口请求体；比例规则的周期固定按日。 */
export function feeBodyOf(values: Record<string, unknown>): Record<string, unknown> {
  const text = (key: string) => String(values[key] ?? '').trim()
  const mode = values.mode as string
  return {
    itemId: values.itemId,
    scopeType: values.scopeType,
    scopeId: text('scopeId'),
    mode,
    value: Number(values.value),
    period: mode === 'PERCENT_OF_SALES' ? 'DAILY' : values.period,
    from: text('from'),
    to: text('to') === '' ? null : text('to'),
    status: values.status ?? 'ACTIVE',
    note: text('note') === '' ? null : text('note'),
  }
}

export const feeFormValues = (row: EstimatedFeeRow): Record<string, unknown> => ({
  itemId: row.itemId,
  scopeType: row.scopeType,
  scopeId: row.scopeId,
  mode: row.mode,
  value: row.value,
  period: row.period,
  from: row.from,
  to: row.to ?? '',
  status: row.status,
  note: row.note ?? '',
})

const dayRule = (required: boolean) => ({
  validator: async (_: unknown, value: unknown) => {
    const text = String(value ?? '').trim()
    if (text === '' && !required) return
    if (!isDayText(text)) throw new Error('日期格式应为 YYYY-MM-DD，且日期要存在')
  },
})

/** 规则表单项（新建与修改共用）：范围是店铺时选店铺，是 SKU 或品类时直接填写。 */
export function FeeFields({ items, stores }: { items: EstimatedFeeItemOption[]; stores: EstimatedFeeStoreOption[] }) {
  const scopeType = Form.useWatch('scopeType')
  const mode = Form.useWatch('mode')
  return (
    <>
      <Form.Item name="itemId" label="费用项" rules={[{ required: true, message: '请选择费用项' }]} extra="只列出花费类的利润项目；自定义项目（站外推广、服务费等）先在“利润项目字典”里建好。">
        <Select showSearch optionFilterProp="label" placeholder="选择费用项" options={items.map(item => ({ value: item.id, label: item.path }))} />
      </Form.Item>
      <Form.Item name="scopeType" label="范围" rules={[{ required: true }]}>
        <Select options={option(ESTIMATED_SCOPE_TYPES, ESTIMATED_SCOPE_LABEL)} />
      </Form.Item>
      {scopeType === 'STORE' ? (
        <Form.Item name="scopeId" label="店铺" rules={[{ required: true, message: '请选择店铺' }]}>
          <Select showSearch optionFilterProp="label" placeholder="选择店铺" options={stores.map(store => ({ value: store.id, label: store.name }))} />
        </Form.Item>
      ) : (
        <Form.Item
          name="scopeId"
          label={scopeType === 'SKU' ? '卖家 SKU' : '品类'}
          rules={[{ required: true, message: '请填写范围对象' }]}
          extra={scopeType === 'SKU' ? '商品目录里已有的卖家 SKU。' : '商品目录里的“商品类型”或“类目路径”。'}
        >
          <Input autoComplete="off" maxLength={ESTIMATED_FEE_LIMITS.scopeIdMax} />
        </Form.Item>
      )}
      <Form.Item name="mode" label="方式" rules={[{ required: true }]}>
        <Select options={option(ESTIMATED_MODES, ESTIMATED_MODE_LABEL)} />
      </Form.Item>
      <Form.Item
        name="value"
        label={mode === 'PERCENT_OF_SALES' ? '比例（%）' : '金额（美元）'}
        rules={[{ required: true, message: '请填写金额或比例' }]}
        extra={mode === 'PERCENT_OF_SALES' ? '按每天的销售额乘这个比例，范围 0 到 100。' : '按月的金额会按当月天数平均到每一天。'}
      >
        <InputNumber min={0} max={mode === 'PERCENT_OF_SALES' ? 100 : ESTIMATED_FEE_LIMITS.valueMax} style={{ width: '100%' }} />
      </Form.Item>
      {mode === 'PERCENT_OF_SALES' ? null : (
        <Form.Item name="period" label="周期" rules={[{ required: true }]}>
          <Select options={option(ESTIMATED_PERIODS, ESTIMATED_PERIOD_LABEL)} />
        </Form.Item>
      )}
      <Form.Item name="from" label="起始日" rules={[dayRule(true)]}>
        <Input autoComplete="off" placeholder="YYYY-MM-DD" />
      </Form.Item>
      <Form.Item name="to" label="截止日（含）" rules={[dayRule(false)]} extra="留空表示一直有效；同一费用项、同一范围，生效中的规则区间不能重叠。">
        <Input autoComplete="off" placeholder="YYYY-MM-DD，可留空" />
      </Form.Item>
      <Form.Item name="status" label="状态">
        <Select options={option(ESTIMATED_STATUSES, ESTIMATED_STATUS_LABEL)} />
      </Form.Item>
      <Form.Item name="note" label="备注">
        <Input autoComplete="off" maxLength={ESTIMATED_FEE_LIMITS.noteMax} />
      </Form.Item>
    </>
  )
}

type Picked = { fileName: string; content: string }

export function download(content: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

function ImportFileField({ value, onChange }: { value?: Picked; onChange?: (next: Picked | undefined) => void }) {
  const [error, setError] = useState<string | null>(null)
  const parsed = value ? parseEstimatedFeeFile(value.content) : null
  return (
    <div>
      <input
        aria-label="预估费用文件"
        type="file"
        accept=".csv,.txt,.tsv,text/csv,text/plain"
        onChange={async event => {
          const file = event.target.files?.[0]
          setError(null)
          if (!file) return onChange?.(undefined)
          if (file.size > ESTIMATED_FEE_LIMITS.importMaxChars) {
            setError('文件过大，请拆成几份导入')
            return onChange?.(undefined)
          }
          onChange?.({ fileName: file.name, content: await readCsvFile(file) })
        }}
      />
      {value ? <Typography.Text type="secondary"> 已读取 {value.fileName}</Typography.Text> : null}
      {error ? (
        <Typography.Text type="danger" role="alert">
          {error}
        </Typography.Text>
      ) : null}
      {parsed && parsed.errors.length === 0 ? (
        <Typography.Paragraph type="secondary" data-testid="fee-file-preview" style={{ margin: '6px 0 0' }}>
          预览：{parsed.rows.length} 条规则（费用项与店铺是否存在、区间是否重叠由服务端校验）
        </Typography.Paragraph>
      ) : null}
      {parsed && parsed.errors.length > 0 ? (
        <Alert
          type="error"
          showIcon
          data-testid="fee-file-errors"
          style={{ marginTop: 6 }}
          message={`文件有 ${parsed.errors.length} 处错误，没有导入任何数据`}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {parsed.errors.slice(0, 10).map(item => (
                <li key={`${item.line}|${item.message}`}>
                  {item.line > 0 ? `第 ${item.line} 行：` : ''}
                  {item.message}
                </li>
              ))}
            </ul>
          }
        />
      ) : null}
    </div>
  )
}

export function ImportFeesAction({ onDone }: { onDone: () => void }) {
  const { message } = App.useApp()
  return (
    <FormAction
      label="文件导入"
      guard={FEE_GUARD}
      title="用文件导入预估费用"
      description={`${ESTIMATED_FEE_FILE_HINT} 费用项可以写“上级 / 项目”。`}
      okText="导入"
      width={560}
      onSubmit={async values => {
        const file = values.file as Picked
        const result = await apiFetch<EstimatedFeeImportResponse>('/finance/estimated-fees/import', { method: 'POST', body: JSON.stringify({ fileName: file.fileName, content: file.content }) })
        void message.success(`已导入 ${result.total} 条规则。${result.recomputeNote}`)
      }}
      onDone={onDone}
    >
      <Button size="small" style={{ marginBottom: 8 }} onClick={() => download(estimatedFeeTemplateCsv(), estimatedFeeFileName)}>
        下载模板
      </Button>
      <Form.Item
        label="规则文件"
        name="file"
        rules={[
          {
            validator: async (_rule, value: Picked | undefined) => {
              if (!value) throw new Error('请选择文件')
              const parsed = parseEstimatedFeeFile(value.content)
              if (parsed.errors.length > 0) throw new Error(`文件有 ${parsed.errors.length} 处错误，请按下面的提示修正后重新选择`)
            },
          },
        ]}
      >
        <ImportFileField />
      </Form.Item>
    </FormAction>
  )
}

/** 导出全部规则：分页读完（每页 200 条），列与导入模板一致，导出的文件可以直接再导入。 */
export function ExportFeesButton() {
  const { message } = App.useApp()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      loading={busy}
      onClick={async () => {
        setBusy(true)
        try {
          const rows: EstimatedFeeRow[] = []
          for (let page = 1; page <= Math.ceil(ESTIMATED_FEE_LIMITS.tenantMax / ESTIMATED_FEE_LIMITS.pageSizeMax); page += 1) {
            const response = await apiFetch<EstimatedFeesResponse>(`/finance/estimated-fees?page=${page}&pageSize=${ESTIMATED_FEE_LIMITS.pageSizeMax}`)
            rows.push(...response.rows)
            if (rows.length >= response.total) break
          }
          download(estimatedFeeExportCsv(rows.map(row => ({ ...row, itemName: row.itemPath || row.itemName }))), `预估费用-${new Date().toISOString().slice(0, 10)}.csv`)
        } catch (error) {
          void message.error(describeError(error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      导出
    </Button>
  )
}
