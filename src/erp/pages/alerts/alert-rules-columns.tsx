import { Space, Tag, Typography } from 'antd'
import { ALERT_NOTIFY_FREQUENCY_LABEL, describeEscalation, type AlertRuleView, type AlertRulesResponse } from '@nova/api-contracts'
import { renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { Muted } from '../inventory/inventory-ui'
import { RuleEditAction } from './alert-rule-fields'
import { VersionsAction } from './alert-rule-versions'
import { paramLines, scopeText, statsCells, type ScopeNames } from './alert-rules-ui'
import { SeverityTag } from './alerts-ui'

// 规则配置页的列（P5-01；P6-16 迁到 PagedGrid 骨架）：规则、业务域、严重度、状态、条件或阈值、通知频率、多级升级、作用范围、冷却、质量统计、版本、操作。
// 自定义指标规则的“条件”列写条件描述（来自服务端 conditionText），预置规则写阈值清单。

export const RULE_SORTLESS = { sortable: false } as const

export function ruleColumns(data: AlertRulesResponse, names: ScopeNames, refresh: () => void): ErpColDef<AlertRuleView>[] {
  return [
    renderColumn<AlertRuleView>(
      '规则',
      'name',
      rule => (
        <div>
          <Typography.Text strong>{rule.name}</Typography.Text>
          {rule.custom ? <Tag style={{ marginLeft: 6 }}>自定义</Tag> : null}
        </div>
      ),
      { group: '规则', pin: 'left', width: 240 },
    ),
    renderColumn<AlertRuleView>('业务域', 'domain', rule => rule.domainLabel, { group: '规则', width: 100 }),
    renderColumn<AlertRuleView>('严重度', 'severity', rule => <SeverityTag severity={rule.severity} />, { group: '规则', width: 90 }),
    renderColumn<AlertRuleView>(
      '状态',
      'enabled',
      rule =>
        rule.enabled ? (
          <Tag color="success" bordered={false}>
            启用
          </Tag>
        ) : (
          <Tag bordered={false}>已关闭</Tag>
        ),
      { group: '规则', width: 80 },
    ),
    renderColumn<AlertRuleView>(
      '条件与阈值',
      'params',
      rule => {
        if (rule.conditionText) return rule.conditionText
        const lines = paramLines(rule.type, rule.params)
        return lines.length > 0 ? lines.map(line => `${line.label} ${line.value}`).join('；') : <Muted>{rule.description || '没有可调的阈值'}</Muted>
      },
      { group: '条件', width: 360 },
    ),
    renderColumn<AlertRuleView>('作用范围', 'scope', rule => scopeText(rule.scope, names), { group: '条件', width: 260 }),
    renderColumn<AlertRuleView>('冷却', 'cooldown', rule => `${rule.cooldownMinutes} 分钟`, { group: '通知', width: 90, ...RIGHT_ALIGNED }),
    renderColumn<AlertRuleView>('通知频率', 'notifyFrequency', rule => ALERT_NOTIFY_FREQUENCY_LABEL[rule.notifyFrequency], { group: '通知', width: 110 }),
    renderColumn<AlertRuleView>('多级升级', 'escalation', rule => (rule.escalation.length > 0 ? describeEscalation(rule.escalation) : <Muted>不升级</Muted>), { group: '通知', width: 300 }),
    renderColumn<AlertRuleView>('近 90 天命中', 'hits', rule => statsCells(rule.stats).hits, { group: '质量', width: 110, ...RIGHT_ALIGNED }),
    renderColumn<AlertRuleView>('误报率', 'rate', rule => statsCells(rule.stats).rate, { group: '质量', width: 150 }),
    renderColumn<AlertRuleView>('平均处理时长', 'hours', rule => statsCells(rule.stats).hours, { group: '质量', width: 130 }),
    renderColumn<AlertRuleView>('版本', 'currentVersion', rule => `第 ${rule.currentVersion} 版`, { group: '质量', width: 80, ...RIGHT_ALIGNED }),
    renderColumn<AlertRuleView>(
      '操作',
      'actions',
      rule => (
        <Space size={4}>
          <RuleEditAction rule={rule} data={data} onChanged={refresh} />
          <VersionsAction rule={rule} names={names} />
        </Space>
      ),
      { group: '操作', pin: 'right', width: 190, ...RULE_SORTLESS },
    ),
  ]
}
