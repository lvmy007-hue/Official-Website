import { Form, Radio, Select } from 'antd'
import { ADS_CAMPAIGN_TAG_LIMITS, ADS_CAMPAIGN_WRITE, type AdsCampaignMetaResult } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'

// 批量设置标签与负责人（08 章 8.3 批量动作中不写亚马逊的部分）：只改本系统里的标签与负责人，每个活动带版本号，别人先改了会提示刷新。

const KEEP = '__keep'
const CLEAR = '__clear'

type Target = { id: string; version: number }

export function MetaAction({
  targets,
  members,
  label = '设置标签与负责人',
  onDone,
}: {
  targets: readonly Target[]
  members: ReadonlyArray<{ id: string; name: string }>
  label?: string
  onDone?: () => void
}) {
  const mutation = useApiMutation<Record<string, unknown>, AdsCampaignMetaResult>({ method: 'PATCH', path: '/ads/campaigns/meta', invalidate: ['analytics', 'list'] })
  return (
    <FormAction
      label={label}
      title={`设置标签与负责人（${targets.length} 个活动）`}
      guard={{ permission: ADS_CAMPAIGN_WRITE, condition: { ok: targets.length > 0, reason: '请先勾选活动' } }}
      description="只修改本系统里的标签与负责人，不会改动亚马逊广告账户。"
      initialValues={{ tagMode: 'ADD', tags: [], owner: KEEP }}
      okText="保存"
      successText="已保存"
      onDone={onDone}
      onSubmit={async values => {
        const mode = String(values.tagMode ?? 'ADD')
        const tags = ((values.tags as string[] | undefined) ?? []).map(tag => tag.trim()).filter(Boolean)
        const owner = String(values.owner ?? KEEP)
        const changesTags = mode === 'SET' || tags.length > 0
        if (!changesTags && owner === KEEP) throw new Error('请至少修改标签或负责人其中一项')
        return mutation.mutateAsync({
          items: targets.map(target => ({ id: target.id, version: target.version })),
          ...(changesTags ? { tags: { mode, values: tags } } : {}),
          ...(owner === KEEP ? {} : { ownerId: owner === CLEAR ? null : owner }),
        })
      }}
    >
      <Form.Item name="tagMode" label="标签处理方式">
        <Radio.Group
          options={[
            { value: 'ADD', label: '追加' },
            { value: 'REMOVE', label: '移除' },
            { value: 'SET', label: '整体替换（留空即清空）' },
          ]}
        />
      </Form.Item>
      <Form.Item name="tags" label={`标签（每个最多 ${ADS_CAMPAIGN_TAG_LIMITS.MAX_LENGTH} 个字）`}>
        <Select mode="tags" tokenSeparators={[',', '，']} placeholder="输入后回车添加" open={false} />
      </Form.Item>
      <Form.Item name="owner" label="负责人">
        <Select
          showSearch
          optionFilterProp="label"
          options={[{ value: KEEP, label: '不修改' }, { value: CLEAR, label: '清空负责人' }, ...members.map(member => ({ value: member.id, label: member.name }))]}
        />
      </Form.Item>
    </FormAction>
  )
}
