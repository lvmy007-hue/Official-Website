import { useMemo } from 'react'
import { Alert, Button, Space, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { AdsBudgetAdvice, AdsBudgetRuleView, AdsPortfolioCampaignShare, AdsPortfolioDetailResponse } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { ErpChart } from '../../components/chart/ErpChart'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { EntityStateTag, moneyCell, NONE, percentCell } from './ads-campaigns-ui'
import { paceChartOption } from './ads-portfolios-options'

// 广告组合详情的三个页签（P3-11，08 章 8.8）：预算节奏（曲线、调整建议、口径）、活动预算分配、预算规则（测试版，功能开关）。

function AdviceBlock({ advice, note, write }: { advice: AdsBudgetAdvice | null; note: string | null; write: AdsPortfolioDetailResponse['write'] }) {
  if (!advice) return <Alert type="info" showIcon message={note ?? '没有调整建议'} />
  const warn = advice.kind === 'CAP_REACHED' || advice.kind === 'EXHAUST_EARLY'
  return (
    <Alert
      type={warn ? 'warning' : 'info'}
      showIcon
      data-testid="portfolio-advice"
      message={advice.text}
      description={
        <Space size={[16, 4]} wrap>
          <span>剩余 {advice.remainingDays} 天</span>
          <span>剩余预算 {moneyCell(advice.remainingBudget)}</span>
          <span>每天最多 {moneyCell(advice.sustainableDaily)}</span>
          <span>启用中日预算合计 {moneyCell(advice.currentDailyBudget)}</span>
          <span>近几天日均花费 {moneyCell(advice.recentDaily)}</span>
          {advice.exhaustDate ? <span>预计 {advice.exhaustDate} 前后用完</span> : null}
          <Tooltip title={write.note}>
            <span>
              <Button size="small" disabled>
                按建议调整日预算
              </Button>
            </span>
          </Tooltip>
        </Space>
      }
    />
  )
}

export function PaceTab({ detail }: { detail: AdsPortfolioDetailResponse }) {
  const { row, curve } = detail
  const option = useMemo(() => paceChartOption(curve, row.budget.cap, detail.businessDate), [curve, row.budget.cap, detail.businessDate])
  const noActual = curve.length > 0 && curve.every(point => point.actual === null)
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <AdviceBlock advice={detail.advice} note={detail.adviceNote} write={detail.write} />
      {curve.length === 0 ? (
        <Alert type="info" showIcon message={row.budget.issue ?? row.pace.note ?? '没有预算周期，无法画预算节奏'} />
      ) : (
        <>
          {row.pace.state === 'OK' && row.pace.note ? <Alert type="info" showIcon message={row.pace.note} /> : null}
          {row.budget.cap === null ? <Alert type="info" showIcon message="这个组合没有设置预算上限，只画实际累计，没有理想线" /> : null}
          {noActual ? <Alert type="info" showIcon message="没有这个组合下活动的逐日花费汇总，实际累计线没有画（不是 0）；列表里的已用金额是亚马逊同步来的数" /> : null}
          <ErpChart option={option} height={320} ariaLabel="预算节奏：理想累计与实际累计" />
        </>
      )}
      <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12 }} data-testid="portfolio-basis">
        {detail.paceBasis}
      </div>
    </Space>
  )
}

