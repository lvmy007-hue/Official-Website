import { Tabs } from 'antd'
import { useRouter, useSearch } from '@tanstack/react-router'
import { PageHeader } from '../../components'
import { MfaPanel } from './MfaPanel'
import NotifyPrefsTab from './NotifyPrefsTab'
import ProfileTab from './ProfileTab'
import { SessionsPanel } from './SessionsPanel'

// 个人账号（P5-11，09 章 9.15）：个人资料、登录安全（多因素认证）、会话管理、通知偏好四个页签。
// 只管登录者自己：所有接口按登录者本人读写，没有“看别人账号”的入口。页签放在地址栏（?tab=），管理员账号被要求先启用多因素认证时（?mfa=required）直接落在登录安全。

const TABS = ['profile', 'security', 'sessions', 'notify'] as const
type TabKey = (typeof TABS)[number]

const tabOf = (search: { tab?: string; mfa?: string }): TabKey => {
  if (search.mfa === 'required') return 'security'
  return TABS.find(key => key === search.tab) ?? 'profile'
}

export default function ProfilePage() {
  const router = useRouter()
  const search = useSearch({ strict: false }) as { tab?: string; mfa?: string }
  const items = [
    { key: 'profile', label: '个人资料', children: <ProfileTab /> },
    { key: 'security', label: '登录安全', children: <MfaPanel /> },
    { key: 'sessions', label: '会话管理', children: <SessionsPanel /> },
    { key: 'notify', label: '通知偏好', children: <NotifyPrefsTab /> },
  ]
  return (
    <div data-testid="profile-page">
      <PageHeader title="个人账号" description="你自己的资料、登录安全、登录设备与通知偏好。这里的设置只影响你本人。" />
      <Tabs activeKey={tabOf(search)} onChange={key => void router.navigate({ search: { tab: key } as never, replace: true })} items={items} destroyInactiveTabPane />
    </div>
  )
}
