import { useState } from 'react'
import { Input, Select } from 'antd'
import type { FilterField, FilterPatch, FilterValues } from './filter-model'

// 筛选栏里的单个控件（P6-04）：下拉与文本框。取值变化立即写进地址栏（由上层 onChange 完成），没有“应用”按钮。

export function SelectFilter({ field, values, onChange, width }: { field: FilterField; values: FilterValues; onChange: (patch: FilterPatch) => void; width?: number }) {
  return (
    <Select
      allowClear
      showSearch
      optionFilterProp="label"
      style={{ width: width ?? field.width ?? 132 }}
      placeholder={field.label}
      aria-label={field.label}
      value={values[field.key]}
      options={field.options ? [...field.options] : []}
      onChange={next => onChange({ [field.key]: next ?? undefined })}
    />
  )
}

/** 文本筛选：回车或离开输入框时生效，清空立即生效。 */
export function TextFilter({ field, values, onChange, width }: { field: FilterField; values: FilterValues; onChange: (patch: FilterPatch) => void; width?: number }) {
  const applied = values[field.key] ?? ''
  const [draft, setDraft] = useState(applied)
  const [seen, setSeen] = useState(applied)
  // 地址栏里的值被外部改掉（重置、套用方案）时，输入框跟着变
  if (seen !== applied) {
    setSeen(applied)
    setDraft(applied)
  }
  const commit = (text: string) => {
    const next = text.trim()
    if (next !== applied) onChange({ [field.key]: next === '' ? undefined : next })
  }
  return (
    <Input
      allowClear
      style={{ width: width ?? field.width ?? 150 }}
      placeholder={field.label}
      aria-label={field.label}
      value={draft}
      onChange={event => {
        setDraft(event.target.value)
        if (event.target.value === '') commit('')
      }}
      onPressEnter={() => commit(draft)}
      onBlur={() => commit(draft)}
    />
  )
}

export function FieldControl(props: { field: FilterField; values: FilterValues; onChange: (patch: FilterPatch) => void; width?: number }) {
  return props.field.kind === 'select' ? <SelectFilter {...props} /> : <TextFilter {...props} />
}
