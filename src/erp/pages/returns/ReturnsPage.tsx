import { useState } from 'react'
import { Card, Tabs } from 'antd'
import { PageHeader } from '../../components'
import { AnalysisPanel } from './AnalysisPanel'
import { AwaitingPanel } from './AwaitingPanel'
import { ReasonMapPanel } from './ReasonMapPanel'
import { ReturnsListTab } from './ReturnsListTab'

// 退货（P2b-02，07 章 7.2；P6-13）：四个视图——退货记录、退款后未收到退货（待核实清单）、退货分析（原因、周期、跨月、队列、库存属性×处置）、原因映射。
// 退货记录来自客户退货报告（每日同步），退款金额与先后来自财务交易（订单口径）；没有数据写“尚无记录”，没有财务交易写“待财务交易”。
// 各视图第一次打开才取数；买家备注只在详情里查看。

export default function ReturnsPage() {
  const [active, setActive] = useState('list')
  return (
    <div>
      <PageHeader
        title="退货"
        description="亚马逊物流客户退货：退货明细、处置、退款与赔付状态；退款后长时间没有收到退货的订单单独列出待核实；按原因、周期、跨月和下单月队列看退货。买家备注只在详情里查看。"
      />
      <Card size="small">
        <Tabs
          activeKey={active}
          onChange={setActive}
          items={[
            { key: 'list', label: '退货记录', children: <ReturnsListTab /> },
            { key: 'awaiting', label: '退款后未收到退货', children: <AwaitingPanel /> },
            { key: 'analysis', label: '退货分析', children: <AnalysisPanel onOpenReasonMap={() => setActive('reason-map')} /> },
            { key: 'reason-map', label: '原因映射', children: <ReasonMapPanel /> },
          ]}
        />
      </Card>
    </div>
  )
}
