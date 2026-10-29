import { useState } from 'react'
import { Alert, Button, Descriptions, Drawer, Form, Input, Select, Space, Tag } from 'antd'
import { LISTING_SEVERITY_LABEL, listingPatchIssue, type ListingIssueRow, type ListingPatchInput, type ListingRunSubmitResponse, type ListingWriteStatuses } from '@nova/api-contracts'
import { ActionGuard } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { RunSummary, useListingRun } from './ListingRunPanel'
import { guardOf } from './listing-quality-state'

// 修复一个刊登问题（P4-10）：先填写要改的属性，做“校验预览”（亚马逊只检查、不修改），通过后才能“提交修改”。
// 提交的内容必须与校验过的完全一致、预览 30 分钟内有效（服务端核对）；改了任何一项都要重新校验。
// 价格、库存与配送属性不能在这里修改。两步都只是“已受理”，结果以操作记录里的状态为准。

interface FormValues {
  op: 'replace' | 'delete'
  attribute: string
  values: string
  productType: string
}

const patchOf = (values: FormValues): ListingPatchInput => ({
  op: values.op,
  attribute: values.attribute.trim(),
  ...(values.op === 'replace'
    ? {
        values: values.values
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean),
      }
    : {}),
})

const withDefaults = (given: Partial<FormValues>, attribute: string): FormValues => ({
  op: given.op ?? 'replace',
  attribute: given.attribute ?? attribute,
  values: given.values ?? '',
  productType: given.productType ?? '',
})

export function ListingFixDrawer({ row, write, onClose }: { row: ListingIssueRow | null; write: ListingWriteStatuses | undefined; onClose: () => void }) {
  const [form] = Form.useForm<FormValues>()
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [patchId, setPatchId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const watched = Form.useWatch([], form)
  const preview = useListingRun(previewId)
  const patched = useListingRun(patchId)
  const validate = useApiMutation<Record<string, unknown>, ListingRunSubmitResponse>({ method: 'POST', path: '/listings/validate', invalidate: ['realtime'], silent: true })
  const patch = useApiMutation<Record<string, unknown>, ListingRunSubmitResponse>({ method: 'POST', path: '/listings/patch', invalidate: ['realtime', 'list'], silent: true })

  const close = () => {
    setPreviewId(null)
    setPatchId(null)
    setError(null)
    form.resetFields()
    onClose()
  }
  const current = (): FormValues => withDefaults(form.getFieldsValue(), row?.attributeName ?? '')
  const bodyOf = (values: FormValues) => ({ storeId: row?.storeId, sku: row?.sku, ...(values.productType.trim() ? { productType: values.productType.trim() } : {}), patches: [patchOf(values)] })
  const problem = row && watched ? listingPatchIssue(patchOf(withDefaults(watched, ''))) : null
  const verdict = preview.data
  const approved = Boolean(verdict && verdict.validation === 'VALID' && verdict.usableUntil)

  const runValidate = async () => {
    setError(null)
    setPatchId(null)
    try {
      const res = await validate.mutateAsync(bodyOf(current()))
      setPreviewId(res.run.id)
    } catch (failure) {
      const info = describeError(failure)
      setError(info.requestId ? `${info.message}（请求编号 ${info.requestId}）` : info.message)
    }
  }

  return (
    <Drawer open={Boolean(row)} onClose={close} width={560} title="修复刊登问题" destroyOnClose data-testid="listing-fix-drawer">
      {row ? (
        <>
          <Descriptions size="small" column={1} bordered style={{ marginBottom: 12 }}>
            <Descriptions.Item label="商品">
              {row.title ?? '（商品目录里没有这个商品）'} · {row.asin || '尚无 ASIN'} · {row.sku}
            </Descriptions.Item>
            <Descriptions.Item label="问题">
              <Tag color={row.severity === 'ERROR' ? 'red' : 'gold'}>{LISTING_SEVERITY_LABEL[row.severity]}</Tag>
              {row.message}
            </Descriptions.Item>
            <Descriptions.Item label="建议">{row.advice}</Descriptions.Item>
          </Descriptions>
          <Form<FormValues>
            form={form}
            layout="vertical"
            requiredMark={false}
            initialValues={{ op: 'replace', attribute: row.attributeName, values: '', productType: '' }}
            onValuesChange={() => {
              setPreviewId(null)
              setPatchId(null)
            }}
          >
            <Form.Item label="操作" name="op">
              <Select
                aria-label="操作"
                options={[
                  { value: 'replace', label: '修改属性值' },
                  { value: 'delete', label: '删除属性' },
                ]}
              />
            </Form.Item>
            <Form.Item label="属性名（亚马逊属性代码，例如 item_name、color）" name="attribute">
              <Input aria-label="属性名" maxLength={64} />
            </Form.Item>
            {watched?.op === 'delete' ? null : (
              <Form.Item label="新的取值（一行一个）" name="values">
                <Input.TextArea aria-label="新的取值" rows={3} maxLength={2000} />
              </Form.Item>
            )}
            <Form.Item label="商品类型（选填，已同步过的商品不用填）" name="productType">
              <Input aria-label="商品类型" maxLength={80} placeholder="例如 LUGGAGE" />
            </Form.Item>
          </Form>
          {problem ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={problem} /> : null}
          {error ? <Alert type="error" showIcon role="alert" style={{ marginBottom: 8 }} message={error} /> : null}
          <Space wrap>
            <Button type="primary" onClick={() => void runValidate()} loading={validate.isPending} disabled={Boolean(problem) || !watched?.attribute}>
              校验预览
            </Button>
            {approved && verdict ? (
              <ActionGuard
                label="提交修改"
                guard={guardOf(write?.update)}
                preview={{
                  title: '确认提交修改',
                  content: (
                    <p>
                      将把 {row.sku} 的「{watched?.attribute}」提交到亚马逊，由后台任务完成；提交内容与刚才校验过的一致。
                    </p>
                  ),
                  confirmText: '确认提交',
                }}
                successText="已交给后台任务提交亚马逊"
                onExecute={async () => {
                  const res = await patch.mutateAsync({ ...bodyOf(current()), previewRunId: verdict.id })
                  setPatchId(res.run.id)
                }}
                buttonProps={{ type: 'primary' }}
              />
            ) : null}
          </Space>
          {preview.data ? (
            <div style={{ marginTop: 12 }}>
              <strong>校验预览</strong>
              <RunSummary run={preview.data} />
            </div>
          ) : null}
          {patched.data ? (
            <div style={{ marginTop: 12 }}>
              <strong>修改结果</strong>
              <RunSummary run={patched.data} />
            </div>
          ) : null}
        </>
      ) : null}
    </Drawer>
  )
}
