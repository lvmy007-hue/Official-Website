import { Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ADS_RULE_ACTION_LABEL,
  ADS_RULE_FREQUENCY_LABEL,
  ADS_RULE_LEVEL_LABEL,
  ADS_RULE_METRIC_INFO,
  ADS_RULE_OUTCOME_LABEL,
  ADS_RULE_STATUS_LABEL,
  formatRuleValue,
  type AdsRuleAutoStatus,
  type AdsRuleHit,
  type AdsRuleMetric,
  type AdsRuleProfileOption,
  type AdsRuleRow,
  type AdsRuleRunRow,
  type AdsRuleSkip,
} from '@nova/api-contracts'
import { AppLink } from '../../nav/AppLink'
import { formatDateTime } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { NONE } from './ads-campaigns-ui'
import { ConflictTag } from './ads-conflicts-panel'
import { RuleEditor } from './ads-rules-editor'

// 自动规则列表、命中、跳过与运行记录的列（P3-13）。没有的值写“尚无记录”，不当 0。

/** 触发时的指标取值：键是“指标:窗口天数”，按指标单位显示。 */
export function evidenceText(metrics: Record<string, number | null>): string {
  const parts = Object.entries(metrics).map(([key, value]) => {
    const [metric, days] = key.split(':') as [AdsRuleMetric, string | undefined]
    const info = ADS_RULE_METRIC_INFO[metric]
    return info ? `${days ? `近 ${days} 天` : ''}${info.label} ${formatRuleValue(metric, value)}` : `${key} ${value ?? '无数据'}`
  })
  return parts.length > 0 ? parts.join('；') : '尚无记录'
}

export function ruleColumns(profiles: readonly AdsRuleProfileOption[], auto: AdsRuleAutoStatus, canWrite: boolean, onDone: () => void, conflicts?: Record<string, number>): ColumnsType<AdsRuleRow> {
  return [
    {
      title: '规则',
      key: 'name',
      width: 220,
      render: (_value, row) => (
        <div>
          <AppLink to={`/app/advertising/rules/${row.id}`}>
            <strong>{row.name}</strong>
          </AppLink>
          <ConflictTag counts={conflicts} id={row.id} />
          <div>
            <Tag bordered={false} color={row.status === 'ACTIVE' ? 'success' : 'default'}>
              {ADS_RULE_STATUS_LABEL[row.status]}
            </Tag>
            <Tag bordered={false} color={row.mode === 'AUTO' ? 'orange' : 'blue'}>
              {row.mode === 'AUTO' ? '自动执行' : '建议模式'}
            </Tag>
          </div>
        </div>
      ),
    },
    {
      title: '广告账户',
      key: 'account',
      width: 150,
      render: (_value, row) => (
        <div>
          <div>{row.accountName}</div>
          {row.storeName ? <Muted>{row.storeName}</Muted> : null}
        </div>
      ),
    },
    {
      title: '条件与动作',
      key: 'content',
      width: 340,
      render: (_value, row) => (
        <div>
          <div>
            {ADS_RULE_LEVEL_LABEL[row.spec.level]}：{row.summary.conditions}
          </div>
          {row.summary.filters ? <Muted>{row.summary.filters}</Muted> : null}
          <div>→ {row.summary.action}</div>
          <Muted>{row.summary.scope}</Muted>
        </div>
      ),
    },
    { title: '频率', key: 'frequency', width: 100, render: (_value, row) => ADS_RULE_FREQUENCY_LABEL[row.frequency] },
    {
      title: '最近评估',
      key: 'last',
      width: 190,
      render: (_value, row) =>
        row.lastRunAt ? (
          <div>
            <div>{formatDateTime(row.lastRunAt)}</div>
            <Muted>{row.lastEvaluated === null ? NONE : `评估 ${row.lastEvaluated} 个，命中 ${row.lastMatched ?? 0} 个`}</Muted>
          </div>
        ) : (
          '尚未评估'
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      fixed: 'right',
      render: (_value, row) => (
        <span>
          <AppLink to={`/app/advertising/rules/${row.id}`}>详情</AppLink>
          {canWrite ? <RuleEditor rule={row} profiles={profiles} auto={auto} onDone={onDone} /> : null}
        </span>
      ),
    },
  ]
}

export function hitColumns(): ColumnsType<AdsRuleHit> {
  return [
    {
      title: '对象',
      key: 'label',
      width: 240,
      render: (_value, row) => (
        <div>
          <div>{row.label}</div>
          {row.campaignLabel ? <Muted>{row.campaignLabel}</Muted> : null}
        </div>
      ),
    },
    { title: '触发时的指标', key: 'metrics', width: 300, render: (_value, row) => evidenceText(row.metrics) },
    { title: '动作', key: 'action', width: 120, render: (_value, row) => ADS_RULE_ACTION_LABEL[row.actionType] },
    {
      title: '如果现在执行',
      key: 'change',
      width: 240,
      render: (_value, row) => (
        <div>
          <div>
            {row.before ?? NONE} → {row.after ?? NONE}
          </div>
          {row.notes.map(note => (
            <Muted key={note}>{note}</Muted>
          ))}
        </div>
      ),
    },
    { title: '近 30 天花费', key: 'spend', width: 120, align: 'right', render: (_value, row) => (row.spend === null ? NONE : `$${row.spend.toFixed(2)}`) },
  ]
}

export function skipColumns(): ColumnsType<AdsRuleSkip> {
  return [
    { title: '对象', key: 'label', dataIndex: 'label', width: 280 },
    { title: '没有动作的原因', key: 'reason', dataIndex: 'reason' },
  ]
}

export function runColumns(): ColumnsType<AdsRuleRunRow> {
  return [
    { title: '时间', key: 'runAt', width: 170, render: (_value, row) => formatDateTime(row.runAt) },
    { title: '对象', key: 'entity', width: 220, render: (_value, row) => row.entityLabel ?? row.entityKey },
    { title: '动作', key: 'action', width: 120, render: (_value, row) => ADS_RULE_ACTION_LABEL[row.actionType] },
    { title: '前后', key: 'change', width: 220, render: (_value, row) => (row.before === null && row.after === null ? NONE : `${row.before ?? NONE} → ${row.after ?? NONE}`) },
    { title: '触发时的指标', key: 'evidence', width: 280, render: (_value, row) => evidenceText(row.evidence) },
    {
      title: '结果',
      key: 'outcome',
      width: 150,
      render: (_value, row) => (
        <Tooltip title={row.message}>
          <Tag bordered={false} color={row.outcome === 'APPLIED' ? 'success' : row.outcome === 'FAILED' ? 'error' : row.outcome === 'SKIPPED' ? 'default' : 'processing'}>
            {ADS_RULE_OUTCOME_LABEL[row.outcome]}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: '待办',
      key: 'workItem',
      width: 90,
      render: (_value, row) => (row.workItemId ? <AppLink to="/app/my/work-items">已生成</AppLink> : NONE),
    },
  ]
}
