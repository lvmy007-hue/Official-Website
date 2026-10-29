import { useMemo } from 'react'
import { Alert, Card } from 'antd'
import type { CashSourceView, CashflowForecastView, ForecastWeek } from '@nova/api-contracts'
import { LocalGrid } from '../../components'
import { Muted } from '../inventory/inventory-ui'
import { forecastColumns, sourceColumns } from './cashflow-columns'

// 按周现金流预测（P2b-08，07 章 7.8）：入账 = 已公布的打款 + 模型预计的打款；出账 = 采购付款计划 + 头程费用 + 广告扣款（按日均）。
// 每一列都标明来源与口径；来源不可用（没权限、不适用、尚未接入）时该列显示“不可用”并写在“不含”里，净额只加上可用的部分。
// 累计净额不含期初余额：官方没有可用余额，不能拿递延余额当期初。

export function ForecastSection({ forecast, noData = false }: { forecast: CashflowForecastView; noData?: boolean }) {
  const { currency } = forecast
  const columns = useMemo(() => forecastColumns(currency), [currency])
  // 没有任何回款数据时逐周的 0 元没有意义（不是“预测为零”，而是无从预测）：不画表，只写原因
  if (noData) {
    return (
      <Card size="small" title="按周现金流预测" style={{ marginTop: 16 }} data-testid="cashflow-forecast">
        <Muted>尚无回款数据，无法预测；店铺授权并同步财务数据与结算报告后显示。</Muted>
      </Card>
    )
  }
  return (
    <Card size="small" title={`按周现金流预测（${currency}，未来 ${forecast.weeks.length} 周）`} style={{ marginTop: 16 }} data-testid="cashflow-forecast">
      <LocalGrid<ForecastWeek>
        gridId="finance.cashflow.forecast"
        columns={columns}
        rows={forecast.weeks}
        getRowId={row => String(row.index)}
        height={480}
        emptyState={{ kind: 'empty', domain: '现金流预测', prerequisite: '没有可用的预测数据。' }}
      />
      <p style={{ margin: '8px 0 4px', fontWeight: 500 }}>各列的数据来源</p>
      <LocalGrid<CashSourceView>
        gridId="finance.cashflow.sources"
        columns={sourceColumns}
        rows={forecast.sources}
        getRowId={row => row.label}
        height={260}
        emptyState={{ kind: 'empty', domain: '数据来源', prerequisite: '没有来源信息。' }}
      />
      {forecast.excluded.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 8 }}
          message="有付款因币种不同没有计入（本页不做汇率换算）"
          description={forecast.excluded.map(item => `${item.label}：${item.count} 笔（${item.currencies.join('、')}）`).join('；')}
        />
      ) : null}
      {forecast.undated.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 8 }}
          message="有付款没有计划日期，排不进任何一周"
          description={`${forecast.undated.map(item => `${item.label}：${item.count} 笔`).join('；')}；在采购订单与头程里补上计划日期后会计入。`}
        />
      ) : null}
      <ul style={{ margin: '8px 0 0', paddingInlineStart: 18, color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>
        {forecast.assumptions.map(item => (
          <li key={item}>{item}</li>
        ))}
        <li>预测模型：{forecast.modelVersion}（每次打开页面现算，不保存历史预测）。</li>
      </ul>
    </Card>
  )
}
