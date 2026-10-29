import { useState } from 'react'
import { Space, Tabs, Typography } from 'antd'
import { PageHeader } from '../../components'
import { AppLink } from '../../nav/AppLink'
import BasicInfoTab from './BasicInfoTab'
import FinancePolicyTab from './FinancePolicyTab'
import RefreshTab from './RefreshTab'
import RetentionTab from './RetentionTab'
import { InternalTab, RiskTab } from './RiskInternalTabs'

// 企业设置（09 章 9.12）：8 个页签。基本信息、数据保留、刷新策略、风险规则版本、内部访问模式在 P5-10 交付（GET/PATCH /settings）；
// 财务口径在 P2b-15 交付；接口与写入开关、汇率是独立的子页面，这里给入口。每个配置项是一张卡片：配置名、当前值、影响范围、编辑入口。

type TabKey = 'basic' | 'finance' | 'retention' | 'refresh' | 'risk' | 'internal' | 'integrations' | 'fx'
const TAB_KEYS: readonly TabKey[] = ['basic', 'finance', 'retention', 'refresh', 'risk', 'internal', 'integrations', 'fx']

const LINKS = {
  integrations: { label: '接口与写入开关', to: '/app/settings/integrations', text: '管理对亚马逊的写入开关，查看前置条件与变更历史。' },
  fx: { label: '汇率', to: '/app/settings/fx', text: '管理汇率来源、手工覆盖与附加币种。' },
} as const

const initialTab = (): TabKey => {
  const wanted = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search).get('tab')
  return TAB_KEYS.find(key => key === wanted) ?? 'basic'
}

function LinkPanel({ item }: { item: (typeof LINKS)[keyof typeof LINKS] }) {
  return (
    <Space direction="vertical">
      <Typography.Text>{item.text}</Typography.Text>
      <AppLink to={item.to}>
        <Typography.Link>前往“{item.label}”</Typography.Link>
      </AppLink>
    </Space>
  )
}

export default function SettingsPage() {
  const [tab, setTab] = useState<TabKey>(initialTab)
  const items = [
    { key: 'basic', label: '基本信息', children: <BasicInfoTab /> },
    { key: 'finance', label: '财务口径', children: <FinancePolicyTab /> },
    { key: 'retention', label: '数据保留', children: <RetentionTab /> },
    { key: 'refresh', label: '刷新策略', children: <RefreshTab /> },
    { key: 'risk', label: '风险规则版本', children: <RiskTab /> },
    { key: 'internal', label: '内部访问模式', children: <InternalTab /> },
    { key: 'integrations', label: LINKS.integrations.label, children: <LinkPanel item={LINKS.integrations} /> },
    { key: 'fx', label: LINKS.fx.label, children: <LinkPanel item={LINKS.fx} /> },
  ]
  return (
    <div>
      <PageHeader title="企业设置" description="企业资料、财务口径与各项运行策略；每一项都写明当前值、影响范围和谁能改。" />
      <Tabs activeKey={tab} onChange={key => setTab(key as TabKey)} items={items} destroyInactiveTabPane />
    </div>
  )
}
