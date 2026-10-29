import { useState } from 'react'
import { Alert, App, Button, Form, Input, Select, Space, Typography } from 'antd'
import {
  SKU_ALIAS_FILE_HINT,
  SKU_ALIAS_IMPORT_MAX_CHARS,
  SKU_ALIAS_MANAGE,
  parseSkuAliasFile,
  skuAliasFileName,
  skuAliasTemplateCsv,
  type SkuAliasExportResponse,
  type SkuAliasImportResponse,
  type SkuAliasRow,
  type SupplierListResponse,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FormAction } from '../../components'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { useSession } from '../../session/session'
import { readCsvFile } from '../inbound/box-editor/decode-csv'

// 外部货号映射的写操作（P6-11）：新增、修改、删除、文件导入、导出。都要“维护外部货号映射与装箱单列映射”权限（按钮禁用时写明原因）。
// 结果以服务端为准：修改带版本号（别人先改过会提示刷新）；SKU 必须是商品目录里已有的；同一个供应商的同一个外部货号只能有一条。

const guard = { permission: SKU_ALIAS_MANAGE }

export function useSupplierOptions() {
  const { canPermission } = useSession()
  const suppliers = useApiQuery<SupplierListResponse>({ domain: 'reference', path: '/suppliers', params: { pageSize: 200 }, scoped: false, enabled: canPermission('supplier.read') })
  return (suppliers.data?.items ?? []).map(item => ({ value: item.id, label: `${item.code} ${item.name}` }))
}

type Row = { id: string }
function useAliasWrites() {
  const create = useApiMutation<Record<string, unknown>, SkuAliasRow>({ method: 'POST', path: '/sku-aliases', invalidate: ['list', 'reference'], silent: true })
  const update = useApiMutation<{ id: string; body: Record<string, unknown> }, SkuAliasRow>({
    method: 'PUT',
    path: v => `/sku-aliases/${encodeURIComponent(v.id)}`,
    body: v => v.body,
    invalidate: ['list', 'reference'],
    silent: true,
  })
  const remove = useApiMutation<string, Row>({ method: 'DELETE', path: id => `/sku-aliases/${encodeURIComponent(id)}`, body: () => undefined, invalidate: ['list', 'reference'], silent: true })
  const importFile = useApiMutation<{ fileName: string; content: string }, SkuAliasImportResponse>({ method: 'POST', path: '/sku-aliases/import', invalidate: ['list', 'reference'], silent: true })
  return { create, update, remove, importFile }
}

export function CreateAliasAction({ onDone }: { onDone: () => void }) {
  const writes = useAliasWrites()
  const suppliers = useSupplierOptions()
  return (
    <FormAction
      label="新增映射"
      guard={guard}
      title="新增外部货号映射"
      description="供应商装箱单里的货号（或条码）对应我们的哪个 SKU。选了供应商只对该供应商的装箱单生效；不选就是通用，所有供应商都能用，同一个货号两种都有时优先用供应商专属的。"
      okText="保存"
      successText="已新增映射"
      width={520}
      buttonProps={{ type: 'primary' }}
      onSubmit={values =>
        writes.create.mutateAsync({ ...(values.supplierId ? { supplierId: values.supplierId } : {}), externalCode: String(values.externalCode ?? '').trim(), sku: String(values.sku ?? '').trim() })
      }
      onDone={onDone}
    >
      <Form.Item label="适用供应商" name="supplierId" extra={suppliers.length === 0 ? '没有供应商，或你没有查看供应商的权限：只能新增通用映射' : undefined}>
        <Select allowClear placeholder="通用（所有供应商）" options={suppliers} showSearch optionFilterProp="label" />
      </Form.Item>
      <Form.Item label="外部货号" name="externalCode" rules={[{ required: true, message: '请填写外部货号' }]}>
        <Input maxLength={120} placeholder="供应商装箱单里的货号或条码" />
      </Form.Item>
      <Form.Item label="对应 SKU" name="sku" rules={[{ required: true, message: '请填写我们的 SKU' }]}>
        <Input maxLength={120} placeholder="商品目录里已有的卖家 SKU" />
      </Form.Item>
    </FormAction>
  )
}

