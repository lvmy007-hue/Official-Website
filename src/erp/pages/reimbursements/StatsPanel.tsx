import { Alert, Descriptions, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { CASE_STATUSES, CASE_STATUS_LABEL, type CurrencyRecovery, type ReimbursementStatsResponse, type RuleStat } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { formatPercent } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { money } from '../orders/orders-ui'

// 回收率与成功率：回收率 = 实收 ÷ 应收（只算已提交且填了应收的案件，按币种分开，不换算）；成功率 = 有结论的案件里批准的占比。
// 没有分母写“样本不足”，不写 0%；实收只来自官方赔付明细的自动匹配。

const rate = (value: number | null, empty: string) => (value === null ? <Muted>{empty}</Muted> : <span className="erp-num">{formatPercent(value, { digits: 1 })}</span>)

const recoveryColumns: ColumnsType<CurrencyRecovery> = [
  { title: '币种', dataIndex: 'currency', width: 90 },
  { title: '已提交案件', dataIndex: 'caseCount', width: 110, align: 'right', render: (value: number) => <span className="erp-num">{value}</span> },
  { title: '应收合计', dataIndex: 'expected', width: 140, align: 'right', render: (value: number, row) => money(value, row.currency) },
  { title: '实收合计', dataIndex: 'received', width: 140, align: 'right', render: (value: number, row) => money(value, row.currency) },
  { title: '回收率', dataIndex: 'recoveryRate', width: 110, align: 'right', render: (value: number | null) => rate(value, '样本不足') },
]

const ruleColumns: ColumnsType<RuleStat> = [
  { title: '机会类型', dataIndex: 'ruleLabel', width: 120, render: (value: string, row) => (row.connected ? value : `${value}（尚未接入）`) },
  { title: '识别依据', dataIndex: 'basis', ellipsis: true },
  {
    title: '待处理机会',
    dataIndex: 'pendingOpportunities',
    width: 110,
    align: 'right',
    render: (value: number, row) => (row.connected ? <span className="erp-num">{value}</span> : <Muted>尚未接入</Muted>),
  },
  { title: '已提交', dataIndex: 'submitted', width: 80, align: 'right', render: (value: number) => <span className="erp-num">{value}</span> },
  { title: '成功', dataIndex: 'won', width: 70, align: 'right', render: (value: number) => <span className="erp-num">{value}</span> },
  { title: '拒绝', dataIndex: 'rejected', width: 70, align: 'right', render: (value: number) => <span className="erp-num">{value}</span> },
  { title: '成功率', dataIndex: 'successRate', width: 140, align: 'right', render: (value: number | null) => rate(value, '尚无有结论的案件') },
]

export function StatsPanel({ stats }: { stats: ReimbursementStatsResponse }) {
  return (
    <div data-testid="reimbursement-stats">
      {stats.note ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={stats.note} /> : null}
      <Descriptions size="small" bordered column={{ xs: 2, md: 4 }} style={{ marginBottom: 12 }}>
        <Descriptions.Item label="待处理机会">
          <span className="erp-num">{stats.pendingOpportunities}</span>
        </Descriptions.Item>
        {CASE_STATUSES.map(status => (
          <Descriptions.Item key={status} label={`案件·${CASE_STATUS_LABEL[status]}`}>
            <span className="erp-num">{stats.caseCounts[status]}</span>
          </Descriptions.Item>
        ))}
        <Descriptions.Item label="平均到账时长">
          {stats.avgPayDays === null ? <Muted>尚无已到账案件</Muted> : <span className="erp-num">{`${stats.avgPayDays} 天（${stats.paidSample} 个案件）`}</span>}
        </Descriptions.Item>
      </Descriptions>
      <Typography.Title level={5}>回收率（按币种）</Typography.Title>
      <SimpleGrid<CurrencyRecovery>
        gridId="reimbursements.stats-panel"
        columns={recoveryColumns}
        rows={stats.recovery}
        rowKey={row => row.currency}
        emptyState={{ kind: 'empty', domain: '回收率', prerequisite: '还没有已提交且填了应收金额的案件，提交案件并填写应收金额后才能计算回收率。' }}
      />
      {stats.unmatched.count > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 8 }}
          message={`有 ${stats.unmatched.count} 笔官方赔付明细没有对应案件（${stats.unmatched.byCurrency.map(item => `${item.currency} ${item.amount}`).join('、')}）`}
          description="亚马逊已经赔付，但系统找不到对应的案件：可能是在卖家后台直接申请的。给案件回填亚马逊案件编号后会在下一次匹配时自动归属。"
        />
      ) : null}
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        各类机会的成功率
      </Typography.Title>
      <SimpleGrid<RuleStat>
        gridId="reimbursements.rule-stats"
        columns={ruleColumns}
        rows={stats.rules}
        rowKey={row => row.ruleCode}
        emptyState={{ kind: 'empty', domain: '成功率', prerequisite: '' }}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
        {stats.basis}
      </Typography.Paragraph>
    </div>
  )
}
