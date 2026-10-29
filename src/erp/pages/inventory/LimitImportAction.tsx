import { useState } from 'react'
import { Form, Select, Typography } from 'antd'
import { STORAGE_LIMIT_COLUMNS, type StorageLimitImportResponse } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'

// 表单字段名用 content：服务端的逐行错误挂在 content 上，这样会显示在文件选择下面。
// 导入库容限额文件（权限 data.import）：浏览器读出 CSV 文本后提交，服务端逐行校验，全部通过才写入（一行有错整份拒绝，
// 错误逐行回填）；与月度报告里同一天同一存储类型的记录重合时拒绝，不覆盖。限额来自卖家后台“库容管理”的导出文件，我们不推算。

export const IMPORT_PERMISSION = 'data.import'
const MAX_BYTES = 100_000

type Picked = { fileName: string; content: string }

/** 读出文件文本（FileReader 在所有浏览器与测试环境都可用）。 */
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
        aria-label="限额文件"
        type="file"
        accept=".csv,.txt,text/csv,text/plain"
        onChange={async event => {
          const file = event.target.files?.[0]
          setError(null)
          if (!file) return onChange?.(undefined)
          if (file.size > MAX_BYTES) {
            setError('文件过大（上限约 100 KB）')
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

export function LimitImportAction({ stores }: { stores: Array<{ id: string; name: string }> }) {
  const mutation = useApiMutation<{ sellerAccountId: string; fileName: string; content: string }, StorageLimitImportResponse>({
    method: 'POST',
    path: '/inventory/capacity/limits-import',
    invalidate: ['list'],
    silent: true,
  })
  return (
    <FormAction
      label="导入限额文件"
      title="导入库容限额文件"
      okText="导入"
      successText="已导入限额"
      guard={{ permission: IMPORT_PERMISSION }}
      description={
        <>
          <p style={{ margin: 0 }}>
            文件为 CSV（逗号分隔，UTF-8），第一行是表头，列为：{STORAGE_LIMIT_COLUMNS.type[0]}、{STORAGE_LIMIT_COLUMNS.limit[0]}、{STORAGE_LIMIT_COLUMNS.used[0]}、{STORAGE_LIMIT_COLUMNS.date[0]}
            （英文表头也可）。
          </p>
          <p style={{ margin: 0 }}>一行有错整份拒绝；同一天同一类型再次导入会覆盖上次的导入；与月度报告重合的日期不覆盖。</p>
        </>
      }
      initialValues={{ sellerAccountId: stores.length === 1 ? stores[0]?.id : undefined }}
      onSubmit={async values => {
        const file = values.content as Picked
        await mutation.mutateAsync({ sellerAccountId: String(values.sellerAccountId), fileName: file.fileName, content: file.content })
      }}
    >
      <Form.Item label="店铺" name="sellerAccountId" rules={[{ required: true, message: '请选择店铺' }]}>
        <Select aria-label="导入店铺" placeholder="选择店铺" options={stores.map(store => ({ value: store.id, label: store.name }))} />
      </Form.Item>
      <Form.Item label="限额文件" name="content" rules={[{ required: true, message: '请选择文件' }]}>
        <FileField />
      </Form.Item>
    </FormAction>
  )
}
