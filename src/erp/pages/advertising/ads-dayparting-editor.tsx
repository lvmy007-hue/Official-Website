import { useState } from 'react'
import { Form, Input, InputNumber, Radio, Select } from 'antd'
import {
  DAYPARTING_KIND_LABEL,
  DAYPARTING_KINDS,
  DAYPARTING_LEVEL_LABEL,
  DAYPARTING_MULTIPLIER,
  DAYPARTING_NAME_MAX,
  DAYPARTING_STATUS_LABEL,
  DAYPARTING_STATUSES,
  DAYPARTING_WRITE,
  neutralGrid,
  type AdsCampaignListResponse,
  type DaypartingKind,
  type DaypartingProfileOption,
  type DaypartingStrategyRow,
  type DaypartingWriteResult,
} from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { GridEditor } from './ads-dayparting-grid'

// 创建与修改分时策略（P3-12）：只改本系统里的策略，不写亚马逊。创建时选广告账户、类型与作用的活动并画出 168 格取值；
// 修改时账户、类型、层级不可改（改了等于另一个策略），其余可改，带版本号，别人先改了会提示刷新。页面目前只提供“活动”层级的选择；广告组层级的策略可读、可改取值，但对象要通过接口改。

type FormValues = Record<string, unknown>

function KindField() {
  const form = Form.useFormInstance()
  return (
    <Form.Item name="kind" label="策略类型">
      <Radio.Group
        options={DAYPARTING_KINDS.map(value => ({ value, label: DAYPARTING_KIND_LABEL[value] }))}
        onChange={() => {
          form.setFieldValue('grid', neutralGrid())
          form.setFieldValue('baseBid', undefined)
        }}
      />
    </Form.Item>
  )
}

function TargetsField({ strategy }: { strategy?: DaypartingStrategyRow }) {
  const profileId = Form.useWatch('adsProfileId') as string | undefined
  const [q, setQ] = useState('')
  const readOnly = strategy?.level === 'AD_GROUP'
  const query = useApiQuery<AdsCampaignListResponse>({
    domain: 'analytics',
    path: '/ads/campaigns',
    params: { q: q || undefined, pageSize: 200, sort: 'name:asc' },
    scoped: false,
    enabled: Boolean(profileId) && !readOnly,
  })
  const loaded = (query.data?.items ?? []).filter(item => item.adsProfileId === profileId).map(item => ({ value: item.id, label: item.name }))
  // 已选中的对象即使不在当前搜索结果里也要保留名称
  const known = new Map<string, string>([...(strategy?.targets ?? []).map(target => [target.id, target.name ?? '已不存在的对象'] as const), ...loaded.map(item => [item.value, item.label] as const)])
  return (
    <Form.Item
      name="targetIds"
      label={`作用的${readOnly ? '广告组' : '活动'}（最多 200 个）`}
      rules={[{ required: true, type: 'array', min: 1, message: '至少选择一个对象' }]}
      extra={readOnly ? '这是广告组层级的策略，对象在页面里不能改' : '只列出所选广告账户下的活动；输入名称可搜索更多'}
    >
      <Select
        mode="multiple"
        showSearch
        disabled={readOnly}
        loading={query.isFetching}
        placeholder={profileId ? '搜索并选择活动' : '先选择广告账户'}
        filterOption={false}
        onSearch={setQ}
        options={[...known.entries()].map(([value, label]) => ({ value, label }))}
      />
    </Form.Item>
  )
}

function BaseBidField({ fixedKind }: { fixedKind?: DaypartingKind }) {
  const watched = Form.useWatch('kind') as DaypartingKind | undefined
  if ((fixedKind ?? watched) !== 'BID_MULTIPLIER') return null
  return (
    <Form.Item name="baseBid" label="基准竞价（美元，可不填）" extra="只是策略记录的参考值，目前不会被用来改亚马逊竞价">
      <InputNumber min={0.01} max={1000} step={0.05} precision={2} style={{ width: 160 }} />
    </Form.Item>
  )
}

function GridField({ fixedKind }: { fixedKind?: DaypartingKind }) {
  const watched = (Form.useWatch('kind') as DaypartingKind | undefined) ?? 'ON_OFF'
  const kind = fixedKind ?? watched
  return (
    <Form.Item name="grid" label={`一周 168 个小时格的取值（${kind === 'ON_OFF' ? '暂停或启用' : `竞价系数 ${DAYPARTING_MULTIPLIER.min} 至 ${DAYPARTING_MULTIPLIER.max}`}）`}>
      <GridEditor kind={kind} />
    </Form.Item>
  )
}

