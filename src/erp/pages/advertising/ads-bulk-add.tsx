import { Form, Input, Select } from 'antd'
import { ADS_BULK_ADD_LIMIT, ADS_BULK_ADD_SOURCE_LABEL, splitBulkItems, type AdsBulkAddMode, type AdsBulkAddResponse, type AdsBulkAddSource } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'

// 批量加词（P6-24）：一行一个词，选匹配方式，一次最多 50 个；已存在的词与批内重复的词由服务端跳过并写明原因，其余每个词一条写入记录，在“写入记录”里看结果。
// 词研究（品牌分析搜索词、词级中心）带着候选词进来：initialText 预填，source 记进审计。批量加词没有逐项预览，先读后提交；整批全有或全无由服务端保证。

const OPTIONS = {
  KEYWORD: [
    { value: 'EXACT', label: '精确匹配' },
    { value: 'PHRASE', label: '词组匹配' },
    { value: 'BROAD', label: '广泛匹配' },
  ],
  NEGATIVE: [
    { value: 'NEGATIVE_EXACT', label: '否定精确' },
    { value: 'NEGATIVE_PHRASE', label: '否定词组' },
  ],
} as const

export const linesOf = (text: unknown): string[] =>
  (typeof text === 'string' ? text : '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

export function BulkAddAction({
  mode,
  entityId,
  level,
  source = 'MANUAL',
  initialText = '',
  onDone,
}: {
  mode: AdsBulkAddMode
  /** 广告组（关键词、广告组级否定）或活动（活动级否定）的系统编号。 */
  entityId: string
  level?: 'AD_GROUP' | 'CAMPAIGN'
  source?: AdsBulkAddSource
  initialText?: string
  onDone?: () => void
}) {
  const post = useApiMutation<Record<string, unknown>, AdsBulkAddResponse>({ method: 'POST', path: '/ads/keywords/bulk-add', body: variables => variables, invalidate: ['analytics', 'list'] })
  const options = OPTIONS[mode]
  const noun = mode === 'KEYWORD' ? '关键词' : '否定投放'
  return (
    <FormAction
      label={`批量添加${noun}`}
      title={`批量添加${noun}（一次最多 ${ADS_BULK_ADD_LIMIT} 个）`}
      guard={{ permission: mode === 'KEYWORD' ? 'ads.keyword.write' : 'ads.negative.write' }}
      description={`一行一个词，来源：${ADS_BULK_ADD_SOURCE_LABEL[source]}。已存在的词与重复的词会被跳过并说明；其余的提交后由后台调用亚马逊，结果在写入记录里查看。`}
      initialValues={{ text: initialText, matchType: options[0].value }}
      okText="确认提交"
      successText="已提交，等待亚马逊确认"
      onDone={onDone}
      onSubmit={async values => {
        const lines = linesOf(values.text)
        if (lines.length === 0) throw new Error(`请至少填写一个${noun}`)
        if (lines.length > ADS_BULK_ADD_LIMIT) throw new Error(`一次最多添加 ${ADS_BULK_ADD_LIMIT} 个，请分批提交`)
        const matchType = String(values.matchType)
        const items = lines.map(text => ({ text, matchType }))
        // 提交前先在本地去重一次，让用户明白实际会提交几个（服务端还会和已有的词比对）
        const { pending } = splitBulkItems(items, new Set())
        const result = await post.mutateAsync({ mode, entityId, ...(mode === 'NEGATIVE' ? { level } : {}), source, items: pending.map(({ text, matchType: match }) => ({ text, matchType: match })) })
        if (result.state === 'NOTHING_TO_ADD') throw new Error('这些词都已存在，没有需要添加的')
        return result
      }}
    >
      <Form.Item name="matchType" label="匹配方式">
        <Select aria-label="匹配方式" style={{ width: 200 }} options={[...options]} />
      </Form.Item>
      <Form.Item name="text" label={`${noun}（一行一个）`}>
        <Input.TextArea aria-label={`${noun}列表`} rows={8} />
      </Form.Item>
    </FormAction>
  )
}