export function AliasRowActions({ row, onDone }: { row: SkuAliasRow; onDone: () => void }) {
  const writes = useAliasWrites()
  return (
    <Space size={4}>
      <FormAction
        label="编辑"
        guard={guard}
        title={`编辑映射「${row.externalCode}」`}
        description={row.supplierId ? `适用供应商：${row.supplierCode ?? ''} ${row.supplierName ?? ''}（供应商不能修改，要换请新增后删除这一条）` : '通用映射（供应商不能修改）'}
        okText="保存修改"
        successText="已保存修改"
        width={520}
        buttonProps={{ size: 'small' }}
        initialValues={{ externalCode: row.externalCode, sku: row.sku }}
        onSubmit={values => writes.update.mutateAsync({ id: row.id, body: { version: row.version, externalCode: String(values.externalCode ?? '').trim(), sku: String(values.sku ?? '').trim() } })}
        onDone={onDone}
      >
        <Form.Item label="外部货号" name="externalCode" rules={[{ required: true, message: '请填写外部货号' }]}>
          <Input maxLength={120} />
        </Form.Item>
        <Form.Item label="对应 SKU" name="sku" rules={[{ required: true, message: '请填写我们的 SKU' }]}>
          <Input maxLength={120} />
        </Form.Item>
      </FormAction>
      <FormAction
        label="删除"
        guard={guard}
        title={`删除映射「${row.externalCode}」`}
        description="删除后，用到这个货号的装箱单会回到“未匹配”，要重新选择。已经写进箱内物品的数据不受影响。"
        okText="删除"
        successText="已删除"
        danger
        buttonProps={{ size: 'small' }}
        onSubmit={() => writes.remove.mutateAsync(row.id)}
        onDone={onDone}
      />
    </Space>
  )
}

type Picked = { fileName: string; content: string }

function download(content: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

function ImportFileField({ value, onChange }: { value?: Picked; onChange?: (next: Picked | undefined) => void }) {
  const [error, setError] = useState<string | null>(null)
  const parsed = value ? parseSkuAliasFile(value.content) : null
  return (
    <div>
      <input
        aria-label="映射文件"
        type="file"
        accept=".csv,.txt,.tsv,text/csv,text/plain"
        onChange={async event => {
          const file = event.target.files?.[0]
          setError(null)
          if (!file) return onChange?.(undefined)
          if (file.size > SKU_ALIAS_IMPORT_MAX_CHARS) {
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
        <Typography.Paragraph type="secondary" data-testid="alias-file-preview" style={{ margin: '6px 0 0' }}>
          预览：{parsed.rows.length} 条映射
        </Typography.Paragraph>
      ) : null}
      {parsed && parsed.errors.length > 0 ? (
        <Alert
          type="error"
          showIcon
          data-testid="alias-file-errors"
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

export function ImportAliasAction({ onDone }: { onDone: () => void }) {
  const writes = useAliasWrites()
  const { message } = App.useApp()
  return (
    <FormAction
      label="文件导入"
      guard={guard}
      title="用文件导入外部货号映射"
      description={`${SKU_ALIAS_FILE_HINT} 有任何一行有问题整份不导入。`}
      okText="导入"
      width={560}
      onSubmit={async values => {
        const file = values.file as Picked
        const result = await writes.importFile.mutateAsync({ fileName: file.fileName, content: file.content })
        void message.success(`已导入 ${result.total} 条：新增 ${result.created} 条，更新 ${result.updated} 条`)
      }}
      onDone={onDone}
    >
      <Button size="small" style={{ marginBottom: 8 }} onClick={() => download(skuAliasTemplateCsv(), skuAliasFileName)}>
        下载模板
      </Button>
      <Form.Item
        label="映射文件"
        name="file"
        rules={[
          {
            validator: async (_rule, value: Picked | undefined) => {
              if (!value) throw new Error('请选择文件')
              const parsed = parseSkuAliasFile(value.content)
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

export function ExportAliasButton() {
  const { message } = App.useApp()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      loading={busy}
      onClick={async () => {
        setBusy(true)
        try {
          const result = await apiFetch<SkuAliasExportResponse>('/sku-aliases/export')
          download(result.content, result.fileName)
          if (result.truncated) void message.warning(`映射太多，只导出了前 ${result.rows} 条`)
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
