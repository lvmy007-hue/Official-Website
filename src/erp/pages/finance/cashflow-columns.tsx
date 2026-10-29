import { Tag } from 'antd'
import type { ReactNode } from 'react'
import type { BalanceRow, CashSourceView, CashflowPayoutStore, DisbursementMatchState, DisbursementRow, ForecastWeek } from '@nova/api-contracts'
import type { FunnelStage } from '@nova/api-contracts'
import { renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { count, money } from '../orders/orders-ui'
import { cash, dayText, signedCash, SourceTag } from './cashflow-ui'

// 回款与现金流各块的表格列（P6-28 第 6 批：由旧 antd 表迁到 LocalGrid）。口径与迁移前一致：金额不可用写“不可用”，没有记录写原因，不写 0。

type Cell<T> = (row: T) => ReactNode
const col = <T extends object>(title: string, key: string, width: number, render: Cell<T>, extra: ErpColDef<T> = {}) => renderColumn<T>(title, key, render, { width, sortable: false, ...extra })
const num = <T extends object>(title: string, key: string, width: number, render: Cell<T>, extra: ErpColDef<T> = {}) => col<T>(title, key, width, render, { ...RIGHT_ALIGNED, ...extra })

export const balanceColumns: ErpColDef<BalanceRow>[] = [
  col<BalanceRow>('店铺', 'storeName', 160, row => row.storeName),
  col<BalanceRow>('余额类型', 'label', 200, row => row.label),
  col<BalanceRow>('币种', 'currency', 80, row => row.currency),
  num<BalanceRow>('金额', 'amount', 140, row => money(row.amount, row.currency)),
  col<BalanceRow>('截至', 'asOf', 120, row => dayText(row.asOf)),
]

export type ScheduleLine = { key: string; label: string; amount: number; count: number }

export const scheduleColumns = (currency: string): ErpColDef<ScheduleLine>[] => [
  col<ScheduleLine>('预计释放', 'label', 240, row => row.label),
  num<ScheduleLine>('金额', 'amount', 140, row => money(row.amount, currency)),
  num<ScheduleLine>('笔数', 'count', 90, row => count(row.count)),
]

export const payoutColumns: ErpColDef<CashflowPayoutStore>[] = [
  col<CashflowPayoutStore>('店铺', 'storeName', 140, row => row.storeName, { pin: 'left' }),
  col<CashflowPayoutStore>('结算周期', 'cycle', 170, row =>
    row.cycleDays === null ? (
      <Muted>无法推断</Muted>
    ) : (
      <span className="erp-num">
        每 {row.cycleDays} 天，打款晚 {row.lagDays} 天
      </span>
    ),
  ),
  col<CashflowPayoutStore>('最近周期结束', 'lastPeriodEnd', 130, row => dayText(row.lastPeriodEnd)),
  col<CashflowPayoutStore>('已公布的打款', 'published', 240, row =>
    row.published.length === 0 ? (
      <Muted>没有待到账的结算单</Muted>
    ) : (
      <span className="erp-cell-stack">
        {row.published.map(item => (
          <span key={item.settlementId}>
            {dayText(item.depositDate)} {money(item.amount, item.currency)}
          </span>
        ))}
      </span>
    ),
  ),
  col<CashflowPayoutStore>('预计打款（模型估算）', 'predicted', 320, row =>
    row.predicted.length === 0 ? (
      <Muted>{row.reason ?? '预测范围内没有预计打款'}</Muted>
    ) : (
      <span className="erp-cell-stack">
        {row.predicted.map(item => (
          <span key={item.depositDate}>
            {dayText(item.depositDate)} {cash(item.estimated, row.currency)}
            {item.deferredAmount > 0 ? <Muted>（含递延释放 {item.deferredAmount}）</Muted> : null}
          </span>
        ))}
        {row.reason ? <Muted>{row.reason}</Muted> : null}
      </span>
    ),
  ),
]

export const forecastColumns = (currency: string): ErpColDef<ForecastWeek>[] => [
  col<ForecastWeek>(
    '第几周',
    'week',
    200,
    row => (
      <span className="erp-num">
        第 {row.index + 1} 周 {row.from} ~ {row.to}
      </span>
    ),
    { pin: 'left' },
  ),
  num<ForecastWeek>('已公布打款', 'publishedInflow', 120, row => cash(row.publishedInflow, currency)),
  num<ForecastWeek>('预计打款', 'estimatedInflow', 120, row => cash(row.estimatedInflow, currency)),
  num<ForecastWeek>('采购付款', 'purchaseOutflow', 120, row => cash(row.purchaseOutflow, currency)),
  num<ForecastWeek>('头程付款', 'firstMileOutflow', 120, row => cash(row.firstMileOutflow, currency)),
  num<ForecastWeek>('广告扣款', 'adsOutflow', 120, row => cash(row.adsOutflow, currency)),
  num<ForecastWeek>('本周净额', 'net', 260, row => (
    <span className="erp-cell-stack" style={{ alignItems: 'flex-end' }}>
      {signedCash(row.net, currency)}
      {row.missing.length > 0 ? <Muted>不含：{row.missing.join('、')}</Muted> : null}
    </span>
  )),
  num<ForecastWeek>('累计净额', 'cumulative', 130, row => signedCash(row.cumulative, currency)),
]

export const sourceColumns: ErpColDef<CashSourceView>[] = [
  col<CashSourceView>('来源', 'label', 130, row => row.label),
  col<CashSourceView>('状态', 'state', 100, row => <SourceTag state={row.state} />),
  col<CashSourceView>('说明', 'note', 520, row => row.note),
]

export const stageColumns = (currency: string): ErpColDef<FunnelStage>[] => [
  col<FunnelStage>('环节', 'label', 240, row => <span title={row.note}>{row.label}</span>),
  num<FunnelStage>('金额', 'amount', 160, row => (row.amount === null ? <Muted>尚未接入</Muted> : money(row.amount, currency))),
  num<FunnelStage>('笔数', 'count', 90, row => (row.amount === null ? <Muted>—</Muted> : count(row.count))),
  col<FunnelStage>('说明', 'note', 520, row => <Muted>{row.note}</Muted>),
]

const STATE_COLOR: Record<DisbursementMatchState, string> = {
  MATCHED: 'success',
  SHORT: 'error',
  OVER: 'warning',
  CURRENCY_DIFFERENT: 'warning',
  PENDING_DEPOSIT: 'default',
  AWAITING: 'processing',
  UNREGISTERED: 'error',
  NO_DEPOSIT_DATE: 'default',
}

/** 到账核对列；操作列由页面传入渲染函数（登记弹窗在页面里，列定义保持稳定）。 */
export const disbursementColumns = (renderAction: (row: DisbursementRow) => ReactNode): ErpColDef<DisbursementRow>[] => [
  col<DisbursementRow>(
    '结算单',
    'settlement',
    190,
    row => (
      <span className="erp-cell-stack">
        <AppLink to={`/app/settlements/${encodeURIComponent(row.settlementId)}`}>{row.externalSettlementId}</AppLink>
        <span className="erp-cell-sub">{row.storeName}</span>
      </span>
    ),
    { pin: 'left' },
  ),
  col<DisbursementRow>('周期结束', 'periodEnd', 110, row => dayText(row.periodEnd)),
  col<DisbursementRow>('报告打款日', 'expectedDate', 110, row => dayText(row.expectedDate)),
  num<DisbursementRow>('报告打款额', 'expectedAmount', 120, row => money(row.expectedAmount, row.currency)),
  col<DisbursementRow>('已登记到账', 'registered', 240, row =>
    row.registered ? (
      <span className="erp-cell-stack">
        <span>
          {dayText(row.registered.disbursedAt)} {money(row.registered.amount, row.registered.currency)}
        </span>
        <span className="erp-cell-sub">
          {row.registered.bankLast4 ? `账户末四位 ${row.registered.bankLast4} · ` : ''}登记人 {row.registered.createdBy}
        </span>
      </span>
    ) : (
      <Muted>尚未登记</Muted>
    ),
  ),
  col<DisbursementRow>('核对结果', 'state', 230, row => (
    <span className="erp-cell-stack">
      <span>
        <Tag color={STATE_COLOR[row.state]} bordered={false} style={{ marginInlineEnd: 0 }}>
          {row.stateLabel}
        </Tag>
      </span>
      {row.diff !== null && row.diff !== 0 ? <span className="erp-cell-sub">差额（登记 − 报告）{money(row.diff, row.currency)}</span> : null}
    </span>
  )),
  col<DisbursementRow>('操作', 'actions', 120, renderAction, { pin: 'right' }),
]
