import { Space } from 'antd'
import { type AdsWriteOp } from '@nova/api-contracts'
import { BulkAddAction } from './ads-bulk-add'
import { AdsWriteAction, type AdsWriteSubmit } from './ads-write-action'
import { amountOf, AmountField, MatchField, TextField } from './ads-write-fields'

// 广告组与投放对象详情的写入动作（P3-17）：默认竞价与竞价、暂停与启用；都先预览再提交。
// 提交的请求体是单个修改（对象编号在路径里），预览用同样的内容。

type Item = { path: string; state: string | null }

const toggle = (state: string | null): 'PAUSED' | 'ENABLED' | null => (state === 'ENABLED' ? 'PAUSED' : state === 'PAUSED' ? 'ENABLED' : null)
const single =
  (path: string) =>
  (ops: AdsWriteOp[]): AdsWriteSubmit => {
    const { entityId: _entityId, ...body } = ops[0]!
    return { method: 'PATCH', path, body }
  }

/** 新增类（否定投放、关键词）：请求体带父对象编号，不带 kind（路径已经决定了类型）。 */
const created =
  (path: string) =>
  (ops: AdsWriteOp[]): AdsWriteSubmit => {
    const { kind: _kind, ...body } = ops[0]!
    return { method: 'POST', path, body }
  }

const NEGATIVE_MATCHES = [
  { value: 'NEGATIVE_EXACT', label: '否定精确' },
  { value: 'NEGATIVE_PHRASE', label: '否定词组' },
]
const KEYWORD_MATCHES = [
  { value: 'EXACT', label: '精确匹配' },
  { value: 'PHRASE', label: '词组匹配' },
  { value: 'BROAD', label: '广泛匹配' },
]

/** 广告组下添加否定投放与关键词（广告组级）。 */
function GroupAdds({ id, onDone }: { id: string; onDone?: () => void }) {
  const textOf = (values: Record<string, unknown>) => (typeof values.text === 'string' ? values.text.trim() : '')
  const matchOf = (values: Record<string, unknown>) => (typeof values.matchType === 'string' ? values.matchType : '')
  return (
    <>
      <AdsWriteAction
        label="添加否定投放"
        title="在这个广告组添加否定投放"
        kind="NEGATIVE_ADD"
        initialValues={{ matchType: 'NEGATIVE_EXACT' }}
        fields={
          <>
            <TextField label="否定词" />
            <MatchField options={NEGATIVE_MATCHES} />
          </>
        }
        build={values => (textOf(values) === '' ? '请填写否定词' : [{ kind: 'NEGATIVE_ADD', entityId: id, level: 'AD_GROUP', text: textOf(values), matchType: matchOf(values) }])}
        submit={created('/ads/negatives')}
        onDone={onDone}
      />
      <AdsWriteAction
        label="添加关键词"
        title="在这个广告组添加关键词"
        kind="KEYWORD_ADD"
        initialValues={{ matchType: 'EXACT' }}
        fields={
          <>
            <TextField label="关键词" />
            <MatchField options={KEYWORD_MATCHES} />
            <AmountField label="竞价（美元，可不填）" extra="不填就沿用广告组默认竞价" />
          </>
        }
        build={values => {
          if (textOf(values) === '') return '请填写关键词'
          const amount = amountOf(values)
          return [{ kind: 'KEYWORD_ADD', entityId: id, text: textOf(values), matchType: matchOf(values), ...(amount === null ? {} : { amount }) }]
        }}
        submit={created('/ads/keywords')}
        onDone={onDone}
      />
      <BulkAddAction mode="KEYWORD" entityId={id} onDone={onDone} />
      <BulkAddAction mode="NEGATIVE" entityId={id} level="AD_GROUP" onDone={onDone} />
    </>
  )
}

export function GroupWrites({ id, state, onDone }: { id: string; state: string | null; onDone?: () => void }) {
  const item: Item = { path: `/ads/ad-groups/${encodeURIComponent(id)}`, state }
  const next = toggle(item.state)
  return (
    <Space wrap>
      <GroupAdds id={id} onDone={onDone} />
      <AdsWriteAction
        label="修改默认竞价"
        title="修改广告组默认竞价"
        kind="AD_GROUP_BID"
        fields={<AmountField label="新的默认竞价（美元）" />}
        build={values => {
          const amount = amountOf(values)
          return amount === null ? '请填写新的默认竞价' : [{ kind: 'AD_GROUP_BID', entityId: id, amount }]
        }}
        submit={single(item.path)}
        onDone={onDone}
      />
      {next ? (
        <AdsWriteAction
          label={next === 'PAUSED' ? '暂停' : '启用'}
          title={next === 'PAUSED' ? '暂停广告组' : '启用广告组'}
          kind="AD_GROUP_STATE"
          build={() => [{ kind: 'AD_GROUP_STATE', entityId: id, state: next }]}
          submit={single(item.path)}
          onDone={onDone}
        />
      ) : null}
    </Space>
  )
}

export function TargetWrites({ id, state, onDone }: { id: string; state: string | null; onDone?: () => void }) {
  const path = `/ads/targets/${encodeURIComponent(id)}`
  const next = toggle(state)
  return (
    <Space wrap>
      <AdsWriteAction
        label="调整竞价"
        title="调整投放对象竞价"
        kind="TARGET_BID"
        fields={<AmountField label="新的竞价（美元）" />}
        build={values => {
          const amount = amountOf(values)
          return amount === null ? '请填写新的竞价' : [{ kind: 'TARGET_BID', entityId: id, amount }]
        }}
        submit={single(path)}
        onDone={onDone}
      />
      {next ? (
        <AdsWriteAction
          label={next === 'PAUSED' ? '暂停' : '启用'}
          title={next === 'PAUSED' ? '暂停投放对象' : '启用投放对象'}
          kind="TARGET_STATE"
          build={() => [{ kind: 'TARGET_STATE', entityId: id, state: next }]}
          submit={single(path)}
          onDone={onDone}
        />
      ) : null}
    </Space>
  )
}
