import { useState } from 'react'
import { Alert, Form, Input, Modal, Select } from 'antd'
import { COMPETITOR_LIMITS, type CompetitorAddResult } from '@nova/api-contracts'
import { useApiMutation } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { asinIssue } from './competitors-state'

// 手工添加竞品（P4-12）：竞品 ASIN 与店铺必填，我方对应 ASIN 选填（不填就没有价格差与名次差）。
// 只改本系统里的关注清单，不调用亚马逊；新关注的竞品要等下一次同步（每 6 小时一次）才有数据。

interface FormValues {
  storeId: string
  asin: string
  ownAsin?: string
  note?: string
}

const checkRule = (check: (value: string | undefined) => string | null) => ({
  validator: async (_rule: unknown, value: string | undefined) => {
    const issue = check(value)
    if (issue) throw new Error(issue)
  },
})

export function AddCompetitorModal({
  open,
  stores,
  onClose,
  onAdded,
}: {
  open: boolean
  stores: Array<{ id: string; name: string }>
  onClose: () => void
  onAdded: (result: CompetitorAddResult) => void
}) {
  const [form] = Form.useForm<FormValues>()
  const [error, setError] = useState<string | null>(null)
  const add = useApiMutation<Record<string, unknown>, CompetitorAddResult>({ method: 'POST', path: '/competitors', invalidate: ['list'], silent: true })

  const submit = async () => {
    setError(null)
    try {
      await form.validateFields()
    } catch {
      return
    }
    const values = form.getFieldsValue(true) as FormValues
    const own = (values.ownAsin ?? '').trim().toUpperCase()
    try {
      const result = await add.mutateAsync({
        storeId: values.storeId,
        asin: values.asin.trim().toUpperCase(),
        ...(own ? { ownAsin: own } : {}),
        reason: 'MANUAL',
        ...(values.note?.trim() ? { note: values.note.trim() } : {}),
      })
      onAdded(result)
      onClose()
    } catch (failure) {
      const info = describeError(failure)
      setError(info.requestId ? `${info.message}（请求编号 ${info.requestId}）` : info.message)
    }
  }

  return (
    <Modal open={open} onCancel={onClose} destroyOnClose title="手工添加竞品" okText="加入关注" cancelText="取消" confirmLoading={add.isPending} onOk={() => void submit()}>
      <Form<FormValues> form={form} layout="vertical" requiredMark={false} initialValues={{ storeId: stores[0]?.id }} preserve={false}>
        <Form.Item label="店铺" name="storeId" rules={[{ required: true, message: '请选择店铺' }]}>
          <Select aria-label="店铺" options={stores.map(store => ({ value: store.id, label: store.name }))} />
        </Form.Item>
        <Form.Item label="竞品 ASIN" name="asin" rules={[checkRule(value => asinIssue(value))]}>
          <Input aria-label="竞品 ASIN" maxLength={10} placeholder="例如 B0ABCDE123" />
        </Form.Item>
        <Form.Item
          label="对应的我方商品 ASIN（选填）"
          name="ownAsin"
          extra="填写后才能算价格差、名次差与在我方核心搜索词中的点击份额；必须是这个店铺商品目录里的 ASIN。"
          rules={[checkRule(value => (value ? asinIssue(value, '我方对应 ASIN') : null))]}
        >
          <Input aria-label="我方对应 ASIN" maxLength={10} placeholder="例如 B0ABCDE123" />
        </Form.Item>
        <Form.Item label="备注（选填）" name="note">
          <Input aria-label="备注" maxLength={COMPETITOR_LIMITS.noteMax} />
        </Form.Item>
        <Alert type="info" showIcon message="只用官方接口与报告获取竞品数据，不抓取亚马逊前台页面；新关注的竞品要等下一次同步（每 6 小时一次）才会出现数据。" />
        {error ? <Alert type="error" showIcon role="alert" style={{ marginTop: 8 }} message={error} /> : null}
      </Form>
    </Modal>
  )
}
