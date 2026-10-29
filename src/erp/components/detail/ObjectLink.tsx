import { useState, type ReactNode } from 'react'
import { Popover, Skeleton, Typography } from 'antd'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'

// 对象链接 + 悬停卡片（3.3“一致性”：同一对象在所有页面同一种链接与悬停卡片）。
// 悬停时才请求摘要（不预取整页数据）；加载失败显示原因，点击进入完整详情页。

export type ObjectLinkProps<T> = {
  label: ReactNode
  /** 详情页地址（带不带范围参数由 AppLink 处理）。 */
  to: string
  /** 悬停卡片的数据来源：接口路径（不含 /api/v1）。不传则只是普通链接。 */
  summaryPath?: string
  /** 把摘要数据渲染成卡片内容：面向业务用户，不展示字段名值表。 */
  renderSummary?: (data: T) => ReactNode
}

function HoverBody<T>({ path, render }: { path: string; render: (data: T) => ReactNode }) {
  const query = useApiQuery<T>({ domain: 'reference', path, scoped: false })
  if (query.isPending) return <Skeleton active paragraph={{ rows: 2 }} title={false} style={{ width: 220 }} />
  if (query.isError) return <Typography.Text type="danger">摘要加载失败：{describeError(query.error).message}</Typography.Text>
  return <div style={{ maxWidth: 280 }}>{render(query.data as T)}</div>
}

export function ObjectLink<T = unknown>({ label, to, summaryPath, renderSummary }: ObjectLinkProps<T>) {
  const [open, setOpen] = useState(false)
  const link = <AppLink to={to}>{label}</AppLink>
  if (!summaryPath || !renderSummary) return link
  return (
    <Popover open={open} onOpenChange={setOpen} mouseEnterDelay={0.3} content={<HoverBody<T> path={summaryPath} render={renderSummary} />}>
      <span>{link}</span>
    </Popover>
  )
}
