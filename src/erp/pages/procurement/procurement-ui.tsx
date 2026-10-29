import { useRef, useState } from 'react'
import { permissionDeniedMessage } from '@nova/api-contracts'
import { App, Button, Form, Input, Space, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { apiFetch } from '../../../api'
import { PO_STATUS_LABEL, type AttachmentLink, type AttachmentRow, type AttachmentTicket, type PoStatus, type SupplierRow } from '@nova/api-contracts'
import { formatDateTime, formatMoney, formatNumber } from '../../format'
import { describeError } from '../../query/errors'
import { useSession } from '../../session/session'
import { Muted } from '../inventory/inventory-ui'
import { openSignedUrl } from '../../security/safe-url'
import { SimpleGrid } from '../../components'

// 采购、供应商、国内仓页面共用的小件：状态标签、金额与数量的显示规则、附件上传与下载。
// 金额键不存在表示没有字段权限（显示“无权查看”），为 null 表示没有数据（显示“尚无记录”），任何时候都不显示 0 代替。

const STATUS_COLOR: Record<PoStatus, string> = {
  DRAFT: 'default',
  PENDING_APPROVAL: 'warning',
  ORDERED: 'processing',
  IN_PRODUCTION: 'processing',
  PARTIALLY_RECEIVED: 'cyan',
  RECEIVED: 'success',
  CLOSED: 'default',
  CANCELLED: 'default',
  RETURNED_TO_SUPPLIER: 'error',
}

export function PoStatusTag({ status }: { status: PoStatus }) {
  return (
    <Tag color={STATUS_COLOR[status]} bordered={false}>
      {PO_STATUS_LABEL[status]}
    </Tag>
  )
}

export function money(value: string | null | undefined, currency: string) {
  if (value === undefined) return <Muted>无权查看</Muted>
  if (value === null) return <Muted>尚无记录</Muted>
  return <span className="erp-num">{formatMoney(value, currency, { digits: 2 })}</span>
}

export function count(value: number | null | undefined) {
  return value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>
}

export const percent = (value: number | null | undefined) =>
  value === null || value === undefined ? <Muted>样本不足</Muted> : <span className="erp-num">{formatNumber(value * 100, { digits: 1 })}%</span>

/** 表单里填的日期留空时不带上这个键。 */
export const optional = (text: unknown): string | undefined => (typeof text === 'string' && text.trim() ? text.trim() : undefined)

type PanelProps = {
  /** 附件所属对象的接口前缀，例如 /purchase-orders/abc。 */
  base: string
  items: AttachmentRow[]
  writePermission: string
  onChanged: () => void
}

const columns = (open: (row: AttachmentRow) => void): ColumnsType<AttachmentRow> => [
  { title: '文件名', dataIndex: 'fileName' },
  {
    title: '大小',
    dataIndex: 'sizeBytes',
    width: 110,
    align: 'right',
    render: (value: number) => <span className="erp-num">{value < 1024 * 1024 ? `${formatNumber(value / 1024, { digits: 1 })} KB` : `${formatNumber(value / 1024 / 1024, { digits: 1 })} MB`}</span>,
  },
  { title: '上传人', dataIndex: 'uploadedBy', width: 140 },
  { title: '上传时间', dataIndex: 'uploadedAt', width: 170, render: (value: string) => formatDateTime(value) },
  {
    title: '操作',
    key: 'op',
    width: 90,
    render: (_value, row) => (
      <Button type="link" size="small" onClick={() => open(row)}>
        下载
      </Button>
    ),
  },
]

/**
 * 附件列表与上传：先向服务端申请直传凭据（类型与大小在服务端校验），再由浏览器直接传到对象存储，最后确认登记。
 * 下载走几分钟内有效的签名链接。任何一步失败都原样显示原因，不做假成功。
 */
export function AttachmentsPanel({ base, items, writePermission, onChanged }: PanelProps) {
  const { message } = App.useApp()
  const { canPermission } = useSession()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const canWrite = canPermission(writePermission)

  const upload = async (file: File) => {
    setBusy(true)
    try {
      const ticket = await apiFetch<AttachmentTicket>(`${base}/attachments`, { method: 'POST', body: JSON.stringify({ fileName: file.name, contentType: file.type, sizeBytes: file.size }) })
      const sent = await fetch(ticket.uploadUrl, { method: ticket.method, headers: ticket.headers, body: file })
      if (!sent.ok) throw new Error('文件上传到存储失败，请稍后重试')
      await apiFetch(`${base}/attachments/confirm`, { method: 'POST', body: JSON.stringify({ objectKey: ticket.objectKey, fileName: file.name, contentType: file.type }) })
      void message.success('附件已上传')
      onChanged()
    } catch (error) {
      void message.error(describeError(error).message)
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  const open = async (row: AttachmentRow) => {
    try {
      const link = await apiFetch<AttachmentLink>(`${base}/attachments/${encodeURIComponent(row.id)}/download`)
      openSignedUrl(link.url)
    } catch (error) {
      void message.error(describeError(error).message)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space>
        <input ref={input} type="file" hidden aria-label="选择附件文件" onChange={event => event.target.files?.[0] && void upload(event.target.files[0])} />
        <Tooltip title={canWrite ? '支持 PDF、图片、表格、文档与文本文件，单个不超过 20 MB' : permissionDeniedMessage(writePermission)}>
          <span>
            <Button disabled={!canWrite} loading={busy} onClick={() => input.current?.click()}>
              上传附件
            </Button>
          </span>
        </Tooltip>
      </Space>
      {items.length ? (
        <SimpleGrid<AttachmentRow>
          gridId="procurement.procurement-ui"
          columns={columns(row => void open(row))}
          rows={items}
          rowKey={row => row.id}
          emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
        />
      ) : (
        <Muted>还没有附件</Muted>
      )}
    </Space>
  )
}

// ---- 供应商页面共用 ----

const RATING_COLOR = { A: 'success', B: 'processing', C: 'warning', D: 'error' } as const

export const ratingTag = (rating: SupplierRow['rating']) =>
  rating ? (
    <Tag color={RATING_COLOR[rating]} bordered={false}>
      {rating} 级
    </Tag>
  ) : (
    <Muted>样本不足</Muted>
  )

// 字段名不能叫 code：FormAction 把 code 当作多因素验证码，提交前会删掉，所以编码字段叫 supplierCode。
export function SupplierFields({ withCode }: { withCode: boolean }) {
  return (
    <>
      {withCode ? (
        <Form.Item
          label="编码"
          name="supplierCode"
          rules={[
            { required: true, whitespace: true, message: '请填写编码' },
            { pattern: /^[A-Za-z0-9_-]+$/, message: '只能包含字母、数字、下划线与连字符' },
          ]}
        >
          <Input aria-label="编码" maxLength={40} style={{ width: 220 }} />
        </Form.Item>
      ) : null}
      <Form.Item label="名称" name="name" rules={[{ required: true, whitespace: true, message: '请填写名称' }]}>
        <Input aria-label="名称" maxLength={120} />
      </Form.Item>
      <Space size={12} wrap>
        <Form.Item label="联系人" name="contactName">
          <Input aria-label="联系人" maxLength={80} style={{ width: 160 }} />
        </Form.Item>
        <Form.Item label="电话" name="phone">
          <Input aria-label="电话" maxLength={40} style={{ width: 160 }} />
        </Form.Item>
        <Form.Item label="币种" name="currency" rules={[{ required: true, pattern: /^[A-Za-z]{3}$/, message: '3 位字母币种代码，例如 CNY' }]}>
          <Input aria-label="币种" maxLength={3} style={{ width: 90 }} />
        </Form.Item>
      </Space>
      <Form.Item label="邮箱" name="email" rules={[{ type: 'email', message: '邮箱格式不正确' }]}>
        <Input aria-label="邮箱" maxLength={160} />
      </Form.Item>
      <Form.Item label="备注" name="notes">
        <Input.TextArea aria-label="备注" rows={2} maxLength={1000} />
      </Form.Item>
    </>
  )
}

/** 表单值整理成请求体：空字符串不带；币种转大写。 */
export const supplierBody = (values: Record<string, unknown>): Record<string, unknown> => ({
  ...(optional(values.supplierCode) ? { code: optional(values.supplierCode) } : {}),
  name: optional(values.name),
  ...(optional(values.contactName) ? { contactName: optional(values.contactName) } : {}),
  ...(optional(values.phone) ? { phone: optional(values.phone) } : {}),
  ...(optional(values.email) ? { email: optional(values.email) } : {}),
  ...(optional(values.notes) ? { notes: optional(values.notes) } : {}),
  currency: String(values.currency ?? 'USD').toUpperCase(),
})
