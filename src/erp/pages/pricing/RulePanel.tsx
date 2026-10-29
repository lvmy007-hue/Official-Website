import { useState } from 'react'
import { Alert, Space, Tag, Tooltip, Typography } from 'antd'
import { PRICING_RULE_WRITE, type PricingRuleListResponse, type PricingRuleStatus, type PricingRuleView, type PricingWriteStatuses, type RuleRunView } from '@nova/api-contracts'
import { ActionGuard, SimpleGrid } from '../../components'
import { formatDateTime, formatPercent } from '../../format'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import type { PriceChangeTarget, RuleSuggestion } from './PriceChangeDrawer'
import { RuleDryRunDrawer } from './RuleDryRunDrawer'
import { RuleFormDrawer } from './RuleFormDrawer'
import { RuleRunsDrawer } from './RuleRunsDrawer'
import { guardOf } from './pricing-state'

// 定价规则（P4-11）：手动规则只生成待确认的建议；自动规则要“自动调价”与“改价”两个开关都打开、并通过护栏、单次调幅上限、
// 每个 SKU 每天次数上限后才会真的改价，连续失败或调价后转化率、利润率不达标会熔断（暂停规则，需要人工恢复）。

const STATUS_COLOR: Record<PricingRuleStatus, string> = { ACTIVE: 'success', PAUSED: 'default', BREAKER: 'error' }

