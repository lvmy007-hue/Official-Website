import { useMemo, useState } from 'react'
import { Alert, App, Button, Form, Radio, Typography } from 'antd'
import {
  BOX_IMPORT_MAX_CHARS,
  BOX_IMPORT_MAX_ROWS,
  BOX_TEMPLATE_HINT,
  BOX_TEMPLATE_KINDS,
  BOX_TEMPLATE_LABEL,
  parseBoxFile,
  type BoxFileLineError,
  type BoxTemplateKind,
  type BoxTemplateResponse,
  type InboundOverview,
} from '@nova/api-contracts'
import { apiFetch } from '../../../../api'
import { FormAction } from '../../../components'
import { describeError } from '../../../query/errors'
import { guardFor, usePlanWrite, versionOf } from '../inbound-actions'
import { readCsvFile } from './decode-csv'

// 用表格文件导入箱内物品（P6-10）：两种模板（混装、原厂包装）下载、选 CSV 文件、本地预检、提交。
// 关键列缺失、任何一行有错都整份拒绝；最多 2000 行；导入会整体替换现有箱子，保存在我们这里，提交给亚马逊是单独的动作。

type Picked = { fileName: string; content: string }

export const boxLineText = (error: BoxFileLineError) => (error.line > 0 ? `第 ${error.line} 行：${error.message}` : error.message)

/** 向服务端取模板并下载（服务端是模板的唯一来源，前端不自己拼）。 */
async function downloadTemplate(kind: BoxTemplateKind): Promise<void> {
  const template = await apiFetch<BoxTemplateResponse>(`/inbound/box-templates/${kind}`)
  const url = URL.createObjectURL(new Blob([template.content], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = template.fileName
  link.click()
  URL.revokeObjectURL(url)
}

function TemplateBar() {
  const { message } = App.useApp()
  const kind = (Form.useWatch('kind') as BoxTemplateKind | undefined) ?? 'MIXED'
  return (
    <div style={{ marginBottom: 8 }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 4 }}>
        {BOX_TEMPLATE_HINT[kind]}
      </Typography.Paragraph>
      <Button size="small" onClick={() => void downloadTemplate(kind).catch(error => message.error(describeError(error).message))}>
        下载模板
      </Button>
    </div>
  )
}

function FileField({ value, onChange, skus }: { value?: Picked; onChange?: (next: Picked | undefined) => void; skus: readonly string[] }) {
  const kind = (Form.useWatch('kind') as BoxTemplateKind | undefined) ?? 'MIXED'
  const [error, setError] = useState<string | null>(null)
  const parsed = useMemo(() => (value ? parseBoxFile(value.content, kind, skus) : null), [value, kind, skus])
  const shown = (parsed?.errors ?? []).slice(0, 10)
  return (
    <div>
      <input
        aria-label="装箱文件"
        type="file"
        accept=".csv,.txt,.tsv,text/csv,text/plain"
        onChange={async event => {
          const file = event.target.files?.[0]
          setError(null)
          if (!file) return onChange?.(undefined)
          if (file.size > BOX_IMPORT_MAX_CHARS) {
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
        <Typography.Paragraph type="secondary" data-testid="box-file-preview" style={{ margin: '6px 0 0' }}>
          预览：{parsed.rows} 行，{parsed.boxes.length} 个箱型
          {parsed.skipped.length > 0 ? `；${parsed.skipped.length} 行与前面重复，已跳过` : ''}
        </Typography.Paragraph>
      ) : null}
      {shown.length > 0 ? (
        <Alert
          type="error"
          showIcon
          data-testid="box-file-errors"
          style={{ marginTop: 6 }}
          message={`文件有 ${parsed?.errors.length ?? 0} 处错误，没有导入任何数据`}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {shown.map(item => (
                <li key={`${item.line}|${item.message}`}>{boxLineText(item)}</li>
              ))}
              {(parsed?.errors.length ?? 0) > shown.length ? <li>还有 {(parsed?.errors.length ?? 0) - shown.length} 处错误未列出</li> : null}
            </ul>
          }
        />
      ) : null}
    </div>
  )
}

export function BoxFileImportAction({ overview }: { overview: InboundOverview }) {
  const write = usePlanWrite(overview.plan.id)
  const { message } = App.useApp()
  const skus = useMemo(() => overview.items.map(item => item.sku), [overview.items])
  if (!overview.actions.SAVE_BOXES.allowed) return null
  return (
    <FormAction
      label="用表格文件导入"
      guard={guardFor(overview, 'SAVE_BOXES', null, false)}
      title="用表格文件导入箱内物品（替换现有箱子）"
      description={`文件是 CSV（Excel 里另存为 CSV 即可），第一行是表头，最多 ${BOX_IMPORT_MAX_ROWS} 行；有任何一行有问题整份不导入。保存后到箱内物品里核对数量，再提交给亚马逊。`}
      okText="导入"
      initialValues={{ kind: 'MIXED' }}
      onSubmit={async values => {
        const file = values.file as Picked
        const result = await write.post('/boxes/import', { ...versionOf(overview.plan), kind: values.kind, fileName: file.fileName, content: file.content })
        const imported = (result as unknown as { imported?: { boxTypes: number; boxes: number; units: number } }).imported
        if (imported) void message.success(`已导入 ${imported.boxTypes} 个箱型，共 ${imported.boxes} 箱、${imported.units} 件`)
      }}
    >
      <Form.Item label="模板" name="kind">
        <Radio.Group options={BOX_TEMPLATE_KINDS.map(value => ({ value, label: BOX_TEMPLATE_LABEL[value] }))} />
      </Form.Item>
      <TemplateBar />
      <Form.Item
        label="装箱文件"
        name="file"
        rules={[
          ({ getFieldValue }) => ({
            validator: async (_rule, value: Picked | undefined) => {
              if (!value) throw new Error('请选择文件')
              const parsed = parseBoxFile(value.content, (getFieldValue('kind') as BoxTemplateKind) ?? 'MIXED', skus)
              if (parsed.errors.length > 0) throw new Error(`文件有 ${parsed.errors.length} 处错误，请按下面的提示修正后重新选择`)
            },
          }),
        ]}
      >
        <FileField skus={skus} />
      </Form.Item>
    </FormAction>
  )
}
