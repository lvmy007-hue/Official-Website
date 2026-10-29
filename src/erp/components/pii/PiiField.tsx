import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Alert, Button, Descriptions, Space, Tag, Typography } from 'antd'
import { LockOutlined } from '@ant-design/icons'
import { PII_KIND_LABEL, PII_REVEAL_AUTO_HIDE_SECONDS, PII_REVEAL_PERMISSION, type PiiKind, type PiiObjectType, type PiiRevealResponse } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { formatDateTime } from '../../format'
import { FormAction } from '../action/FormAction'

// 个人信息字段（P6-14，16 章第 6 节）：全站个人信息明文的唯一前端出口，对应服务端唯一出口 POST /pii/reveal。
// - 默认只显示遮罩和锁图标，页面其他接口从不返回明文；
// - 有 field.buyer 权限的人点“查看”，填写理由后才请求明文，查看会记入审计；
// - 明文只放在本组件的状态里（不走 react-query，不进请求缓存与本地存储），到点自动隐藏，离开页面随组件销毁。

const MASK = '••••••'
const STATE_NOTE: Record<Exclude<PiiRevealResponse['state'], 'OK'>, string> = {
  EXPIRED: '这部分信息已超过保留期，按亚马逊要求已清除，无法查看。',
  NOT_SYNCED: '这部分信息系统里没有（没同步、没有权限同步，或对方没有填写）。',
}

export interface PiiFieldSpec {
  /** 请求的字段名（与服务端约定，例如 buyerName、customerComments、body）。 */
  name: string
  label: string
}

export interface PiiRevealState {
  result: PiiRevealResponse | null
  /** 剩余的显示秒数；没有展示明文时为 0。 */
  left: number
  reveal: (reason: string) => Promise<void>
  hide: () => void
}

