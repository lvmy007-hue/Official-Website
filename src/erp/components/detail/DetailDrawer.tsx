import { useState, type ReactNode } from 'react'
import { Drawer, Space, Tabs, Tag, Typography } from 'antd'
import { AppLink } from '../../nav/AppLink'
import type { StatusTag } from './DetailLayout'
import './detail.css'

// 抽屉详情（P6-05，15 章第 8 节）：快速查看、轻量编辑、不离开列表。
// 宽度只有 720 与 960 两档，直角贴右边；顶部是对象标识（标题、副标题、状态标签）和主操作，下面用页签；
// 右上角固定有“在新页签打开完整详情”（普通点击在站内打开新页签，按住 Ctrl/Cmd 点击在浏览器新标签页打开）。
// 页签内容只在被打开过之后才挂载（取数也只在那时发生）；取数中或失败时由调用方给 status 顶替页签区。

export const DRAWER_WIDTHS = [720, 960] as const
export type DrawerWidth = (typeof DRAWER_WIDTHS)[number]

export type DetailDrawerProps = {
  open: boolean
  onClose: () => void
  width?: DrawerWidth
  /** 对象标识：主标题。 */
  title: ReactNode
  subtitle?: ReactNode
  statuses?: StatusTag[]
  /** 主操作（一到两个按钮）。 */
  actions?: ReactNode
  /** 完整详情的站内路径；不传则不显示“在新页签打开完整详情”。 */
  fullPath?: string
  /** 页签上方的摘要（关键指标一行，用 MetricsRow）。 */
  summary?: ReactNode
  tabs: Array<{ key: string; label: string; children: ReactNode }>
  activeTab?: string
  onTabChange?: (key: string) => void
  /** 取数中、失败、无权限等状态：给了就顶替页签区。 */
  status?: ReactNode
}

export function DetailDrawer(props: DetailDrawerProps) {
  const [innerTab, setInnerTab] = useState<string | undefined>(undefined)
  const activeKey = props.activeTab ?? innerTab ?? props.tabs[0]?.key
  const header = (
    <div className="erp-drawer-head">
      <div className="erp-drawer-identity">
        <Typography.Title level={5} style={{ margin: 0 }} ellipsis>
          {props.title}
        </Typography.Title>
        {props.subtitle ? (
          <Typography.Text type="secondary" ellipsis>
            {props.subtitle}
          </Typography.Text>
        ) : null}
        {props.statuses?.length ? (
          <Space size={4} wrap>
            {props.statuses.map(status => (
              <Tag key={status.text} color={status.color} bordered={false}>
                {status.text}
              </Tag>
            ))}
          </Space>
        ) : null}
      </div>
      <Space size={8} wrap className="erp-drawer-actions">
        {props.actions}
        {props.fullPath ? (
          <AppLink to={props.fullPath} onNavigate={props.onClose}>
            在新页签打开完整详情
          </AppLink>
        ) : null}
      </Space>
    </div>
  )
  return (
    <Drawer
      open={props.open}
      onClose={props.onClose}
      width={props.width ?? 720}
      title={header}
      destroyOnClose
      className="erp-detail-drawer"
      styles={{ header: { padding: '12px 16px' }, body: { padding: '0 16px 16px' } }}
    >
      {props.summary}
      {props.status ?? <Tabs activeKey={activeKey} onChange={props.onTabChange ?? setInnerTab} items={props.tabs} />}
    </Drawer>
  )
}
