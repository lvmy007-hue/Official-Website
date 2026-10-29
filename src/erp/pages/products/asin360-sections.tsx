import { Space } from 'antd'
import { visibleAsin360Tabs, type Asin360TabKey } from '@nova/api-contracts'
import type { DetailSection } from '../../components'
import { AdsTab } from './AdsTab'
import { ChangesTab } from './ChangesTab'
import { EconomicsTab } from './EconomicsTab'
import { InventoryTab } from './InventoryTab'
import { OverviewTab } from './OverviewTab'
import { ReturnsTab } from './ReturnsTab'
import { TrafficTab } from './TrafficTab'
import { AlertsSection } from './asin360-alerts'
import { CompareSection } from './asin360-compare'
import { CompetitorCompareBlock } from './asin360-competitor-compare'
import { CompetitorsTab, PricingTab } from './asin360-market'
import { ContentTab, ListingTab, ReviewsTab } from './asin360-panels'
import { ReturnsCycleBlock } from './asin360-returns-cycle'

// ASIN 360 锚点长页的板块（P6-21，16 章 3.1）：顺序即页面上的顺序，吸顶导航与板块一一对应。
// 板块内容复用原来各页签的组件（页签已不再单独存在）；进入视口前 200px 才挂载并取数，没有权限的板块不出现，不放占位。
// 新增的预警日志不属于 12 个旧页签，权限单独判断。

type Body = (props: { id: string }) => JSX.Element
type SectionKey = Asin360TabKey | 'alerts'

const Stack = ({ children }: { children: React.ReactNode }) => (
  <Space direction="vertical" size={12} style={{ width: '100%' }}>
    {children}
  </Space>
)

const OverviewSection: Body = ({ id }) => (
  <Stack>
    <OverviewTab id={id} />
    <CompareSection id={id} />
  </Stack>
)
const ReturnsSection: Body = ({ id }) => (
  <Stack>
    <ReturnsTab id={id} />
    <ReturnsCycleBlock id={id} />
  </Stack>
)
const CompetitorsSection: Body = ({ id }) => (
  <Stack>
    <CompetitorCompareBlock id={id} />
    <CompetitorsTab id={id} />
  </Stack>
)

/** 板块顺序、名称与内容（16 章 3.1 的 13 个锚点）。 */
export const SECTIONS: ReadonlyArray<{ key: SectionKey; label: string; body: Body }> = [
  { key: 'overview', label: '概览', body: OverviewSection },
  { key: 'traffic', label: '订单与流量', body: TrafficTab },
  { key: 'ads', label: '广告', body: AdsTab },
  { key: 'inventory', label: '库存与补货', body: InventoryTab },
  { key: 'economics', label: '利润与成本', body: EconomicsTab },
  { key: 'returns', label: '售后', body: ReturnsSection },
  { key: 'reviews', label: '评价', body: ReviewsTab },
  { key: 'competitors', label: '竞品对比', body: CompetitorsSection },
  { key: 'listing', label: '刊登与问题', body: ListingTab },
  { key: 'pricing', label: '定价与购物车', body: PricingTab },
  { key: 'content', label: '内容与 A+', body: ContentTab },
  { key: 'alerts', label: '预警日志', body: AlertsSection },
  { key: 'changes', label: '变更与审计', body: ChangesTab },
]

/** 当前成员能看到的板块（已上线且有进入权限），按页面顺序。 */
export function visibleSections(id: string, canPermission: (permission: string) => boolean): DetailSection[] {
  const tabs = new Set<string>(visibleAsin360Tabs(canPermission).map(tab => tab.key))
  const canAlerts = canPermission('products.read') && canPermission('alerts.read')
  return SECTIONS.filter(section => (section.key === 'alerts' ? canAlerts : tabs.has(section.key))).map(section => {
    const Content = section.body
    return { key: section.key, label: section.label, children: <Content id={id} /> }
  })
}
