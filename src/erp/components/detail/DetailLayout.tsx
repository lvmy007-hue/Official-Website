import { useMemo, useState, type ReactNode } from 'react'
import { Button, Card, Empty, Space, Tabs, Typography } from 'antd'
import type { FreshnessInfo } from '../page/FreshnessBar'
import { CompactBar, IdentityCard, useIdentityCollapsed } from './detail-identity'
import { DetailFilterProvider, useDetailFilterState, type DetailFilterInit } from './detail-filter'
import { SectionList, useSectionSpy, type DetailSection } from './detail-sections'
import './detail.css'

// 详情页布局（03 章 3.2“详情页”；P6-05 起按 15 章 5.3 改造为整页详情）：
// 头部信息卡（对象标识、图片、状态标签、编码字段组、关键指标、数据新鲜度、主动作、关注按钮；滚动时收缩成一行吸顶）
// → 建议动作区（规则建议：依据、预估影响、风险、执行入口）
// → 吸顶导航（页签模式或锚点模式，下划线样式；共享筛选放在同一行右侧）
// → 页签内容 / 锚点板块 → 右侧关联栏（可折叠：关联对象、评论与协作、最近变更）。
// 两种模式二选一：传 tabs 是页签模式（只有打开的页签才取数）；传 sections 是锚点长页（板块进入视口前 200px 才取数）。
// 禁止展示原始数据结构或“字段名加字段值”的网格（编码字段组是一行标识，不是数据网格）。

export const IDENTITY_METRICS_MIN = 4
export const IDENTITY_METRICS_MAX = 6

export type IdentityMetric = { label: string; value: ReactNode; delta?: { label: string; ratio: number | null; goodWhen?: 'up' | 'down' } }
export type StatusTag = { text: string; color?: 'success' | 'warning' | 'error' | 'processing' | 'default' }
export type IdentityCode = { label: string; value: ReactNode }

export type Suggestion = {
  id: string
  /** 触发这条建议的规则。 */
  rule: string
  /** 依据：具体数字与来源。 */
  evidence: string
  /** 预估影响（区间，不给单点）。 */
  impact: string
  risk: string
  /** 执行入口：由页面用 ActionGuard 生成。 */
  action?: ReactNode
}

export type DetailLayoutProps = {
  title: string
  subtitle?: string
  imageUrl?: string | null
  statuses?: StatusTag[]
  /** 编码字段组（“字段名 值”排成一行，可换行），例如 SKU、ASIN、FNSKU、订单号。 */
  codes?: IdentityCode[]
  metrics: IdentityMetric[]
  freshness?: FreshnessInfo | null
  primaryActions?: ReactNode
  watch?: ReactNode
  /** 身份区补充信息（品牌、类目、排名等），显示在关键指标下方。 */
  identityExtra?: ReactNode
  suggestions?: Suggestion[]
  /** 页签模式。 */
  tabs?: Array<{ key: string; label: string; children: ReactNode }>
  activeTab?: string
  onTabChange?: (key: string) => void
  /** 锚点模式：板块按需加载，导航随滚动高亮。 */
  sections?: DetailSection[]
  /** 共享筛选（日期范围与对比方式）：true 用默认（近 30 天、不对比），也可给初始值；板块用 useDetailFilter() 取值。 */
  sharedFilter?: boolean | DetailFilterInit
  /** 右侧关联栏分区；不传则不显示该栏。 */
  rail?: Array<{ key: string; title: string; children: ReactNode }>
}

export function SuggestionList({ items }: { items: Suggestion[] }) {
  return (
    <Card size="small" title={`建议动作（${items.length}）`} data-testid="suggestions" styles={{ body: { padding: 0 } }}>
      {items.map((item, index) => (
        <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '10px 12px', borderTop: index ? '1px solid var(--ant-color-border-secondary)' : undefined }}>
          <div style={{ minWidth: 0 }}>
            <Typography.Text strong>{item.rule}</Typography.Text>
            <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>依据：{item.evidence}</div>
            <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>预估影响：{item.impact}</div>
            <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>风险：{item.risk}</div>
          </div>
          {item.action ? <div style={{ flex: 'none', alignSelf: 'center' }}>{item.action}</div> : null}
        </div>
      ))}
    </Card>
  )
}

function RelatedRail({ rail }: { rail: NonNullable<DetailLayoutProps['rail']> }) {
  const [open, setOpen] = useState(true)
  return (
    <aside aria-label="关联信息" style={{ flex: 'none', width: open ? 300 : 32 }}>
      <Button size="small" type="text" onClick={() => setOpen(value => !value)} aria-expanded={open} style={{ marginBottom: 4 }}>
        {open ? '收起关联栏 ›' : '‹'}
      </Button>
      {open ? (
        rail.length === 0 ? (
          <Empty description="暂无关联信息" />
        ) : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {rail.map(section => (
              <Card key={section.key} size="small" title={section.title}>
                {section.children}
              </Card>
            ))}
          </Space>
        )
      ) : null}
    </aside>
  )
}

export function DetailLayout(props: DetailLayoutProps) {
  const [innerTab, setInnerTab] = useState(props.tabs?.[0]?.key)
  const filter = useDetailFilterState(Boolean(props.sharedFilter), typeof props.sharedFilter === 'object' ? props.sharedFilter : undefined)
  const { sentinel, collapsed } = useIdentityCollapsed()
  const sectionKeys = useMemo(() => (props.sections ?? []).map(section => section.key), [props.sections])
  const spy = useSectionSpy(sectionKeys)
  const activeTab = props.activeTab ?? innerTab
  const metrics = props.metrics.slice(0, IDENTITY_METRICS_MAX)
  const identity = { ...props, metrics }
  const anchored = props.sections !== undefined

  return (
    <DetailFilterProvider value={filter.value}>
      <div data-testid="detail-layout" className="erp-detail-layout" data-collapsed={collapsed ? 'true' : 'false'}>
        <div className="erp-detail-compact-slot">{collapsed ? <CompactBar {...identity} /> : null}</div>
        <IdentityCard {...identity} />
        <div ref={sentinel} data-testid="identity-sentinel" aria-hidden="true" style={{ height: 1, marginTop: -1 }} />

        {props.suggestions && props.suggestions.length > 0 ? <SuggestionList items={props.suggestions} /> : null}

        {anchored ? (
          <div className="erp-detail-sticky">
            <Tabs
              className="erp-detail-nav"
              activeKey={spy.active ?? undefined}
              onChange={spy.jump}
              items={(props.sections ?? []).map(({ key, label }) => ({ key, label }))}
              tabBarExtraContent={filter.control}
            />
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {anchored ? (
              <SectionList sections={props.sections ?? []} />
            ) : (
              <Tabs
                className="erp-detail-nav"
                activeKey={activeTab}
                onChange={props.onTabChange ?? setInnerTab}
                items={props.tabs ?? []}
                tabBarExtraContent={filter.control}
                renderTabBar={(barProps, DefaultTabBar) => (
                  <div className="erp-detail-sticky">
                    <DefaultTabBar {...barProps} />
                  </div>
                )}
              />
            )}
          </div>
          {props.rail ? <RelatedRail rail={props.rail} /> : null}
        </div>
      </div>
    </DetailFilterProvider>
  )
}
