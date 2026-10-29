import { Button, Layout, Menu, Space, Tag, Typography } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Outlet, useRouter, useRouterState } from '@tanstack/react-router'
import { PLATFORM_ROLE_LABELS } from '@nova/authz'
import { DataState } from '../components/data-state/DataState'
import { platformFetch, setPlatformToken } from './platform-api'
import { hasPlatformPermission, platformMeQuery } from './platform-queries'

// 平台运营后台外壳（P1-19）：顶部导航（按平台权限显示）+ 内容区。与企业工作区外壳分开，不显示任何企业导航与全局范围。

const { Header, Content } = Layout

const NAV = [
  { key: '/platform/tenants', label: '租户', permission: 'platform.tenant.read' },
  { key: '/platform/support-access', label: '支持访问', permission: 'platform.support.access' },
] as const

export function PlatformLayout() {
  const router = useRouter()
  const client = useQueryClient()
  const pathname = useRouterState({ select: state => state.location.pathname })
  const me = useQuery(platformMeQuery)
  if (!me.data) return <DataState kind="skeleton" />
  const admin = me.data
  const items = NAV.filter(item => hasPlatformPermission(admin, item.permission))
  const active = items.find(item => pathname.startsWith(item.key))?.key

  const signOut = async () => {
    try {
      await platformFetch('/platform/auth/logout', { method: 'POST' })
    } catch {
      /* 令牌可能已失效，仍然退出本地登录态 */
    }
    setPlatformToken(null)
    client.removeQueries({ queryKey: ['platform'] })
    void router.navigate({ to: '/platform/login' })
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 24,
          background: 'var(--ant-color-bg-container)',
          borderBottom: '1px solid var(--ant-color-border-secondary)',
          paddingInline: 16,
          height: 48,
          lineHeight: '48px',
        }}
      >
        <Typography.Text strong style={{ whiteSpace: 'nowrap' }}>
          NOVA 平台运营后台
        </Typography.Text>
        <Menu
          mode="horizontal"
          selectedKeys={active ? [active] : []}
          items={items.map(item => ({ key: item.key, label: item.label }))}
          onClick={({ key }) => void router.navigate({ to: key })}
          style={{ flex: 1, minWidth: 0, borderBottom: 'none', lineHeight: '46px' }}
        />
        <Space size={8}>
          <Typography.Text type="secondary">{admin.name}</Typography.Text>
          <Tag bordered={false}>{PLATFORM_ROLE_LABELS[admin.role as keyof typeof PLATFORM_ROLE_LABELS] ?? admin.role}</Tag>
          <Button size="small" onClick={() => void signOut()}>
            退出登录
          </Button>
        </Space>
      </Header>
      <Content style={{ padding: 16 }}>
        <Outlet />
      </Content>
    </Layout>
  )
}
