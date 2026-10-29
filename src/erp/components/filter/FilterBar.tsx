import { useState, type ReactNode } from 'react'
import { Badge, Button, Input, Popover, Select, Space, Tag } from 'antd'
import { CloseOutlined, FilterOutlined } from '@ant-design/icons'
import { BatchSearchModal } from './BatchSearchModal'
import { FieldControl } from './FilterControls'
import { activeMode, appliedCount, appliedTags, searchPatch, type FilterField, type FilterPatch, type FilterValues, type SearchMode } from './filter-model'
import './filter.css'

// 筛选栏（P6-04，15 章第 7 节）：常驻区 3 到 5 个筛选 + 搜索框（可切换按什么搜，支持一次粘贴多行批量搜索，最多 500 个）；
// 右侧固定“更多筛选”（按钮上显示已生效的条件数）与“重置”；已生效的条件以标签排在下面，可逐个删除。
// 日期与对比不在这里：全局日期在顶部范围栏，页面自己有日期字段时放进 leading 插槽（同一个 DateRangeControl）。
// 筛选值由页面持有（通常是 useUrlFilters，写进地址栏）；本组件不保存状态，改一项就调一次 onChange。

export type FilterBarProps = {
  fields: readonly FilterField[]
  modes?: readonly SearchMode[]
  values: FilterValues
  onChange: (patch: FilterPatch) => void
  onReset: () => void
  /** 常驻区最左侧的额外控件（例如页面自己的日期组件）。 */
  leading?: ReactNode
}

const BATCH_TITLE = '批量搜索'

function SearchBox({ modes, values, onChange }: { modes: readonly SearchMode[]; values: FilterValues; onChange: (patch: FilterPatch) => void }) {
  const [picked, setPicked] = useState(modes[0]?.id)
  const active = activeMode(modes, values)
  const mode = active ?? modes.find(item => item.id === picked) ?? modes[0]!
  const applied = active ? (values[active.key] ?? '') : ''
  const [draft, setDraft] = useState(applied)
  const [seen, setSeen] = useState(applied)
  if (seen !== applied) {
    setSeen(applied)
    setDraft(applied)
  }
  const [batch, setBatch] = useState<{ open: boolean; initial: string; nonce: number }>({ open: false, initial: '', nonce: 0 })
  const openBatch = (initial: string) => setBatch(current => ({ open: true, initial, nonce: current.nonce + 1 }))
  const batchApplied = mode.batchKey ? (values[mode.batchKey] ?? '') : ''
  const submit = (text: string) => {
    if (text.trim() !== applied) onChange(searchPatch(modes, mode, text))
  }

  return (
    <>
      <Space.Compact className="erp-filter-search">
        {modes.length > 1 ? (
          <Select
            aria-label="搜索方式"
            style={{ width: 128 }}
            value={mode.id}
            options={modes.map(item => ({ value: item.id, label: item.label }))}
            onChange={id => {
              const next = modes.find(item => item.id === id)!
              if (applied !== '') onChange(searchPatch(modes, next, applied))
              else setPicked(id)
            }}
          />
        ) : null}
        <Input.Search
          allowClear
          style={{ width: modes.length > 1 ? 220 : 280 }}
          placeholder={mode.placeholder ?? (modes.length > 1 ? '输入后回车搜索' : `搜索${mode.label}`)}
          aria-label={`搜索${mode.label}`}
          value={draft}
          onChange={event => {
            setDraft(event.target.value)
            if (event.target.value === '' && applied !== '') submit('')
          }}
          onSearch={submit}
          onPaste={event => {
            const pasted = event.clipboardData.getData('text')
            // 一次粘贴了多行：转成批量搜索，不把换行塞进单行输入框
            if (mode.batchKey && /[\r\n]/.test(pasted.trim())) {
              event.preventDefault()
              openBatch(pasted)
            }
          }}
        />
        {mode.batchKey ? <Button onClick={() => openBatch(batchApplied.split(',').join('\n'))}>批量</Button> : null}
      </Space.Compact>
      {mode.batchKey ? (
        <BatchSearchModal
          key={batch.nonce}
          open={batch.open}
          title={`${BATCH_TITLE}：${mode.label}`}
          initial={batch.initial}
          onCancel={() => setBatch(current => ({ ...current, open: false }))}
          onOk={joined => {
            setBatch(current => ({ ...current, open: false }))
            onChange({ [mode.batchKey!]: joined })
          }}
        />
      ) : null}
    </>
  )
}

export function FilterBar({ fields, modes = [], values, onChange, onReset, leading }: FilterBarProps) {
  const tags = appliedTags(fields, modes, values)
  const count = appliedCount(fields, modes, values)
  const main = fields.filter(field => !field.hidden && field.placement !== 'more')
  const more = fields.filter(field => !field.hidden && field.placement === 'more')

  return (
    <div className="erp-filter-bar" role="search" aria-label="筛选栏">
      <div className="erp-filter-row">
        <Space size={8} className="erp-filter-main">
          {leading}
          {main.map(field => (
            <FieldControl key={field.key} field={field} values={values} onChange={onChange} />
          ))}
          {modes.length > 0 ? <SearchBox modes={modes} values={values} onChange={onChange} /> : null}
        </Space>
        <Space size={8} className="erp-filter-actions">
          {more.length > 0 ? (
            <Popover
              trigger="click"
              placement="bottomRight"
              title="更多筛选"
              content={
                <div className="erp-filter-more">
                  {more.map(field => (
                    <label key={field.key} className="erp-filter-more-item">
                      <span>{field.label}</span>
                      <FieldControl field={field} values={values} onChange={onChange} width={180} />
                    </label>
                  ))}
                </div>
              }
            >
              <Button icon={<FilterOutlined />}>
                更多筛选
                {count > 0 ? <Badge count={count} size="small" overflowCount={99} color="var(--ant-color-primary)" className="erp-filter-badge" /> : null}
              </Button>
            </Popover>
          ) : count > 0 ? (
            <span className="erp-filter-count">已生效 {count} 个条件</span>
          ) : null}
          <Button disabled={count === 0} onClick={onReset}>
            重置
          </Button>
        </Space>
      </div>
      {tags.length > 0 ? (
        <div className="erp-filter-tags" role="list" aria-label="已生效的条件">
          {tags.map(tag => (
            <Tag
              key={tag.id}
              role="listitem"
              bordered={false}
              closable
              closeIcon={<CloseOutlined aria-label={`移除条件：${tag.label}`} role="button" />}
              onClose={event => {
                event.preventDefault()
                onChange(Object.fromEntries(tag.keys.map(key => [key, undefined])))
              }}
            >
              {tag.label}：{tag.text}
            </Tag>
          ))}
        </div>
      ) : null}
    </div>
  )
}
