import { App, Button, Checkbox, Popover, Segmented, Space, Tooltip, Typography } from 'antd'
import { KPI_KEYS, OVERVIEW_SECTION_LABEL, OVERVIEW_TEMPLATE_SPECS, overviewTemplateOf, type KpiKey, type OverviewTemplate } from '@nova/api-contracts'
import { useSession } from '../../session/session'
import type { useOverviewLayout } from './use-layout'

// 视图模板切换与个人布局（04 章 4.1 第 9 项）：经营者、运营、财务、供应链 4 种模板；可隐藏区域和指标卡，保存为“我的布局”。

const CARD_LABEL: Record<KpiKey, string> = {
  sales: '销售额',
  profit: '净利润',
  margin: '利润率',
  adsSpend: '广告花费',
  adsShare: '广告占总销售比',
  stockRisk: '可售天数风险数',
  anomalies: '待处理异常数',
}

export function LayoutControls({ state }: { state: ReturnType<typeof useOverviewLayout> }) {
  const { message } = App.useApp()
  const { canPermission } = useSession()
  const spec = overviewTemplateOf(state.layout.template)
  const canSave = canPermission('view.manage')
  const save = async () => {
    try {
      await state.save()
      void message.success('已保存为“我的布局”')
    } catch {
      // 失败原因已由统一的请求层提示
    }
  }
  const customize = (
    <div style={{ width: 260 }}>
      <Typography.Text strong>显示的区域</Typography.Text>
      <div style={{ display: 'grid', gap: 4, margin: '4px 0 8px' }}>
        {spec.sections.map(section => (
          <Checkbox key={section} checked={!state.layout.hiddenSections.includes(section)} onChange={event => state.toggleSection(section, event.target.checked)}>
            {OVERVIEW_SECTION_LABEL[section]}
          </Checkbox>
        ))}
      </div>
      <Typography.Text strong>显示的指标卡</Typography.Text>
      <div style={{ display: 'grid', gap: 4, margin: '4px 0' }}>
        {KPI_KEYS.filter(key => spec.cards.includes(key)).map(key => (
          <Checkbox key={key} checked={!state.layout.hiddenCards.includes(key)} onChange={event => state.toggleCard(key, event.target.checked)}>
            {CARD_LABEL[key]}
          </Checkbox>
        ))}
      </div>
    </div>
  )
  return (
    <Space size={8} wrap>
      <Segmented
        size="small"
        value={state.layout.template}
        onChange={value => state.setTemplate(value as OverviewTemplate)}
        options={OVERVIEW_TEMPLATE_SPECS.map(item => ({ value: item.key, label: item.label }))}
        aria-label="视图模板"
      />
      <Popover trigger="click" placement="bottomRight" title="自定义布局" content={customize}>
        <Button size="small">自定义</Button>
      </Popover>
      <Tooltip title={canSave ? undefined : '没有“保存视图”权限'}>
        <span>
          <Button size="small" type={state.dirty ? 'primary' : 'default'} disabled={!canSave || !state.dirty} loading={state.saving} onClick={() => void save()}>
            保存为我的布局
          </Button>
        </span>
      </Tooltip>
      {state.dirty ? (
        <Button size="small" type="link" onClick={state.reset}>
          放弃调整
        </Button>
      ) : null}
    </Space>
  )
}
