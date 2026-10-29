import { Alert, Card, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { ReceivingApplyBody, ReceivingApplyResult, ReceivingStatRow, ReceivingStatsResponse } from '@nova/api-contracts'
import { ActionGuard, DataState, stateFromError, SimpleGrid } from '../../components'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'

// 接收时长统计（P2a-13，06 章 6.12）：按目的运营中心看开始接收到接收完成的天数分布，人工确认后把 p90 回写补货策略的“入仓接收天数”。
// 时间是同步时第一次看到的时间，口径写在页面上；样本不足的运营中心只显示，不允许回写。回写保存成企业级补货策略的新版本，下一次计算起生效。

const POLICY_WRITE = 'replenishment.policy.write'
const days = (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{value} 天</span>)

export function ReceivingStatsPanel() {
  const query = useApiQuery<ReceivingStatsResponse>({ domain: 'list', path: '/inbound/receiving/stats', scoped: false })
  const apply = useApiMutation<ReceivingApplyBody, ReceivingApplyResult>({ method: 'POST', path: '/inbound/receiving/stats/apply', invalidate: ['list'], silent: true })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'inbound.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={3} />
  const stats = query.data

  const columns: ColumnsType<ReceivingStatRow> = [
    { title: '目的运营中心', dataIndex: 'label', width: 140 },
    { title: '样本（已关闭货件）', dataIndex: 'sampleCount', width: 150, align: 'right', render: (value: number) => <span className="erp-num">{value}</span> },
    { title: 'p50（中位）', dataIndex: 'p50Days', width: 110, align: 'right', render: days },
    { title: 'p90', dataIndex: 'p90Days', width: 100, align: 'right', render: days },
    { title: '最短', dataIndex: 'minDays', width: 90, align: 'right', render: days },
    { title: '最长', dataIndex: 'maxDays', width: 90, align: 'right', render: days },
    {
      title: '回写补货策略',
      key: 'apply',
      width: 200,
      render: (_value, row) => (
        <ActionGuard
          label="回写 p90"
          guard={{ permission: POLICY_WRITE, condition: { ok: row.applyBlocked === null && stats.policyVersionNo !== null, reason: row.applyBlocked ?? undefined } }}
          buttonProps={{ size: 'small' }}
          preview={{
            title: `把 ${row.label} 的 p90 回写补货策略`,
            confirmText: '确认回写',
            content: (
              <Alert
                type="warning"
                showIcon
                message={`入仓接收天数：${stats.policyReceivingDays ?? '未配置'} → ${row.p90Days} 天`}
                description="保存成企业级补货策略的新版本（旧版本不改），对全部店铺生效，下一次补货计算起使用；总提前期不会改动。需要全部店铺的数据范围。"
              />
            ),
          }}
          successText="已回写，补货策略生成了新版本"
          onExecute={() => apply.mutateAsync({ destinationFc: row.destinationFc, expectedVersionNo: stats.policyVersionNo as number })}
        />
      ),
    },
  ]

  return (
    <Card size="small" title="接收时长统计" data-testid="receiving-stats">
      <SimpleGrid<ReceivingStatRow>
        gridId="inbound.receiving-stats-panel"
        columns={columns}
        rows={[stats.overall, ...stats.rows]}
        rowKey={row => row.destinationFc ?? '__all__'}
        emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录' }}
      />
      <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
        当前补货策略的入仓接收天数：{stats.policyReceivingDays === null ? '尚未配置' : `${stats.policyReceivingDays} 天`}。{stats.basis}
      </Typography.Paragraph>
    </Card>
  )
}
