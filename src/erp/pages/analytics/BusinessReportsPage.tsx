import { Card, Tabs } from 'antd'
import { BR_TAB_LABEL, type BrTab } from '@nova/api-contracts'
import { PageHeader } from '../../components'
import { AsinTab } from './AsinTab'
import { DashboardTab } from './DashboardTab'
import { DateTab } from './DateTab'

// 业务报告（P4-02，04 章 4.5）：店铺销量与流量的正式入口，六个页签——销售仪表盘、按日期、销售与流量（SKU）、详情页销售与流量（子体）、父体详情页销售与流量、月度销售与订单。
// 数据来自亚马逊官方的销售与流量（P4-01 同步：数据中心为主、报告补充为辅，同店同日只用数据中心），金额是美元，日期是亚马逊美国站的日历日。
// 官方没给的值写“尚无记录”，不当 0，也不用订单估算来冒充；缺品牌分析角色的店铺单独说明；浏览器与移动应用拆分尚未接入。
// 日期范围与对比期用页面顶部的全局范围；每个页签单独取数，切走即释放。

const ITEMS: Array<{ key: BrTab; children: React.ReactNode }> = [
  { key: 'dashboard', children: <DashboardTab /> },
  { key: 'date', children: <DateTab /> },
  { key: 'sales-traffic', children: <AsinTab level="SKU" /> },
  { key: 'detail', children: <AsinTab level="CHILD" /> },
  { key: 'parent', children: <AsinTab level="PARENT" /> },
  { key: 'monthly', children: <DateTab monthly /> },
]

export default function BusinessReportsPage() {
  return (
    <div>
      <PageHeader
        title="业务报告"
        description="亚马逊官方的销售与流量：会话、页面浏览量、转化率、订购商品销售额与购物车获得率，可按日期、SKU、ASIN、父体和月度查看。官方没给的值写“尚无记录”，不用订单估算冒充。"
      />
      <Card size="small">
        <Tabs items={ITEMS.map(item => ({ ...item, label: BR_TAB_LABEL[item.key] }))} destroyOnHidden />
      </Card>
    </div>
  )
}
