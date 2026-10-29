import { Alert, Form, Input, Select } from 'antd'
import { LISTING_WRITE_LIMITS, listingPatchIssue, type ListingPatchInput, type ListingRunSubmitResponse, type ListingWriteStatuses } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { guardOf } from './listing-quality-state'

// 批量修改（走 Feeds 文件，每个商品一组属性修改）与刊登限制查询（P4-10）。
// 两个动作都只是“已受理”：结果在“操作记录”里看；刊登限制的结果保留 1 小时，显示在“刊登限制”页签。

type StoreOption = { id: string; name: string }

export interface BatchItem {
  sku: string
  patches: ListingPatchInput[]
}

/** 一行一个修改，格式：SKU,属性代码,新取值（同一 SKU 的多行合并成一个商品的多项修改）。 */
export function parseBatchLines(text: string): { items: BatchItem[]; problem: string | null } {
  const bySku = new Map<string, ListingPatchInput[]>()
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  for (const [index, line] of lines.entries()) {
    const parts = line.split(',').map(part => part.trim())
    const [sku, attribute, ...rest] = parts
    const value = rest.join(',').trim()
    if (!sku || !attribute || !value) return { items: [], problem: `第 ${index + 1} 行格式不对：每行是“SKU,属性代码,新取值”` }
    const patch: ListingPatchInput = { op: 'replace', attribute, values: [value] }
    const issue = listingPatchIssue(patch)
    if (issue) return { items: [], problem: `第 ${index + 1} 行：${issue}` }
    bySku.set(sku, [...(bySku.get(sku) ?? []), patch])
  }
  if (bySku.size === 0) return { items: [], problem: '请至少填写一行修改' }
  if (bySku.size > LISTING_WRITE_LIMITS.batchItemsMax) return { items: [], problem: `一次最多 ${LISTING_WRITE_LIMITS.batchItemsMax} 个商品` }
  return { items: [...bySku].map(([sku, patches]) => ({ sku, patches })), problem: null }
}

const storeOptions = (stores: readonly StoreOption[]) => stores.map(store => ({ value: store.id, label: store.name }))

export function BatchAction({ stores, write, onDone }: { stores: readonly StoreOption[]; write: ListingWriteStatuses | undefined; onDone: (runId: string) => void }) {
  const submit = useApiMutation<Record<string, unknown>, ListingRunSubmitResponse>({ method: 'POST', path: '/listings/batch', invalidate: ['realtime'], silent: true })
  return (
    <FormAction
      label="批量修改"
      guard={guardOf(write?.batch)}
      title="批量修改刊登"
      description={
        <Alert
          type="info"
          showIcon
          message="把一批商品的属性修改合成一个文件交给亚马逊处理，由后台任务完成，结果逐个商品写回操作记录。每个商品必须已经同步过商品类型；价格、库存与配送属性不能在这里修改。"
        />
      }
      okText="提交"
      successText="已交给后台任务提交亚马逊"
      initialValues={{ storeId: stores.length === 1 ? stores[0]?.id : undefined }}
      onSubmit={async values => {
        const parsed = parseBatchLines(String(values.lines ?? ''))
        if (parsed.problem) throw new Error(parsed.problem)
        const res = await submit.mutateAsync({ storeId: values.storeId, items: parsed.items })
        onDone(res.run.id)
      }}
    >
      <Form.Item label="店铺" name="storeId" rules={[{ required: true, message: '请选择店铺' }]}>
        <Select aria-label="店铺" options={storeOptions(stores)} placeholder="选择店铺" />
      </Form.Item>
      <Form.Item label="修改内容（每行：SKU,属性代码,新取值）" name="lines" rules={[{ required: true, whitespace: true, message: '请填写修改内容' }]}>
        <Input.TextArea aria-label="修改内容" rows={6} placeholder={'SKU-1,item_name,新的标题\nSKU-2,color,Blue'} />
      </Form.Item>
    </FormAction>
  )
}

const CONDITIONS = [
  { value: 'new_new', label: '全新' },
  { value: 'new_open_box', label: '全新（开箱）' },
  { value: 'used_like_new', label: '二手-几乎全新' },
  { value: 'used_very_good', label: '二手-非常好' },
  { value: 'used_good', label: '二手-良好' },
  { value: 'used_acceptable', label: '二手-可接受' },
]

export function RestrictionsAction({ stores, write, onDone }: { stores: readonly StoreOption[]; write: ListingWriteStatuses | undefined; onDone: (runId: string) => void }) {
  const submit = useApiMutation<Record<string, unknown>, ListingRunSubmitResponse>({ method: 'POST', path: '/listings/restrictions', invalidate: ['realtime'], silent: true })
  return (
    <FormAction
      label="检查刊登限制"
      guard={guardOf(write?.validate)}
      title="检查刊登限制"
      description={<Alert type="info" showIcon message={`查询这个店铺能不能刊登这些 ASIN（品牌、类目审核等限制）。一次最多 ${LISTING_WRITE_LIMITS.restrictionsAsinsMax} 个，结果保留 1 小时。`} />}
      okText="查询"
      successText="已提交查询，结果出来后显示在“刊登限制”页签"
      initialValues={{ storeId: stores.length === 1 ? stores[0]?.id : undefined, conditionType: 'new_new' }}
      onSubmit={async values => {
        const asins = String(values.asins ?? '')
          .split(/[\s,，;；]+/)
          .map(asin => asin.trim())
          .filter(Boolean)
        const res = await submit.mutateAsync({ storeId: values.storeId, asins, conditionType: values.conditionType })
        onDone(res.run.id)
      }}
    >
      <Form.Item label="店铺" name="storeId" rules={[{ required: true, message: '请选择店铺' }]}>
        <Select aria-label="店铺" options={storeOptions(stores)} placeholder="选择店铺" />
      </Form.Item>
      <Form.Item label="ASIN（空格、逗号或换行分隔）" name="asins" rules={[{ required: true, whitespace: true, message: '请填写 ASIN' }]}>
        <Input.TextArea aria-label="ASIN" rows={3} />
      </Form.Item>
      <Form.Item label="商品状况" name="conditionType">
        <Select aria-label="商品状况" options={CONDITIONS} />
      </Form.Item>
    </FormAction>
  )
}