/** 查看明文的状态：对象换了或组件销毁就清空；到点自动清空。 */
export function usePiiReveal(objectType: PiiObjectType, objectId: string, fields: readonly string[]): PiiRevealState {
  const [result, setResult] = useState<PiiRevealResponse | null>(null)
  const [left, setLeft] = useState(0)
  const fieldKey = fields.join(',')

  useEffect(() => {
    setResult(null)
  }, [objectType, objectId, fieldKey])

  useEffect(() => {
    if (!result || result.state !== 'OK') return undefined
    const deadline = Date.now() + PII_REVEAL_AUTO_HIDE_SECONDS * 1000
    setLeft(PII_REVEAL_AUTO_HIDE_SECONDS)
    const timer = window.setInterval(() => {
      const remain = Math.ceil((deadline - Date.now()) / 1000)
      if (remain <= 0) setResult(null)
      else setLeft(remain)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [result])

  const reveal = useCallback(
    async (reason: string) => {
      setResult(await apiFetch<PiiRevealResponse>('/pii/reveal', { method: 'POST', body: JSON.stringify({ objectType, objectId, fields: fieldKey.split(','), reason }) }))
    },
    [objectType, objectId, fieldKey],
  )
  const hide = useCallback(() => setResult(null), [])
  return { result, left: result?.state === 'OK' ? Math.max(left, 0) : 0, reveal, hide }
}

export interface PiiFieldProps {
  objectType: PiiObjectType
  /** 对象编号：订单、退货用系统编号，支持案件沟通用沟通记录编号。 */
  objectId: string
  fields: readonly PiiFieldSpec[]
  /** fields：逐项显示（订单买家信息）；text：只显示第一个字段的一段文字（备注、沟通正文）。 */
  layout?: 'fields' | 'text'
  /** 有没有内容可以查看；false 时只显示 unavailableNote，不给查看按钮。 */
  available?: boolean
  unavailableNote?: ReactNode
  /** 隐藏状态下显示的内容（例如已掩码的正文）；不传显示遮罩。只能放已经掩码过的文字。 */
  maskedContent?: ReactNode
  /** 识别出的个人信息类别（只提示有哪几类，不含内容）。 */
  kinds?: readonly PiiKind[]
  retainedUntil?: string | null
  buttonLabel?: string
  dialogTitle?: string
  reasonPlaceholder?: string
  /** 紧凑显示（列表里的单条沟通）：按钮用小号。 */
  compact?: boolean
}

function Lock({ children }: { children?: ReactNode }) {
  return (
    <span aria-label="已隐藏" data-testid="pii-masked">
      <LockOutlined style={{ marginRight: 4, opacity: 0.55 }} />
      {children ?? MASK}
    </span>
  )
}

export function PiiField(props: PiiFieldProps) {
  const { objectType, objectId, fields, layout = 'fields', available = true, compact = false } = props
  const { result, left, reveal, hide } = usePiiReveal(
    objectType,
    objectId,
    fields.map(field => field.name),
  )
  const shown = result?.state === 'OK' ? result : null
  const valueOf = (name: string) => shown?.values[name] ?? null

  const body =
    layout === 'text' ? (
      shown ? (
        <Typography.Paragraph data-testid="pii-revealed" style={{ marginBottom: 4, whiteSpace: 'pre-wrap' }}>
          {valueOf(fields[0]?.name ?? '') ?? <Typography.Text type="secondary">尚无记录</Typography.Text>}
        </Typography.Paragraph>
      ) : (
        <div data-testid="pii-masked-block" style={{ whiteSpace: 'pre-wrap' }}>
          {props.maskedContent ?? <Lock />}
        </div>
      )
    ) : (
      <Descriptions size="small" bordered column={{ xs: 1, md: 2 }} data-testid={shown ? 'pii-revealed' : 'pii-masked-block'}>
        {fields.map(field => (
          <Descriptions.Item key={field.name} label={field.label}>
            {shown ? valueOf(field.name) ? <span className="erp-num">{valueOf(field.name)}</span> : <Typography.Text type="secondary">尚无记录</Typography.Text> : <Lock />}
          </Descriptions.Item>
        ))}
      </Descriptions>
    )

  const kindTags =
    props.kinds && props.kinds.length > 0 ? (
      <span>
        含{' '}
        {props.kinds.map(kind => (
          <Tag key={kind} bordered={false}>
            {PII_KIND_LABEL[kind]}
          </Tag>
        ))}
      </span>
    ) : null

  return (
    <div data-testid="pii-field">
      {available ? body : <div>{props.unavailableNote}</div>}
      {available ? (
        <div style={{ marginTop: compact ? 4 : 8 }}>
          {shown ? (
            <Space size={8} wrap>
              <span>{left} 秒后自动隐藏</span>
              <Button size="small" onClick={hide}>
                立即隐藏
              </Button>
            </Space>
          ) : (
            <Space size={8} wrap align="center">
              <FormAction
                label={props.buttonLabel ?? '查看明文'}
                guard={{ permission: PII_REVEAL_PERMISSION }}
                title={props.dialogTitle ?? '查看个人信息'}
                description={`查看会记入审计日志（谁、何时、为什么）；明文显示 ${PII_REVEAL_AUTO_HIDE_SECONDS} 秒后自动隐藏，不会进入导出与日志。`}
                reason={{ label: '查看原因', placeholder: props.reasonPlaceholder ?? '例如：客服处理该订单的退款咨询' }}
                okText="确认查看"
                buttonProps={{ size: compact ? 'small' : 'middle', icon: <LockOutlined /> }}
                onSubmit={async values => reveal(String(values.reason ?? ''))}
              />
              {kindTags}
              {props.retainedUntil ? <Typography.Text type="secondary">加密保存，保留至 {formatDateTime(props.retainedUntil)}</Typography.Text> : null}
            </Space>
          )}
        </div>
      ) : null}
      {available && result && result.state !== 'OK' ? <Alert style={{ marginTop: 8 }} type="info" showIcon message={result.note ?? STATE_NOTE[result.state]} /> : null}
    </div>
  )
}
