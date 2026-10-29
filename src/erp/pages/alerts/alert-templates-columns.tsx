import { Button, Tooltip } from 'antd'
import type { AlertTemplateItem } from '@nova/api-contracts'
import { renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { paramLines } from './alert-rules-ui'
import { SeverityTag } from './alerts-ui'

// 规则模板页的列（P6-15）：分组、模板名称、一句话条件、适用维度、严重度、默认阈值、冷却、企业里已有几条同逻辑的规则、“从模板新建”。
// “从模板新建”跳到规则配置页并带上模板代码（页面自动打开新建弹窗，带入模板的评估逻辑与默认阈值）；没有预警管理权限的人按钮禁用并写原因。

export const TEMPLATES_MANAGE_REASON = '没有预警管理权限，不能新建规则'

const cooldownText = (minutes: number) => (minutes % 1440 === 0 && minutes > 0 ? `${minutes / 1440} 天` : minutes % 60 === 0 && minutes > 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`)

export function templateColumns(canCreate: boolean): ErpColDef<AlertTemplateItem>[] {
  return [
    renderColumn<AlertTemplateItem>('分组', 'group', row => row.groupLabel, { group: '模板', width: 90 }),
    renderColumn<AlertTemplateItem>(
      '模板',
      'name',
      row => (
        <Tooltip title={row.description}>
          <span>{row.name}</span>
        </Tooltip>
      ),
      { group: '模板', pin: 'left', width: 220 },
    ),
    renderColumn<AlertTemplateItem>('条件', 'condition', row => row.condition, { group: '模板', width: 420 }),
    renderColumn<AlertTemplateItem>('适用维度', 'dimension', row => row.dimension, { group: '模板', width: 160 }),
    renderColumn<AlertTemplateItem>('严重度', 'severity', row => <SeverityTag severity={row.severity} />, { group: '默认设置', width: 90 }),
    renderColumn<AlertTemplateItem>(
      '默认阈值',
      'params',
      row => {
        const lines = paramLines(row.type, row.params)
        return lines.length > 0 ? lines.map(line => `${line.label} ${line.value}`).join('；') : <Muted>没有可调的阈值</Muted>
      },
      { group: '默认设置', width: 320 },
    ),
    renderColumn<AlertTemplateItem>('冷却', 'cooldown', row => cooldownText(row.cooldownMinutes), { group: '默认设置', width: 90, ...RIGHT_ALIGNED }),
    renderColumn<AlertTemplateItem>('已有规则', 'ruleCount', row => (row.ruleCount === 0 ? <Muted>尚无</Muted> : `${row.ruleCount} 条（启用 ${row.enabledCount}）`), { group: '企业', width: 130 }),
    renderColumn<AlertTemplateItem>(
      '操作',
      'actions',
      row =>
        canCreate ? (
          <AppLink to="/app/alerts/rules" search={{ template: row.code }}>
            <Button size="small">从模板新建</Button>
          </AppLink>
        ) : (
          <Tooltip title={TEMPLATES_MANAGE_REASON}>
            <span>
              <Button size="small" disabled>
                从模板新建
              </Button>
            </span>
          </Tooltip>
        ),
      { group: '操作', pin: 'right', width: 130, sortable: false },
    ),
  ]
}
