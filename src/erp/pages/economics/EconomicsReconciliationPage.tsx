import { Alert, Card, Tabs } from 'antd'
import { PageHeader } from '../../components'
import { useSession } from '../../session/session'
import { CompareTab } from './CompareTab'
import { PreviewTab } from './PreviewTab'
import { SimulateTab } from './SimulateTab'

// 官方经济数据对账（P2b-11，07 章 7.10）：亚马逊数据中心的官方单品经济与我方利润日表双源核对、未来 120 天的官方费用预览、情景模拟。
// 双源核对会同时露出官方的净收益、销售额、费用和成本，所以需要利润与成本两个字段权限；费用预览与情景模拟只需要财务读取权限。
// 官方数据每天拉一次（亚马逊要求先提交查询再取结果），页面顶部的数据新鲜度写明最近一次成功时间。

export default function EconomicsReconciliationPage() {
  const { canPermission } = useSession()
  const allowed = canPermission('field.profit') && canPermission('field.cost')
  const items = [
    {
      key: 'compare',
      label: '双源核对',
      children: allowed ? <CompareTab /> : <Alert type="warning" showIcon message="无权查看" description="双源核对会同时显示官方的净收益、销售额、费用与成本，需要同时具备利润字段和成本字段权限。" />,
    },
    { key: 'preview', label: '费用预览', children: <PreviewTab /> },
    { key: 'simulate', label: '情景模拟', children: <SimulateTab /> },
  ]
  return (
    <div>
      <PageHeader
        title="官方经济数据对账"
        description="把亚马逊官方单品经济与我方利润逐 SKU 逐日核对，差异拆成成本口径、广告口径、时间口径和未解释；另有官方未来 120 天的费用预览与情景模拟。官方没有给出的数写“官方未提供”，没有记录写“尚无记录”，不用 0 补。"
      />
      <Card size="small">
        <Tabs items={items} destroyOnHidden />
      </Card>
    </div>
  )
}
