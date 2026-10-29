import { useState } from 'react'
import { App, Button, Form, Select, Typography } from 'antd'
import { REVIEWS_IMPORT_PERMISSION, REVIEWS_LIMITS, REVIEWS_RATINGS_BASIS, RATINGS_TEMPLATE_HEADER, parseRatingsFile, type RatingsImportError, type RatingsImportResult } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { todayInMarketplace } from '../../scope/dates'
import { downloadRatingsTemplate } from './reviews-state'

// 导入评分文件（权限 data.import）：浏览器读出 CSV 文本后提交，服务端逐行校验，一行有错整份拒绝。
// 表单字段名用 content：服务端的逐行错误挂在 content 上，会显示在文件选择下面；选文件时先用同一套规则在本地预检，同样按“第几行（列）：原因”列出。
// 成功后提示导入行数与覆盖的已有记录行数。

const MAX_BYTES = 2_000_000

type Picked = { fileName: string; content: string; errors: RatingsImportError[] }

/** 读出文件文本（FileReader 在所有浏览器与测试环境都可用）。 */
const readText = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file, 'utf-8')
  })

export const lineErrorText = (error: RatingsImportError): string => `第 ${error.line} 行${error.column ? `（${error.column}）` : ''}：${error.message}`

function FileField({ value, onChange }: { value?: Picked; onChange?: (next: Picked | undefined) => void }) {
  const [error, setError] = useState<string | null>(null)
  const shown = (value?.errors ?? []).slice(0, REVIEWS_LIMITS.importErrorsShown)
  return (
    <div>
      <input
        aria-label="评分文件"
        type="file"
        accept=".csv,.txt,text/csv,text/plain"
        onChange={async event => {
          const file = event.target.files?.[0]
          setError(null)
          if (!file) return onChange?.(undefined)
          if (file.size > MAX_BYTES) {
            setError('文件过大（上限约 2 MB），请拆成几份导入')
            return onChange?.(undefined)
          }
          const content = await readText(file)
          onChange?.({ fileName: file.name, content, errors: parseRatingsFile(content, todayInMarketplace()).errors })
        }}
      />
      {value ? <Typography.Text type="secondary"> 已读取 {value.fileName}</Typography.Text> : null}
      {error ? (
        <div role="alert" style={{ color: '#cf1322' }}>
          {error}
        </div>
      ) : null}
      {shown.length > 0 ? (
        <ul role="alert" data-testid="import-line-errors" style={{ margin: '6px 0 0', paddingLeft: 18, color: '#cf1322' }}>
          {shown.map(item => (
            <li key={`${item.line}|${item.column}|${item.message}`}>{lineErrorText(item)}</li>
          ))}
          {(value?.errors.length ?? 0) > shown.length ? <li>还有 {(value?.errors.length ?? 0) - shown.length} 处错误未列出</li> : null}
        </ul>
      ) : null}
    </div>
  )
}

export function RatingsImportAction({ stores }: { stores: Array<{ id: string; name: string }> }) {
  const { message } = App.useApp()
  const mutation = useApiMutation<{ storeId: string; fileName: string; content: string }, RatingsImportResult>({ method: 'POST', path: '/reviews/ratings-import', invalidate: ['list'], silent: true })
  return (
    <FormAction
      label="导入评分文件"
      title="导入评分文件"
      okText="导入"
      guard={{ permission: REVIEWS_IMPORT_PERMISSION, condition: { ok: stores.length > 0, reason: '还没有接入店铺，无法导入评分' } }}
      description={
        <>
          <p style={{ margin: 0 }}>
            文件为 CSV（逗号分隔，UTF-8），第一行是表头，列为：{RATINGS_TEMPLATE_HEADER.join('、')}；星级分布列可以留空。
            <Button type="link" size="small" onClick={downloadRatingsTemplate}>
              下载模板
            </Button>
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{REVIEWS_RATINGS_BASIS}</p>
        </>
      }
      initialValues={{ storeId: stores.length === 1 ? stores[0]?.id : undefined }}
      onSubmit={async values => {
        const file = values.content as Picked
        const result = await mutation.mutateAsync({ storeId: String(values.storeId), fileName: file.fileName, content: file.content })
        const errors = result.errors ?? []
        if (errors.length > 0) throw new Error(`文件有 ${errors.length} 处错误，没有导入任何数据：${errors.slice(0, 5).map(lineErrorText).join('；')}`)
        void message.success(`已导入 ${result.imported} 行${result.replaced > 0 ? `，覆盖了 ${result.replaced} 行已有记录` : ''}`)
      }}
    >
      <Form.Item label="店铺" name="storeId" rules={[{ required: true, message: '请选择店铺' }]}>
        <Select aria-label="导入店铺" placeholder="选择店铺" options={stores.map(store => ({ value: store.id, label: store.name }))} />
      </Form.Item>
      <Form.Item
        label="评分文件"
        name="content"
        rules={[
          {
            validator: async (_rule, value: Picked | undefined) => {
              if (!value) throw new Error('请选择文件')
              if (value.errors.length > 0) throw new Error(`文件有 ${value.errors.length} 处错误，请按下面的提示修正后重新选择`)
            },
          },
        ]}
      >
        <FileField />
      </Form.Item>
    </FormAction>
  )
}
