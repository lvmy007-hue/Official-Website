import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Badge, Button, Space, Tag, Tooltip, Typography } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import type { KpiKey, KpisResponse, OverviewSection } from '@nova/api-contracts'
import { PageHeader } from '../../components'
import { formatDateTime } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { useSession } from '../../session/session'
import { COMPARE_LABEL } from './dash-parts'
import { AsinRankSection, StoreCompareSection, VolatilitySection } from './CompareSections'
import { KpiSection } from './KpiSection'
import { LayoutControls } from './LayoutControls'
import { AdAnomaliesSection, CashSection, InventoryRiskSection, WaterfallSection } from './MoreSections'
import { QueueSection } from './QueueSection'
import { ReportDialog } from './ReportDialog'
import { healthLight, SourceHealthSection, type SourceHealth } from './SourceHealthSection'
import { TrendSection } from './TrendSection'
import { useOverviewLayout, visibleParts } from './use-layout'

// 经营控制台（P2a-02，04 章 4.1）：一屏看清经营现状。
// 所有数字来自店铺日汇总等真实数据；没有数据的区域如实写“尚无记录”“尚未接入”，不出现示例数字。
// 时间范围与对比期沿用顶部范围栏；没有选择时间范围时，默认近 30 天、对比上一期。
// 本页由路由懒加载，ECharts 在图表进入可视区后才加载，不占用首屏脚本。

export { lagText } from './SourceHealthSection'

const BIG_SCREEN_REFRESH_MS = 60_000
const LIVE_DOMAINS = new Set(['analytics', 'realtime'])

function TopBar(props: { kpis?: KpisResponse; health?: SourceHealth; bigScreen: boolean; onReport: () => void; onToggleScreen: () => void; layout: ReactNode }) {
  const queryClient = useQueryClient()
  const { canPermission } = useSession()
  const { kpis } = props
  const light = healthLight(props.health?.summary)
  const refresh = () => void queryClient.invalidateQueries({ predicate: query => LIVE_DOMAINS.has(String(query.queryKey[1])) })
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between', margin: '4px 0 12px' }} data-testid="overview-topbar">
      <Space size={12} wrap>
        <Tooltip title={light.label}>
          <span data-testid="health-light">
            <Badge status={light.color} text={props.health?.summary.completeness != null ? `数据完整度 ${Math.round(props.health.summary.completeness * 100)}%` : light.label} />
          </span>
        </Tooltip>
        {kpis ? (
          <Typography.Text type="secondary">
            {kpis.period.from} 至 {kpis.period.to}（{kpis.period.days} 天）
            {kpis.compare ? `，${COMPARE_LABEL[kpis.compare.mode]}对比 ${kpis.compare.from} 至 ${kpis.compare.to}` : '，未选择对比期'}
          </Typography.Text>
        ) : null}
        {kpis?.defaulted ? <Tag bordered={false}>默认近 30 天，对比上一期；可在范围栏调整</Tag> : null}
        {kpis ? <Typography.Text type="secondary">{kpis.refreshedAt ? `汇总刷新于 ${formatDateTime(kpis.refreshedAt)}` : '尚无汇总记录'}</Typography.Text> : null}
      </Space>
      <Space size={8} wrap>
        {props.layout}
        <Button size="small" onClick={refresh}>
          刷新
        </Button>
        <Tooltip title={canPermission('export.create') ? undefined : '没有“导出”权限'}>
          <span>
            <Button size="small" disabled={!canPermission('export.create')} onClick={props.onReport}>
              生成报表
            </Button>
          </span>
        </Tooltip>
        <Button size="small" type={props.bigScreen ? 'primary' : 'default'} onClick={props.onToggleScreen} aria-pressed={props.bigScreen}>
          {props.bigScreen ? '退出大屏' : '大屏模式'}
        </Button>
      </Space>
    </div>
  )
}

export default function OverviewPage() {
  const queryClient = useQueryClient()
  const layoutState = useOverviewLayout()
  const parts = visibleParts(layoutState.layout)
  const kpis = useApiQuery<KpisResponse>({ domain: 'analytics', path: '/overview/kpis' })
  const health = useApiQuery<SourceHealth>({ domain: 'realtime', path: '/overview/source-health' })
  const [reportOpen, setReportOpen] = useState(false)
  const [bigScreen, setBigScreen] = useState(false)
  const host = useRef<HTMLDivElement>(null)

  // 大屏模式：铺满窗口（浏览器支持时进入全屏），每分钟自动刷新；按 Esc 或点“退出大屏”恢复
  useEffect(() => {
    if (!bigScreen) return
    const timer = window.setInterval(() => void queryClient.invalidateQueries({ predicate: query => LIVE_DOMAINS.has(String(query.queryKey[1])) }), BIG_SCREEN_REFRESH_MS)
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setBigScreen(false)
    const onFullscreen = () => !document.fullscreenElement && setBigScreen(false)
    window.addEventListener('keydown', onKey)
    document.addEventListener('fullscreenchange', onFullscreen)
    void host.current?.requestFullscreen?.().catch(() => undefined)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('fullscreenchange', onFullscreen)
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined)
    }
  }, [bigScreen, queryClient])

  const render = (section: OverviewSection): ReactNode => {
    switch (section) {
      case 'kpis':
        return <KpiSection data={kpis.data} loading={kpis.isPending} error={kpis.error} onRetry={() => void kpis.refetch()} cardKeys={parts.cards as readonly KpiKey[]} />
      case 'trend':
        return <TrendSection />
      case 'queue':
        return <QueueSection />
      case 'storeCompare':
        return <StoreCompareSection />
      case 'asinRank':
        return <AsinRankSection />
      case 'volatility':
        return <VolatilitySection />
      case 'adAnomalies':
        return <AdAnomaliesSection />
      case 'inventoryRisk':
        return <InventoryRiskSection />
      case 'waterfall':
        return <WaterfallSection />
      case 'cash':
        return <CashSection />
      case 'sourceHealth':
        return <SourceHealthSection health={health} />
    }
  }

  return (
    <div ref={host} data-testid="overview-page" style={bigScreen ? { position: 'fixed', inset: 0, zIndex: 1000, overflow: 'auto', padding: 16, background: 'var(--ant-color-bg-layout)' } : undefined}>
      <PageHeader title="经营控制台" description="销售、利润、库存、待办与数据源健康一屏看清；每个数字都能追溯，没有数据的地方如实标注。" />
      <TopBar
        kpis={kpis.data}
        health={health.data}
        bigScreen={bigScreen}
        onReport={() => setReportOpen(true)}
        onToggleScreen={() => setBigScreen(value => !value)}
        layout={<LayoutControls state={layoutState} />}
      />
      {parts.sections.length === 0 ? <Typography.Text type="secondary">所有区域都已隐藏，请在“自定义”里勾选要显示的区域。</Typography.Text> : null}
      {parts.sections.map(section => (
        <div key={section}>{render(section)}</div>
      ))}
      <ReportDialog open={reportOpen} onClose={() => setReportOpen(false)} />
    </div>
  )
}