export function RulePanel({
  write,
  stores,
  onConfirm,
}: {
  write: PricingWriteStatuses | undefined
  stores: Array<{ id: string; name: string }>
  onConfirm: (target: PriceChangeTarget, suggestion: RuleSuggestion) => void
}) {
  const [editing, setEditing] = useState<PricingRuleView | 'new' | null>(null)
  const [dryRun, setDryRun] = useState<PricingRuleView | null>(null)
  const [runs, setRuns] = useState<PricingRuleView | null>(null)
  const query = useApiQuery<PricingRuleListResponse>({ domain: 'list', path: '/pricing/rules', scoped: false })
  const change = useApiMutation<{ rule: PricingRuleView; status: PricingRuleStatus }>({
    method: 'PATCH',
    path: ({ rule }) => `/pricing/rules/${encodeURIComponent(rule.id)}`,
    body: ({ rule, status }) => ({ expectedVersion: rule.version, status }),
    invalidate: ['list', 'config', 'realtime'],
    silent: true,
  })
  const guard = guardOf(PRICING_RULE_WRITE, write?.rule)

  const confirm = (run: RuleRunView) => {
    if (!runs || run.suggestedPrice === null) return
    onConfirm(
      { storeId: runs.storeId, sku: run.sku, asin: run.asin, title: run.sku, currency: 'USD', price: run.currentPrice, expectedPrice: null, limits: null },
      { ruleRunId: run.id, price: run.suggestedPrice, source: 'RULE_CONFIRMED' },
    )
    setRuns(null)
  }

  return (
    <div data-testid="pricing-rules">
      <Space style={{ marginBottom: 8 }} wrap>
        <ActionGuard label="新建规则" guard={guard} onExecute={async () => setEditing('new')} buttonProps={{ type: 'primary' }} />
      </Space>
      {query.data?.truncated ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="规则很多，只显示了前 100 条" /> : null}
      <SimpleGrid<PricingRuleView>
        gridId="pricing.rule-panel"
        rows={query.data?.items}
        rowKey={row => row.id}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '定价规则', prerequisite: '还没有定价规则；新建后可以先试运行，再启用。' }}
        columns={[
          {
            title: '规则',
            key: 'name',
            fixed: 'left',
            width: 220,
            render: (_v, row) => (
              <div>
                <strong>{row.name}</strong>
                <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{row.storeName}</div>
              </div>
            ),
          },
          { title: '策略', key: 'strategy', width: 240, render: (_v, row) => (row.scenarioText ? `情形 × 动作矩阵：${row.scenarioText}` : `${row.strategyLabel}：${row.paramsText}`) },
          { title: '适用商品', key: 'scope', width: 180, render: (_v, row) => row.scopeText },
          {
            title: '执行方式',
            key: 'mode',
            width: 200,
            render: (_v, row) => (
              <div>
                {row.modeLabel}
                {row.mode === 'AUTO' && !row.autoReady ? (
                  <Tooltip title={row.autoNote ?? '开关没有全部打开'}>
                    <Tag color="warning" bordered={false} style={{ marginLeft: 4 }}>
                      只生成建议
                    </Tag>
                  </Tooltip>
                ) : null}
                {row.mode === 'AUTO' && row.autoReady ? (
                  <Tag color="processing" bordered={false} style={{ marginLeft: 4 }}>
                    可自动执行
                  </Tag>
                ) : null}
              </div>
            ),
          },
          {
            title: '状态',
            key: 'status',
            width: 200,
            render: (_v, row) => (
              <div>
                <Tag color={STATUS_COLOR[row.status]} bordered={false}>
                  {row.statusLabel}
                </Tag>
                {row.breakerReason ? <div style={{ fontSize: 12, color: 'var(--ant-color-error)' }}>{row.breakerReason}</div> : null}
              </div>
            ),
          },
          {
            title: '限制',
            key: 'limits',
            width: 190,
            render: (_v, row) => (
              <span style={{ fontSize: 12 }}>
                单次 ≤ {formatPercent(row.maxChangePct, { digits: 1 })}；每个 SKU 每天 ≤ {row.dailyLimit} 次
              </span>
            ),
          },
          {
            title: '待确认建议',
            key: 'pending',
            width: 110,
            render: (_v, row) => (row.pendingSuggestions > 0 ? <Tag color="processing">{row.pendingSuggestions} 条</Tag> : <Muted>无</Muted>),
          },
          { title: '最近评估', key: 'evaluated', width: 160, render: (_v, row) => (row.lastEvaluatedAt ? formatDateTime(row.lastEvaluatedAt) : <Muted>尚无记录</Muted>) },
          {
            title: '操作',
            key: 'actions',
            fixed: 'right',
            width: 300,
            render: (_v, row) => (
              <Space size={0} wrap>
                <ActionGuard label="修改" guard={guard} onExecute={async () => setEditing(row)} buttonProps={{ type: 'link', size: 'small' }} />
                <ActionGuard label="试运行" guard={guard} onExecute={async () => setDryRun(row)} buttonProps={{ type: 'link', size: 'small' }} />
                <ActionGuard label="执行记录" guard={{}} onExecute={async () => setRuns(row)} buttonProps={{ type: 'link', size: 'small' }} />
                {row.status === 'ACTIVE' ? (
                  <ActionGuard label="暂停" guard={guard} onExecute={() => change.mutateAsync({ rule: row, status: 'PAUSED' })} buttonProps={{ type: 'link', size: 'small' }} />
                ) : (
                  <ActionGuard
                    label={row.status === 'BREAKER' ? '恢复' : '启用'}
                    guard={guard}
                    preview={
                      row.status === 'BREAKER'
                        ? {
                            title: '恢复熔断的规则',
                            content: <Typography.Paragraph>熔断原因：{row.breakerReason ?? '未记录'}。恢复后规则会按原设置继续评估，请先确认原因已经处理。</Typography.Paragraph>,
                            confirmText: '确认恢复',
                          }
                        : undefined
                    }
                    onExecute={() => change.mutateAsync({ rule: row, status: 'ACTIVE' })}
                    buttonProps={{ type: 'link', size: 'small' }}
                  />
                )}
              </Space>
            ),
          },
        ]}
      />
      <RuleFormDrawer key={editing === null ? 'closed' : editing === 'new' ? 'new' : editing.id} editing={editing} stores={stores} onClose={() => setEditing(null)} />
      <RuleDryRunDrawer rule={dryRun} write={write} onClose={() => setDryRun(null)} />
      <RuleRunsDrawer rule={runs} onClose={() => setRuns(null)} onConfirm={confirm} />
    </div>
  )
}
