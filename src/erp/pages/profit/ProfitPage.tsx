import { useState } from 'react'
import { Alert, Card, Select, Tabs } from 'antd'
import { PROFIT_BASES, PROFIT_BASIS_LABEL, type ProfitBasis } from '@nova/api-contracts'
import { PageHeader } from '../../components'
import { useSession } from '../../session/session'
import { LiveLink } from '../inventory/inventory-ui'
import { AdsTab } from './AdsTab'
import { AsinTab } from './AsinTab'
import { BridgeCompareTab } from './BridgeCompareTab'
import { CoverageTab } from './CoverageTab'
import { OverviewTab } from './OverviewTab'
import { StoresTab } from './StoresTab'

// 利润分析（P2b-10，07 章 7.9）：七个页签——总览、店铺利润、ASIN 利润、广告后利润、成本覆盖、利润桥对比、期间关账。
// 数据全部来自利润日表（P2b-09 派生），金额是美元。净利润在范围内有商品缺成本时整体不给，只给已能算出的部分并写明；
// 关税、汇兑损益、广告分摊到商品这几项还没有数据来源，页面如实写“尚未接入”，不用 0 补；官方单品经济的逐 SKU 逐日核对在“官方经济数据对账”页（P2b-11）。
// 收入确认口径（下单、发货、结算释放）在页面顶部切换，所有页签一起变；成本相关的内容（成本覆盖、折算明细）需要成本字段权限。

const OPTIONS = PROFIT_BASES.map(value => ({ value, label: PROFIT_BASIS_LABEL[value].replace('口径', '') }))

export default function ProfitPage() {
  const { canPermission } = useSession()
  const [recognition, setRecognition] = useState<ProfitBasis>('ORDERED')
  const withCost = canPermission('field.cost')
  const items = [
    { key: 'overview', label: '总览', children: <OverviewTab recognition={recognition} /> },
    { key: 'stores', label: '店铺利润', children: <StoresTab recognition={recognition} /> },
    { key: 'asins', label: 'ASIN 利润', children: <AsinTab recognition={recognition} /> },
    { key: 'ads', label: '广告后利润', children: <AdsTab recognition={recognition} /> },
    ...(withCost ? [{ key: 'coverage', label: '成本覆盖', children: <CoverageTab recognition={recognition} /> }] : []),
    { key: 'compare', label: '利润桥对比', children: <BridgeCompareTab recognition={recognition} /> },
    {
      key: 'periods',
      label: '期间关账',
      children: (
        <Alert
          type="info"
          showIcon
          message="关账在“期间关账”页处理"
          description={
            <>
              关账后冻结当期利润口径，由{' '}
              <LiveLink component="AccountingPeriodsPage" id="">
                期间关账
              </LiveLink>{' '}
              页面处理：完整性检查、审批、锁定快照；未关账的期间，这里看到的都是实时口径的利润，会随数据更新而变化。
            </>
          }
        />
      ),
    },
  ]
  return (
    <div>
      <PageHeader
        title="利润分析"
        description="从销售额到净利润的利润桥：平台费用、退款、商品成本、头程逐项扣减。有商品缺成本时净利润整体不给；关税、汇兑损益、广告分摊到商品尚未接入，页面写明，不用 0 补。"
        actions={<Select style={{ width: 130 }} aria-label="收入确认口径" value={recognition} options={OPTIONS} onChange={value => setRecognition(value)} />}
      />
      <Card size="small">
        <Tabs items={items} destroyOnHidden />
      </Card>
    </div>
  )
}
