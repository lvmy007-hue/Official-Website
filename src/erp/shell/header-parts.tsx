import { Suspense, lazy, useState } from 'react'
import { Alert, Avatar, Button, Dropdown, Tag, Tooltip } from 'antd'
import { LogoutOutlined, SafetyOutlined, UserOutlined } from '@ant-design/icons'
import { logout } from '../../api'
import { useAppNavigate } from '../nav/AppLink'
import { useApiQuery } from '../query/api-query'
import { useLivePages } from '../routes/live-context'
import { specByComponent } from '../routes/manifest'
import { useSession } from '../session/session'

// 顶栏的几个小部件（P1-04）：写入状态标识、内部访问横幅、个人菜单（消息与预警入口在 NoticeEntry.tsx，P6-01）。

// 授权抽屉第一次打开时才加载（首屏脚本预算，P1-09）
const SupportAccessDrawer = lazy(() => import('./SupportAccessDrawer').then(module => ({ default: module.SupportAccessDrawer })))

export type WriteState = 'read-only' | 'partial' | 'enabled' | 'loading' | 'unknown'

type WriteSummary = { mode: 'READ_ONLY' | 'PARTIAL' | 'ALL'; enabledCount: number; total: number; emergencyForced: boolean }
const STATE_OF_MODE = { READ_ONLY: 'read-only', PARTIAL: 'partial', ALL: 'enabled' } as const

/**
 * 写入状态：企业当前是否允许向亚马逊写入，来自写入开关汇总接口（登录成员都能读取，不含敏感信息）。
 * 读取失败时显示“状态未知”，不假定为只读——用户据此知道需要刷新或联系管理员。
 */
export function useWriteStatus(): { state: WriteState; summary?: WriteSummary } {
  const query = useApiQuery<WriteSummary>({ domain: 'config', path: '/settings/integrations/summary', scoped: false })
  if (query.data) return { state: STATE_OF_MODE[query.data.mode] ?? 'unknown', summary: query.data }
  return { state: query.isError ? 'unknown' : 'loading' }
}

const WRITE_LABEL: Record<WriteState, { text: string; color: string; hint: string }> = {
  'read-only': { text: '只读模式', color: 'default', hint: '亚马逊写入开关全部关闭：所有改动只做预览与记录，不会改动亚马逊。' },
  partial: { text: '部分可写', color: 'warning', hint: '部分数据域已开启亚马逊写入，其余仍为只读。' },
  enabled: { text: '可写入', color: 'success', hint: '亚马逊写入开关已开启，操作经预览确认后会真实写入并记录审计。' },
  loading: { text: '写入状态读取中', color: 'default', hint: '正在读取亚马逊写入开关的当前状态。' },
  unknown: { text: '写入状态未知', color: 'error', hint: '暂时读不到写入开关状态，请刷新页面；在确认之前，请不要假定可以写入亚马逊。' },
}

export function WriteStatusBadge() {
  const { state, summary } = useWriteStatus()
  const label = WRITE_LABEL[state]
  const hint = summary ? `${label.hint}（已开启 ${summary.enabledCount} / ${summary.total} 项${summary.emergencyForced ? '；平台已紧急强制关闭写入' : ''}）` : label.hint
  return (
    <Tooltip title={hint}>
      <Tag color={label.color} bordered={false} data-testid="write-status" data-state={state} style={{ marginInlineEnd: 0 }}>
        {label.text}
      </Tag>
    </Tooltip>
  )
}

/** 内部访问与限时支持访问：来源不是个人账号登录，必须明确提示。 */
export function AccessModeBanner() {
  const { me } = useSession()
  if (me.accessMode === 'NORMAL') return null
  const internal = me.accessMode === 'INTERNAL_DIRECT'
  return (
    <Alert
      banner
      type="warning"
      showIcon
      role="status"
      data-testid="access-mode-banner"
      message={
        internal
          ? '内部访问模式：当前通过内网直连访问，未使用个人账号登录；所有操作会记录来源地址并标注为内部访问。'
          : '限时支持访问：当前由平台支持人员在授权时限内访问本企业；所有操作都会记录并标注。'
      }
    />
  )
}

/**
 * 企业状态提示（P1-19）：暂停时只读且同步停止；初始化向导未完成时提示去完成（仅所有者与管理员有入口）。
 * 限时支持访问的会话不显示向导提示——支持人员不能代企业完成初始化。
 */
export function LifecycleBanner() {
  const { me, can } = useSession()
  const navigate = useAppNavigate()
  if (me.tenant.lifecycleStatus === 'SUSPENDED') {
    return <Alert banner type="error" showIcon role="status" data-testid="suspended-banner" message="企业已被平台暂停：当前只能查看，不能修改数据，后台同步已停止。如有疑问请联系平台运营。" />
  }
  if (me.tenant.onboardingCompleted === false && me.accessMode !== 'SUPPORT') {
    const canSetup = can({ kind: 'owner-admin' })
    return (
      <Alert
        banner
        type="info"
        showIcon
        role="status"
        data-testid="onboarding-banner"
        message={canSetup ? '企业初始化尚未完成：完成后系统才会开始首次同步，数据页面在此之前会显示“暂无数据”。' : '企业初始化尚未完成，请联系企业管理员完成初始化。'}
        action={
          canSetup ? (
            <Button size="small" type="primary" onClick={() => navigate('/app/onboarding', undefined, false)}>
              去完成
            </Button>
          ) : undefined
        }
      />
    )
  }
  return null
}

export function UserMenu() {
  const { me, can } = useSession()
  const pages = useLivePages()
  const navigate = useAppNavigate()
  const profile = specByComponent.get('ProfilePage')
  const [supportOpen, setSupportOpen] = useState(false)
  // 支持访问授权入口放在个人菜单里（企业设置页的“内部访问模式”页签只读显示授权数量并指向这里）
  const canGrant = me.accessMode === 'NORMAL' && can({ kind: 'permission', permission: 'settings.read' })
  const items = [
    { key: 'tenant', label: <span style={{ color: 'var(--ant-color-text-tertiary)' }}>{me.tenant.name}</span>, disabled: true },
    ...(profile && profile.component in pages && can(profile.access) ? [{ key: 'profile', icon: <UserOutlined />, label: '个人账号' }] : []),
    ...(canGrant ? [{ key: 'support', icon: <SafetyOutlined />, label: '平台支持访问授权' }] : []),
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录' },
  ]
  return (
    <>
      {supportOpen ? (
        <Suspense fallback={null}>
          <SupportAccessDrawer open={supportOpen} onClose={() => setSupportOpen(false)} />
        </Suspense>
      ) : null}
      <Dropdown
        menu={{
          items,
          onClick: ({ key }) => {
            if (key === 'logout') void logout()
            if (key === 'profile' && profile) navigate(profile.path, undefined, false)
            if (key === 'support') setSupportOpen(true)
          },
        }}
        trigger={['click']}
      >
        <Button type="text" aria-label="个人菜单" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Avatar size={22} style={{ background: 'var(--ant-color-primary)' }}>
            {me.user.displayName.slice(0, 1)}
          </Avatar>
          <span>{me.user.displayName}</span>
        </Button>
      </Dropdown>
    </>
  )
}
