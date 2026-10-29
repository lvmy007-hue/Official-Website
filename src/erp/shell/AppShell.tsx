import { Suspense, lazy, useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, Layout, Space, Tooltip } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { Breadcrumbs } from './Breadcrumbs'
import { useCommandPaletteHotkey } from './command-hotkey'
import { FavoriteStar } from './favorites'
import { NoticeEntry } from './NoticeEntry'
import { ScopeBar } from './ScopeBar'
import { SideNav } from './SideNav'
import { TabBar } from './TabBar'
import { markShellInteractive } from '../telemetry/web-vitals'
import { AccessModeBanner, LifecycleBanner, UserMenu, WriteStatusBadge } from './header-parts'
import './shell.css'

// 外壳（P1-04，P6-01 起加多页签条、收藏与消息预警浮层）：
// 侧边导航 + 顶栏（面包屑与收藏星标、命令面板、写入状态、消息与预警、个人菜单）+ 页签条 + 全局范围栏 + 内容区。

const { Sider, Header, Content } = Layout

// 命令面板第一次打开时才加载（首屏脚本预算，P1-09）
const CommandPalette = lazy(() => import('./CommandPalette').then(module => ({ default: module.CommandPalette })))

export function AppShell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteUsed, setPaletteUsed] = useState(false)
  const openPalette = useCallback(() => {
    setPaletteUsed(true)
    setPaletteOpen(true)
  }, [])
  useCommandPaletteHotkey(openPalette)
  // 外壳第一次渲染完成：记为首次可交互（性能埋点，P1-09）
  useEffect(() => markShellInteractive(window.location.pathname), [])
  return (
    <Layout className="erp-shell" style={{ minHeight: '100vh' }}>
      <Sider width={216} theme="light" className="erp-shell-sider" breakpoint="lg" collapsedWidth={0}>
        <div className="erp-shell-brand">NOVA ERP</div>
        <SideNav />
      </Sider>
      <Layout>
        <AccessModeBanner />
        <LifecycleBanner />
        <Header className="erp-shell-header">
          <div className="erp-shell-header-left">
            <Breadcrumbs />
            <FavoriteStar />
          </div>
          <Space size={8}>
            <Tooltip title="搜索页面或对象（Ctrl + K）">
              <Button icon={<SearchOutlined />} onClick={openPalette} aria-label="打开命令面板">
                搜索<kbd className="erp-kbd">Ctrl K</kbd>
              </Button>
            </Tooltip>
            <WriteStatusBadge />
            <NoticeEntry />
            <UserMenu />
          </Space>
        </Header>
        <TabBar />
        <ScopeBar />
        <Content className="erp-shell-content">{children}</Content>
      </Layout>
      {paletteUsed ? (
        <Suspense fallback={null}>
          <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        </Suspense>
      ) : null}
    </Layout>
  )
}
