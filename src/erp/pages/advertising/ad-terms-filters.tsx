import { useState } from 'react'
import { Alert, Button, Input, Popover, Select, Space } from 'antd'
import {
  AD_TERM_ANOMALIES,
  AD_TERM_ANOMALY_LABEL,
  AD_TERM_NEGATIVE_LEVELS,
  AD_TERM_NEGATIVE_LEVEL_LABEL,
  AD_TERM_SORT_LABEL,
  AD_TERM_SUBJECTS,
  AD_TERMS_VIEW_PAGE_KEY,
  ADS_TERM_STATUS_LABEL,
  anomalyAppliesTo,
  type AdTermSort,
} from '@nova/api-contracts'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { parseView, sortFieldsOf, TERM_STATUSES, type TermsState, type TermSortField } from './ad-terms-state'

// 词级中心的筛选条与保存视图（P3-10）。保存视图走已有的 /views 接口，页面标识 ad-terms，保存的是 TermsState。

const sortLabel = (field: TermSortField): string => (field === 'terms' ? '搜索词数' : field === 'stores' ? '店铺数' : AD_TERM_SORT_LABEL[field as AdTermSort])

type Patch = (patch: Partial<TermsState>) => void

export function TermFilters({ state, onChange }: { state: TermsState; onChange: Patch }) {
  const { tab } = state
  const sorts = sortFieldsOf(tab)
  const anomalies = tab === 'quadrant' ? AD_TERM_ANOMALIES.filter(anomaly => anomalyAppliesTo(anomaly, 'quadrant')) : []
  return (
    <Space wrap style={{ marginBottom: 12 }} data-testid="term-filters">
      <Input.Search
        key={`${tab}|${state.q ?? ''}`}
        allowClear
        style={{ width: 260 }}
        placeholder={tab === 'roots' ? '词根包含' : '词包含'}
        aria-label="关键字"
        defaultValue={state.q}
        onSearch={value => onChange({ q: value.trim() || undefined })}
      />
      {tab === 'search-terms' ? (
        <Select
          allowClear
          placeholder="全部状态"
          aria-label="搜索词状态"
          style={{ width: 130 }}
          value={state.status}
          onChange={value => onChange({ status: value })}
          options={TERM_STATUSES.map(value => ({ value, label: ADS_TERM_STATUS_LABEL[value] }))}
        />
      ) : null}
      {tab === 'negatives' ? (
        <Select
          allowClear
          placeholder="全部层级"
          aria-label="否定层级"
          style={{ width: 130 }}
          value={state.level}
          onChange={value => onChange({ level: value })}
          options={AD_TERM_NEGATIVE_LEVELS.map(value => ({ value, label: AD_TERM_NEGATIVE_LEVEL_LABEL[value] }))}
        />
      ) : null}
      {tab === 'targets' || tab === 'negatives' ? (
        <Input.Search
          key={`match|${tab}|${state.matchType ?? ''}`}
          allowClear
          style={{ width: 200 }}
          placeholder="匹配方式（如 EXACT）"
          aria-label="匹配方式"
          defaultValue={state.matchType}
          onSearch={value => onChange({ matchType: value.trim() || undefined })}
        />
      ) : null}
      {tab === 'quadrant' ? (
        <>
          <Select
            aria-label="四象限对象"
            style={{ width: 130 }}
            value={state.subject}
            onChange={value => onChange({ subject: value })}
            options={AD_TERM_SUBJECTS.map(value => ({ value, label: value === 'targets' ? '投放词' : '搜索词' }))}
          />
          <Select
            allowClear
            placeholder="全部词"
            aria-label="异常分组"
            style={{ width: 190 }}
            value={state.anomaly}
            onChange={value => onChange({ anomaly: value })}
            options={anomalies.map(value => ({ value, label: AD_TERM_ANOMALY_LABEL[value] }))}
          />
        </>
      ) : null}
      {sorts.length > 1 ? (
        <Select
          aria-label="排序"
          virtual={false}
          style={{ width: 150 }}
          value={state.sort}
          onChange={value => onChange({ sort: value })}
          options={sorts.map(value => ({ value, label: `按${sortLabel(value)}` }))}
        />
      ) : null}
      {sorts.length > 0 ? (
        <Button aria-label="排序方向" onClick={() => onChange({ dir: state.dir === 'desc' ? 'asc' : 'desc' })}>
          {state.dir === 'desc' ? '从高到低' : '从低到高'}
        </Button>
      ) : null}
    </Space>
  )
}

type SavedItem = { id: string; name: string; mine: boolean; version: number; filter: unknown }

/** 保存视图：下拉选择已保存的视图应用；输入名称保存当前条件（同名覆盖自己的旧视图）。 */
export function TermViews({ state, onApply }: { state: TermsState; onApply: (state: TermsState) => void }) {
  const list = useApiQuery<{ items: SavedItem[] }>({ domain: 'config', path: '/views', scoped: false, params: { pageKey: AD_TERMS_VIEW_PAGE_KEY } })
  const [name, setName] = useState('')
  const [open, setOpen] = useState(false)
  const create = useApiMutation<string, unknown>({
    method: 'POST',
    path: '/views',
    body: value => ({ pageKey: AD_TERMS_VIEW_PAGE_KEY, name: value, filterJson: state, columnsJson: [], sortJson: [], shared: false, isDefault: false }),
    invalidate: ['config'],
  })
  const update = useApiMutation<{ id: string; version: number }, unknown>({
    method: 'PATCH',
    path: value => `/views/${encodeURIComponent(value.id)}`,
    body: value => ({ version: value.version, filterJson: state }),
    invalidate: ['config'],
  })
  const items = list.data?.items ?? []
  const saving = create.isPending || update.isPending
  const error = create.error ?? update.error

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const same = items.find(item => item.mine && item.name === trimmed)
    if (same) await update.mutateAsync({ id: same.id, version: same.version })
    else await create.mutateAsync(trimmed)
    setName('')
    setOpen(false)
  }

  return (
    <Space wrap style={{ marginBottom: 12 }} data-testid="term-views">
      <Select
        allowClear
        placeholder={list.isPending ? '正在读取保存的视图' : items.length === 0 ? '还没有保存的视图' : '应用保存的视图'}
        aria-label="保存的视图"
        style={{ width: 220 }}
        disabled={items.length === 0}
        options={items.map(item => ({ value: item.id, label: item.mine ? item.name : `${item.name}（他人共享）` }))}
        onChange={(id?: string) => {
          const next = parseView(items.find(item => item.id === id)?.filter)
          if (next) onApply(next)
        }}
      />
      <Popover
        trigger="click"
        open={open}
        onOpenChange={setOpen}
        title="保存当前筛选为视图"
        content={
          <Space direction="vertical">
            <Input
              value={name}
              maxLength={40}
              placeholder="视图名称（同名会覆盖你自己的旧视图）"
              aria-label="视图名称"
              onChange={event => setName(event.target.value)}
              onPressEnter={() => void save()}
            />
            <Button type="primary" loading={saving} disabled={!name.trim()} onClick={() => void save()}>
              保存
            </Button>
          </Space>
        }
      >
        <Button>保存当前视图</Button>
      </Popover>
      {error ? <Alert type="error" showIcon message={describeError(error).message} /> : null}
    </Space>
  )
}
