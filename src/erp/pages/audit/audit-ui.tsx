import type { ReactNode } from 'react'
import { Input, Select, Tag } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import type { AuditActorView } from '@nova/api-contracts'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'

// 审计中心共用的小件：操作人、结果、来源的显示，带搜索的下拉，时间范围转成服务端要的起止时刻。
// 审计日志不分店铺，站内跳转都不带全局范围参数。

export const NONE = '尚无记录'

/** 操作人：企业成员显示姓名；系统任务显示“系统”；平台人员显示“平台人员”（带标签，一眼能区分）。 */
export function ActorText({ actor }: { actor: AuditActorView }): ReactNode {
  if (actor.kind === 'SYSTEM') return <Tag bordered={false}>{actor.name}</Tag>
  if (actor.kind === 'SUPPORT') return <Tag color="purple">{actor.name}</Tag>
  return <span>{actor.name}</span>
}

const RESULT_COLOR: Record<string, string> = { SUCCEEDED: 'success', FAILED: 'error', DENIED: 'warning' }
export const ResultTag = ({ result, label }: { result: string; label: string }) => (
  <Tag color={RESULT_COLOR[result] ?? 'default'} bordered={false}>
    {label}
  </Tag>
)

/** 所属页面：没有记录时写“无”（接口调用、系统任务本来就没有页面），不写成缺数据。 */
export const PageText = ({ page }: { page: string | null }) => (page ? <span className="erp-num">{page}</span> : <Muted>无所属页面</Muted>)

/** 资源：类型中文名 + 编号；有详情页的编号可点击。 */
export function ResourceCell({ label, id, path }: { label: string; id: string | null; path: string | null }) {
  return (
    <div>
      <div>{label}</div>
      <div style={{ fontSize: 12 }}>
        {id ? (
          path ? (
            <AppLink to={path} keepScope={false}>
              {id}
            </AppLink>
          ) : (
            <span className="erp-num">{id}</span>
          )
        ) : (
          <Muted>{NONE}</Muted>
        )}
      </div>
    </div>
  )
}

export function Pick({
  label,
  value,
  options,
  onChange,
  width = 150,
}: {
  label: string
  value?: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string | undefined) => void
  width?: number
}) {
  return <Select allowClear showSearch optionFilterProp="label" style={{ width }} placeholder={label} aria-label={label} value={value} options={options} onChange={next => onChange(next)} />
}

/** 搜索框：回车或点搜索才生效；用叉号或删空文字时立即取消这个条件。父组件换 key 可清空输入。 */
export function SearchBox({ label, placeholder, width = 240, onSearch }: { label: string; placeholder: string; width?: number; onSearch: (value: string | undefined) => void }) {
  return (
    <Input.Search
      allowClear
      style={{ width }}
      placeholder={placeholder}
      aria-label={label}
      onChange={event => {
        if (event.target.value === '') onSearch(undefined)
      }}
      onSearch={value => onSearch(value.trim() || undefined)}
    />
  )
}

export type TimeRange = [Dayjs | null, Dayjs | null] | null

/** 时间范围转成服务端的起止时刻（ISO）；没选就都不传。 */
export function rangeParams(range: TimeRange): { fromAt?: string; toAt?: string } {
  const [from, to] = range ?? [null, null]
  return { fromAt: from ? from.toDate().toISOString() : undefined, toAt: to ? to.toDate().toISOString() : undefined }
}

export const dayRange = (days: number): [Dayjs, Dayjs] => [dayjs().subtract(days, 'day').startOf('day'), dayjs().endOf('day')]
