import { useMemo } from 'react'
import { Alert, Card, Space } from 'antd'
import { CASHFLOW_RUN_RATE_DAYS, type BalanceRow, type CashflowBalances, type CashflowDeferral, type CashflowPayout, type CashflowPayoutStore } from '@nova/api-contracts'
import { LocalGrid } from '../../components'
import { Muted } from '../inventory/inventory-ui'
import { money } from '../orders/orders-ui'
import { balanceColumns, payoutColumns, scheduleColumns, type ScheduleLine } from './cashflow-columns'

// 回款与现金流的前三块（P2b-08，07 章 7.8）：账户余额、递延与释放、打款预测。
// 余额只有“递延余额”：官方没有通用的账户余额接口，可用余额与下次打款额取不到，页面明说，不拿别的数凑。

export function BalancesSection({ balances }: { balances: CashflowBalances }) {
  return (
    <Card size="small" title="账户余额" style={{ marginTop: 16 }} data-testid="cashflow-balances">
      <LocalGrid<BalanceRow>
        gridId="finance.cashflow.balances"
        columns={balanceColumns}
        rows={balances.items}
        getRowId={row => `${row.sellerAccountId}|${row.accountType}|${row.currency}`}
        height={260}
        emptyState={{ kind: 'empty', domain: '递延余额', prerequisite: '尚无递延余额记录：店铺授权并同步财务数据后显示。' }}
      />
      {balances.totals.length > 0 ? (
        <p style={{ margin: '8px 0 0' }}>
          合计（不同币种分别列示，不相加）：
          {balances.totals.map((item, index) => (
            <span key={item.currency}>
              {index > 0 ? '；' : ''}
              {money(item.amount, item.currency)}
            </span>
          ))}
        </p>
      ) : null}
      {balances.unavailable.map(item => (
        <Alert key={item.label} type="info" showIcon style={{ marginTop: 8 }} message={`${item.label}：不可用`} description={item.note} />
      ))}
    </Card>
  )
}

export function DeferralSection({ deferral, currency }: { deferral: CashflowDeferral; currency: string }) {
  const schedule = deferral.schedule
  const columns = useMemo(() => scheduleColumns(currency), [currency])
  const lines: ScheduleLine[] = schedule
    ? [
        { key: 'overdue', label: '已过预计释放日（待释放）', ...schedule.overdue },
        ...schedule.weeks.map((week, index) => ({ key: `w${index}`, label: `${week.from} ~ ${week.to}`, amount: week.amount, count: week.count })),
        { key: 'later', label: '更晚', ...schedule.later },
        { key: 'unknown', label: '接口没给预计释放日', ...schedule.unknown },
      ]
    : []
  return (
    <Card size="small" title="递延与释放" style={{ marginTop: 16 }} data-testid="cashflow-deferral">
      {deferral.totals.length === 0 ? (
        <Muted>最近没有递延中的交易。</Muted>
      ) : (
        <Space direction="vertical" size={2} style={{ marginBottom: 8 }}>
          {deferral.totals.map(item => (
            <span key={item.currency}>
              递延中 {money(item.amount, item.currency)}，共 <span className="erp-num">{item.count}</span> 笔，其中 <span className="erp-num">{item.withMaturity}</span> 笔有预计释放日
            </span>
          ))}
        </Space>
      )}
      {deferral.released.length > 0 ? (
        <p style={{ margin: '0 0 8px' }}>
          最近 {deferral.releasedDays} 天入账、现已释放：
          {deferral.released.map((item, index) => (
            <span key={item.currency}>
              {index > 0 ? '；' : ''}
              {money(item.amount, item.currency)}（<span className="erp-num">{item.count}</span> 笔）
            </span>
          ))}
        </p>
      ) : null}
      {schedule ? (
        <>
          <p style={{ margin: '0 0 4px', color: 'rgba(0,0,0,0.65)' }}>释放计划（{currency}，按接口给的预计释放日分周）：</p>
          <LocalGrid<ScheduleLine>
            gridId="finance.cashflow.schedule"
            columns={columns}
            rows={lines}
            getRowId={row => row.key}
            height={420}
            emptyState={{ kind: 'empty', domain: '释放计划', prerequisite: '没有递延中的交易。' }}
          />
        </>
      ) : null}
      <p style={{ margin: '8px 0 0', color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>{deferral.note}</p>
    </Card>
  )
}

export function PayoutSection({ payout, currency }: { payout: CashflowPayout; currency: string }) {
  const next = payout.next
  return (
    <Card size="small" title="打款预测" style={{ marginTop: 16 }} data-testid="cashflow-payout">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 8 }}
        message={
          next ? (
            <span data-testid="next-payout">
              下一次打款：{next.date}，{next.amount === null ? '金额不可用' : money(next.amount, currency)}（{next.kind === 'PUBLISHED' ? '结算单已公布' : '模型估算'}，{next.storeName}）
            </span>
          ) : (
            <span data-testid="next-payout">没有可预测的下一次打款：结算单历史不足，或这个币种下没有待到账的结算单。</span>
          )
        }
        description={
          payout.dailyRate === null ? (
            '最近没有已释放的交易，无法算日均净入账。'
          ) : (
            <>
              近期日均净入账约 {money(payout.dailyRate, currency)}（最近 {CASHFLOW_RUN_RATE_DAYS} 天已释放交易，不含打款本身）。
            </>
          )
        }
      />
      <LocalGrid<CashflowPayoutStore>
        gridId="finance.cashflow.payout"
        columns={payoutColumns}
        rows={payout.stores}
        getRowId={row => row.sellerAccountId}
        height={320}
        emptyState={{ kind: 'empty', domain: '打款预测', prerequisite: `范围内没有${currency}的结算单，无法预测打款。` }}
      />
      <p style={{ margin: '8px 0 0', color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>{payout.basis}</p>
    </Card>
  )
}
