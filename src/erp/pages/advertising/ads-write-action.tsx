import { useState, type ReactNode } from 'react'
import { Form } from 'antd'
import { ADS_WRITE_KIND_INFO, type AdsWriteKind, type AdsWriteOp, type AdsWritePreviewResponse, type AdsWriteSubmitResponse } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { PreviewPanel } from './ads-write-preview'

// 广告写入动作（P3-17）：按钮 → 填取值 → “预览修改” → 确认提交。只有预览通过（有权限、有广告授权、开关开着、对象在范围内、取值合法）才能提交；
// 取值改了要重新预览。提交只调服务端，结果以服务端为准：成功只表示“已排队”，亚马逊的确认在“写入记录”里看。

export type AdsWriteSubmit = { method: 'PATCH' | 'POST'; path: string; body: unknown }

export function AdsWriteAction({
  label,
  title,
  kind,
  build,
  submit,
  fields,
  initialValues,
  condition,
  description,
  onDone,
  danger,
}: {
  label: string
  title: string
  /** 权限按这类写入的权限点判断（提交时服务端会再判断一次）。 */
  kind: AdsWriteKind
  /** 由表单取值得到要写入的内容；取值还不完整时返回提示文字。 */
  build: (values: Record<string, unknown>) => AdsWriteOp[] | string
  /** 提交用的请求（各入口的路径与请求体不同）。 */
  submit: (ops: AdsWriteOp[]) => AdsWriteSubmit
  fields?: ReactNode
  initialValues?: Record<string, unknown>
  condition?: { ok: boolean; reason: string }
  description?: ReactNode
  onDone?: () => void
  danger?: boolean
}) {
  const [preview, setPreview] = useState<{ key: string; data: AdsWritePreviewResponse } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const previewMutation = useApiMutation<{ ops: AdsWriteOp[] }, AdsWritePreviewResponse>({ method: 'POST', path: '/ads/preview', silent: true })
  const post = useApiMutation<AdsWriteSubmit, AdsWriteSubmitResponse>({ method: 'POST', path: variables => variables.path, body: variables => variables.body, invalidate: ['analytics', 'list'] })
  const patch = useApiMutation<AdsWriteSubmit, AdsWriteSubmitResponse>({ method: 'PATCH', path: variables => variables.path, body: variables => variables.body, invalidate: ['analytics', 'list'] })
  const keyOf = (ops: AdsWriteOp[]) => JSON.stringify(ops)

  const runPreview = async (ops: AdsWriteOp[]) => {
    setPreviewError(null)
    try {
      const data = await previewMutation.mutateAsync({ ops })
      setPreview({ key: keyOf(ops), data })
    } catch (error) {
      setPreview(null)
      setPreviewError(error instanceof Error ? error.message : '预览失败，请稍后重试')
    }
  }

  return (
    <FormAction
      label={label}
      title={title}
      guard={{ permission: ADS_WRITE_KIND_INFO[kind].permission, ...(condition ? { condition } : {}) }}
      description={description ?? '先预览，确认修改前后的值、提醒和开关状态后再提交；提交后由后台调用亚马逊，结果在写入记录里查看。'}
      initialValues={initialValues}
      okText="确认提交"
      successText="已提交，等待亚马逊确认"
      danger={danger}
      onDone={() => {
        setPreview(null)
        onDone?.()
      }}
      onSubmit={async values => {
        const ops = build(values)
        if (typeof ops === 'string') throw new Error(ops)
        if (!preview || preview.key !== keyOf(ops)) throw new Error('请先点击“预览修改”，确认结果后再提交')
        if (!preview.data.canSubmit) throw new Error(preview.data.reason ?? '预览没有通过，不能提交')
        const request = submit(ops)
        return (request.method === 'PATCH' ? patch : post).mutateAsync(request)
      }}
    >
      {fields}
      <Form.Item noStyle shouldUpdate>
        {({ getFieldsValue }) => {
          const built = build(getFieldsValue(true) as Record<string, unknown>)
          const ops = typeof built === 'string' ? null : built
          return (
            <PreviewPanel
              data={preview?.data ?? null}
              loading={previewMutation.isPending}
              error={previewError}
              stale={ops !== null && preview !== null && preview.key !== keyOf(ops)}
              blocked={typeof built === 'string' ? built : null}
              onPreview={() => ops && void runPreview(ops)}
            />
          )
        }}
      </Form.Item>
    </FormAction>
  )
}
