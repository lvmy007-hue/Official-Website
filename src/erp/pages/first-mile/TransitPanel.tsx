import { Alert, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { type TransitApplyResult, type TransitMonthPoint, type TransitStatRow, type TransitStatsResponse } from '@nova/api-contracts'
import { FormAction, RowDetailDrawer, SimpleGrid, useRowDetail } from '../../components'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { count } from '../procurement/procurement-ui'

// 实际时效（06 章 6.10 先进能力）：按货代与运输方式统计“发货日到实际交付日”的天数分布。
// 样本不足时只显示不建议回写；回写是人工确认的动作：把九成运单交付所需的天数写入企业级补货策略，保存成新的策略版本（旧版本不改）。

const POLICY_WRITE = 'replenishment.policy.write'
const rowKeyOf = (row: TransitStatRow) => `${row.forwarderId}-${row.mode}`
const days = (value: number | null) => (value === null ? <Muted>样本不足</Muted> : <span className="erp-num">{value} 天</span>)

const monthColumns: ColumnsType<TransitMonthPoint> = [
  { title: '交付月份', dataIndex: 'month', width: 120, render: (value: string) => value.slice(0, 7) },
  { title: '样本数', dataIndex: 'sampleCount', width: 90, align: 'right', render: count },
  { title: '中位（p50）', dataIndex: 'p50Days', width: 120, align: 'right', render: days },
  { title: '九成不超过（p90）', dataIndex: 'p90Days', width: 150, align: 'right', render: days },
]

export function TransitPanel() {
  const stats = useApiQuery<TransitStatsResponse>({ domain: 'list', path: '/first-mile/transit-stats', scoped: false })
  const apply = useApiMutation<{ forwarderId: string; mode: string; expectedVersionNo: number }, TransitApplyResult>({
    method: 'POST',
    path: '/first-mile/transit-stats/apply',
    invalidate: ['list', 'reference'],
    silent: true,
  })
  const versionNo = stats.data?.policyVersionNo ?? null
  const detail = useRowDetail()

  const columns: ColumnsType<TransitStatRow> = [
    { title: '货代', dataIndex: 'forwarderName', width: 180 },
    { title: '运输方式', dataIndex: 'modeLabel', width: 100 },
    { title: '样本数', dataIndex: 'sampleCount', width: 80, align: 'right', render: count },
    { title: '中位（p50）', dataIndex: 'p50Days', width: 110, align: 'right', render: days },
    { title: '九成不超过（p90）', dataIndex: 'p90Days', width: 140, align: 'right', render: days },
    { title: '最短', dataIndex: 'minDays', width: 80, align: 'right', render: days },
    { title: '最长', dataIndex: 'maxDays', width: 80, align: 'right', render: days },
    {
      title: '补货策略现用时效',
      dataIndex: 'policyTransitDays',
      width: 140,
      align: 'right',
      render: (value: number | null) => (value === null ? <Muted>尚未设置</Muted> : <span className="erp-num">{value} 天</span>),
    },
    {
      title: '操作',
      key: 'op',
      width: 130,
      render: (_value, row) => (
        <FormAction
          label="回写补货策略"
          buttonProps={{ type: 'link', size: 'small' }}
          guard={{ permission: POLICY_WRITE, condition: { ok: row.applyBlocked === null && versionNo !== null, reason: row.applyBlocked ?? '企业级补货策略尚未配置' } }}
          title={`回写补货策略：${row.forwarderName} ${row.modeLabel}`}
          description={
            <Alert
              type="info"
              showIcon
              message={`将企业级补货策略里“${row.modeLabel}”的时效改为 ${row.p90Days ?? '—'} 天（样本 ${row.sampleCount} 单，现为 ${row.policyTransitDays ?? '未设置'}）。会保存成新的策略版本，旧版本不改；库存健康与补货建议从下一次计算起使用新值。`}
            />
          }
          okText="回写"
          successText="已回写，补货策略生成了新版本"
          onSubmit={() => apply.mutateAsync({ forwarderId: row.forwarderId, mode: row.mode, expectedVersionNo: versionNo ?? 0 })}
        />
      ),
    },
  ]

  return (
    <div>
      {stats.data ? <Typography.Paragraph type="secondary">{stats.data.basis}</Typography.Paragraph> : null}
      <SimpleGrid<TransitStatRow>
        gridId="first-mile.transit-stats"
        columns={columns}
        rows={stats.data?.rows}
        rowKey={rowKeyOf}
        loading={stats.isFetching}
        error={stats.error}
        onRetry={() => void stats.refetch()}
        emptyState={{ kind: 'empty', domain: '实际时效', prerequisite: '还没有已交付的运单。运单填了发货日与实际交付日之后，这里按货代与运输方式统计天数分布。' }}
        onRowOpen={row => detail.open(rowKeyOf(row))}
      />
      <RowDetailDrawer rows={stats.data?.rows} rowKey={rowKeyOf} openKey={detail.openKey} onClose={detail.close} title={row => `按月交付时效：${row.forwarderName} ${row.modeLabel}`} width={640}>
        {row => (
          <SimpleGrid<TransitMonthPoint>
            gridId="first-mile.transit-months"
            columns={monthColumns}
            rows={row.monthly}
            rowKey={point => point.month}
            emptyState={{ kind: 'empty', domain: '按月时效', prerequisite: '这个货代与运输方式还没有按月的交付样本。' }}
          />
        )}
      </RowDetailDrawer>
    </div>
  )
}