export function StrategyEditor({ strategy, profiles, onDone }: { strategy?: DaypartingStrategyRow; profiles: readonly DaypartingProfileOption[]; onDone?: () => void }) {
  const editing = strategy !== undefined
  const mutation = useApiMutation<{ id?: string; body: Record<string, unknown> }, DaypartingWriteResult>({
    method: editing ? 'PATCH' : 'POST',
    path: variables => (variables.id ? `/ads/dayparting/${variables.id}` : '/ads/dayparting'),
    body: variables => variables.body,
    invalidate: ['analytics', 'list'],
    silent: true,
  })
  const initial: FormValues = strategy
    ? {
        name: strategy.name,
        adsProfileId: strategy.adsProfileId,
        kind: strategy.kind,
        level: strategy.level,
        targetIds: strategy.targets.map(target => target.id),
        grid: strategy.grid,
        baseBid: strategy.baseBid ?? undefined,
        timezone: strategy.timezone,
        status: strategy.status,
      }
    : { kind: 'ON_OFF', level: 'CAMPAIGN', targetIds: [], grid: neutralGrid(), status: 'PAUSED' }
  return (
    <FormAction
      label={editing ? '编辑' : '新建策略'}
      title={editing ? `编辑分时策略：${strategy.name}` : '新建分时策略'}
      guard={{ permission: DAYPARTING_WRITE }}
      description="策略保存在本系统里；已启用的策略每小时按所在时区的当前时段执行，写入亚马逊需要对应的写入开关。"
      initialValues={initial}
      okText="保存"
      successText="已保存"
      onDone={onDone}
      buttonProps={editing ? { type: 'link', size: 'small' } : { type: 'primary' }}
      onSubmit={async values => {
        const kind = (editing ? strategy.kind : values.kind) as DaypartingKind
        const baseBid = typeof values.baseBid === 'number' ? values.baseBid : null
        const common = {
          name: String(values.name ?? '').trim(),
          targetIds: values.targetIds,
          grid: values.grid,
          timezone: values.timezone ? String(values.timezone).trim() : undefined,
          status: values.status,
        }
        if (editing) {
          return mutation.mutateAsync({
            id: strategy.id,
            body: { ...common, version: strategy.version, ...(kind === 'BID_MULTIPLIER' ? { baseBid } : {}), ...(strategy.level === 'AD_GROUP' ? { targetIds: undefined } : {}) },
          })
        }
        return mutation.mutateAsync({ body: { ...common, adsProfileId: values.adsProfileId, kind, level: 'CAMPAIGN', ...(kind === 'BID_MULTIPLIER' && baseBid !== null ? { baseBid } : {}) } })
      }}
    >
      <Form.Item
        name="name"
        label="策略名称"
        rules={[
          { required: true, whitespace: true, message: '请填写名称' },
          { max: DAYPARTING_NAME_MAX, message: `最多 ${DAYPARTING_NAME_MAX} 个字` },
        ]}
      >
        <Input maxLength={DAYPARTING_NAME_MAX + 20} placeholder="例如：夜间降价" />
      </Form.Item>
      <Form.Item name="adsProfileId" label="广告账户" rules={[{ required: true, message: '请选择广告账户' }]}>
        <Select
          disabled={editing}
          placeholder="选择广告账户"
          options={profiles.map(profile => ({ value: profile.id, label: profile.storeName ? `${profile.name}（${profile.storeName}）` : profile.name }))}
        />
      </Form.Item>
      {editing ? (
        <Form.Item label="策略类型">
          <span>
            {DAYPARTING_KIND_LABEL[strategy.kind]}，作用于{DAYPARTING_LEVEL_LABEL[strategy.level]}
          </span>
        </Form.Item>
      ) : (
        <KindField />
      )}
      <TargetsField strategy={strategy} />
      <GridField fixedKind={strategy?.kind} />
      <BaseBidField fixedKind={strategy?.kind} />
      <Form.Item name="timezone" label="时区（留空用广告账户或企业的时区）" extra="例如 America/Los_Angeles；格子按这个时区的星期与小时对应">
        <Input placeholder="America/Los_Angeles" />
      </Form.Item>
      <Form.Item name="status" label="状态" extra="已暂停的策略不会被调度，也不会改变亚马逊账户">
        <Radio.Group options={DAYPARTING_STATUSES.map(value => ({ value, label: DAYPARTING_STATUS_LABEL[value] }))} />
      </Form.Item>
    </FormAction>
  )
}