const allocationColumns = (): ColumnsType<AdsPortfolioCampaignShare> => [
  {
    title: '活动',
    key: 'name',
    width: 260,
    render: (_value, item) => (
      <div>
        <AppLink to={`/app/advertising/campaigns/${encodeURIComponent(item.id)}`}>{item.name}</AppLink>
        <div style={{ fontSize: 12 }}>
          <Muted>{item.productLabel}</Muted>
        </div>
      </div>
    ),
  },
  { title: '状态', key: 'state', width: 90, render: (_value, item) => <EntityStateTag state={item.state} /> },
  {
    title: '日预算',
    key: 'budget',
    width: 130,
    align: 'right',
    render: (_value, item) =>
      item.budget === null ? (
        NONE
      ) : (
        <span>
          {moneyCell(item.budget, item.currency)}
          {item.budgetType && item.budgetType !== 'DAILY' ? <Muted>（{item.budgetType === 'LIFETIME' ? '总预算' : item.budgetType}）</Muted> : null}
        </span>
      ),
  },
  { title: '日预算占比', key: 'budgetShare', width: 110, align: 'right', render: (_value, item) => percentCell(item.budgetShare) },
  {
    title: '周期内花费',
    key: 'spend',
    width: 120,
    align: 'right',
    render: (_value, item) =>
      item.spend === null && item.currency !== 'USD' ? (
        <Tooltip title="广告日汇总只含美元，非美元活动不折算">
          <span>
            <Muted>非美元不折算</Muted>
          </span>
        </Tooltip>
      ) : (
        moneyCell(item.spend)
      ),
  },
  { title: '花费占比', key: 'spendShare', width: 100, align: 'right', render: (_value, item) => percentCell(item.spendShare) },
]

export function AllocationTab({ detail }: { detail: AdsPortfolioDetailResponse }) {
  const { allocation } = detail
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {allocation.period ? (
        <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12 }} data-testid="allocation-period">
          花费与占比统计 {allocation.period.from} 至 {allocation.period.to}（{allocation.period.basis === 'BUDGET_PERIOD' ? '预算周期内，截至昨天' : '预算周期未知，退回页面所选的日期范围'}
          ）；日预算占比只算启用中的美元按日预算活动。
        </div>
      ) : null}
      {allocation.truncated ? <Alert type="warning" showIcon message="活动数量或报表分组超过读取上限，只列出了一部分" /> : null}
      <SimpleGrid
        gridId="advertising.ads-portfolio-tabs"
        columns={allocationColumns()}
        rows={allocation.items}
        rowKey={item => item.id}
        emptyState={{ kind: 'empty', domain: '活动', prerequisite: allocation.note ?? '这个组合下还没有同步到活动' }}
      />
    </Space>
  )
}

const ruleColumns = (): ColumnsType<AdsBudgetRuleView> => [
  { title: '活动', key: 'campaign', width: 220, render: (_value, rule) => rule.campaignName ?? <span className="erp-num">{rule.campaignId}</span> },
  { title: '规则类型', key: 'ruleType', width: 140, render: (_value, rule) => <span className="erp-num">{rule.ruleType}</span> },
  { title: '状态', key: 'status', width: 100, render: (_value, rule) => rule.status },
  {
    title: '规则参数（接口原样返回）',
    key: 'params',
    render: (_value, rule) =>
      rule.params.length === 0 ? (
        NONE
      ) : (
        <div style={{ fontSize: 12 }}>
          {rule.params.map(param => (
            <div key={param.key}>
              <Muted>{param.key}：</Muted>
              {param.value}
            </div>
          ))}
        </div>
      ),
  },
  { title: '同步时间', key: 'syncedAt', width: 160, render: (_value, rule) => formatDateTime(rule.syncedAt) },
]

export function RulesTab({ detail }: { detail: AdsPortfolioDetailResponse }) {
  const { rules, write } = detail
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Alert
        type={rules.state === 'DISABLED' ? 'warning' : 'info'}
        showIcon
        data-testid="rules-state"
        message={rules.state === 'DISABLED' ? '预算规则（测试版）功能开关未打开' : '预算规则（测试版）'}
        description={rules.state === 'OK' ? '规则来自广告统一接口的测试版资源，接口可能无通知变更；这里只读，不解释参数含义。' : rules.note}
      />
      {rules.state === 'OK' ? (
        <SimpleGrid
          gridId="advertising.budget-rules"
          columns={ruleColumns()}
          rows={rules.items}
          rowKey={rule => rule.id}
          emptyState={{ kind: 'empty', domain: '预算规则', prerequisite: '没有预算规则记录' }}
        />
      ) : null}
      <Tooltip title={write.note}>
        <span>
          <Button disabled>新增预算规则</Button> <Button disabled>修改预算规则</Button>
        </span>
      </Tooltip>
    </Space>
  )
}
