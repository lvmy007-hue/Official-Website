import { Suspense, lazy, useState } from 'react'
import { Badge, Button, Popover } from 'antd'
import { BellOutlined } from '@ant-design/icons'
import type { UnreadCountResponse } from '@nova/api-contracts'
import { useApiQuery } from '../query/api-query'
import { useLivePages } from '../routes/live-context'
import { specByComponent } from '../routes/manifest'
import { useSession } from '../session/session'

// 顶栏消息与预警入口（P6-01）：铃铛带未读数，点开是“消息 / 预警”两个页签的浮层。
// 未读数每 60 秒轮询一次，页面不在前台时暂停（请求层的轮询默认只在前台进行）；读不到时不显示数字，不假装是 0。
// 浮层内容第一次点开才加载（首屏脚本预算）。入口只在对应页面已上线且有权限时出现，不放打不开的入口。

const NoticePanel = lazy(() => import('./NoticePanel').then(module => ({ default: module.NoticePanel })))

export const UNREAD_POLL_MS = 60_000

/** 未读数：messages 是站内消息，alerts 是预警（按人已读尚未接入时为 null）。旧响应只有 unreadCount 时当作 messages。 */
export function useUnreadCounts(enabled: boolean) {
  const query = useApiQuery<UnreadCountResponse>({ domain: 'realtime', path: '/notifications/unread-count', scoped: false, enabled, refetchIntervalMs: UNREAD_POLL_MS })
  const data = query.data
  return { messages: data ? (data.messages ?? data.unreadCount) : undefined, alerts: data ? (data.alerts ?? null) : null, failed: query.isError }
}

export function NoticeEntry() {
  const pages = useLivePages()
  const { can } = useSession()
  const [open, setOpen] = useState(false)
  const messageSpec = specByComponent.get('NotificationCenterPage')
  const alertSpec = specByComponent.get('AlertsPage')
  const showMessages = Boolean(messageSpec && messageSpec.component in pages && can(messageSpec.access))
  const showAlerts = Boolean(alertSpec && alertSpec.component in pages && can(alertSpec.access))
  const visible = showMessages || showAlerts
  const { messages, alerts } = useUnreadCounts(visible)
  if (!visible) return null
  const total = (showMessages ? (messages ?? 0) : 0) + (showAlerts ? (alerts ?? 0) : 0)
  return (
    <Badge count={total} size="small" overflowCount={99} offset={[-4, 4]}>
      <Popover
        trigger="click"
        placement="bottomRight"
        arrow={false}
        open={open}
        onOpenChange={setOpen}
        content={
          // 内容不能为空，否则 Popover 不会打开；浮层第一次打开才会渲染，所以懒加载的面板这时才开始下载
          <Suspense fallback={<div className="erp-notice-panel">加载中…</div>}>
            <NoticePanel showMessages={showMessages} showAlerts={showAlerts} messageUnread={messages} alertUnread={alerts} onClose={() => setOpen(false)} />
          </Suspense>
        }
      >
        <Button type="text" icon={<BellOutlined />} aria-label={total > 0 ? `消息与预警（${total} 条未读）` : '消息与预警'} aria-haspopup="dialog" aria-expanded={open} />
      </Popover>
    </Badge>
  )
}
