import { useMemo } from 'react'
import { Alert, Card, Tabs } from 'antd'
import { SNS_DAY_RETENTION_DAYS, type SnsOverviewResponse } from '@nova/api-contracts'
import { ChartPanel, DataState, FreshnessBar, PageHeader, stateFromError } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { buildDailyOption, buildMonthlyOption } from './subscribe-save-options'
import { AsinTab, OfferTab } from './subscribe-save-tabs'
import { Cards, SyncNotice } from './subscribe-save-ui'

// 订阅省（P4-06，04 章 4.9）：亚马逊补货接口里的订阅与优惠数据，只读同步（约每 6 小时）。
// 指标卡与趋势来自卖家整体的日级（最近 31 天）与月度指标；预计订阅出货来自每个店铺最近一次报价快照，同样的数字已叠加进补货建议。
// 没有数据时写原因：没开通 / 接口角色没批 / 尚未同步 / 尚无记录；取消数尚未接入。订阅省的报价与折扣在卖家后台设置，系统不写亚马逊。

function Overview({ data }: { data: SnsOverviewResponse }) {
  const daily = useMemo(() => buildDailyOption(data.trend.points, data.trend.currency), [data.trend.points, data.trend.currency])
  const monthly = useMemo(() => buildMonthlyOption(data.trend.months, data.trend.currency), [data.trend.months, data.trend.currency])
  const { forecast, trend } = data
  const dailyEmpty = trend.coverage.dataDays === 0
  return (
    <>
      <p style={{ margin: '4px 0 8px', color: 'rgba(0,0,0,0.65)' }} data-testid="sns-range">
        统计范围 <span className="erp-num">{data.range.from}</span> ~ <span className="erp-num">{data.range.to}</span>，共 {data.range.days} 天
        {data.compare ? `；对比期 ${data.compare.from} ~ ${data.compare.to}` : '；没有选对比期（在顶部范围栏选择环比、同比或自定义）'}。
      </p>
      {trend.coverage.dataDays < trend.coverage.rangeDays ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 8 }}
          message={`范围内 ${trend.coverage.rangeDays} 天里只有 ${trend.coverage.dataDays} 天有日级记录`}
          description={`亚马逊只提供最近 ${SNS_DAY_RETENTION_DAYS} 天的按天指标，更早的日期没有记录，合计与图里不含这些日期，也不会补成 0。`}
          data-testid="sns-coverage"
        />
      ) : null}
      {data.truncated ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message="数据量超过读取上限，合计与趋势只含已读到的部分"
          description="请缩小日期范围或选择店铺后再看。"
          data-testid="sns-truncated"
        />
      ) : null}
      {forecast.staleStores.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message={`${forecast.staleStores.join('、')} 的报价快照已超过 7 天`}
          description="这些店铺不计入预计订阅出货，也不会用于补货建议；同步恢复后会更新。"
          data-testid="sns-stale"
        />
      ) : null}
      <Cards cards={data.cards} compared={data.compare !== null} />
      <p style={{ margin: '0 0 8px' }} data-testid="sns-forecast-basis">
        <Muted>
          预计出货依据：报价快照 {forecast.snapshotDate ?? '尚无记录'}，共 {forecast.offers} 条报价，其中 {forecast.offersWithForecast} 条有预测，{forecast.usedInReplenishment} 条已用于补货建议。
          {data.replenishNote}
        </Muted>{' '}
        <LiveLink component="ReplenishmentPage" id="">
          查看补货建议
        </LiveLink>
      </p>
      <ChartPanel
        title="逐日趋势"
        ariaLabel="订阅出货、活跃订阅数与订阅销售额逐日趋势图"
        option={daily}
        height={280}
        emptyState={dailyEmpty ? { kind: 'empty', domain: '订阅省逐日趋势', prerequisite: '所选范围内尚无日级记录' } : undefined}
      />
      <ChartPanel
        title="月度对照"
        ariaLabel="订阅出货与订阅销售额月度对照图"
        option={monthly}
        height={240}
        emptyState={trend.months.length === 0 ? { kind: 'empty', domain: '订阅省月度对照', prerequisite: '尚无月度记录' } : undefined}
      />
    </>
  )
}

const STATE_ALERT: Record<Exclude<SnsOverviewResponse['state'], 'OK'>, { type: 'warning' | 'info'; title: string; testId: string }> = {
  ROLE_PENDING: { type: 'warning', title: '订阅省同步未授权', testId: 'sns-role-pending' },
  NOT_APPLICABLE: { type: 'info', title: '没有开通订阅省', testId: 'sns-not-applicable' },
  NOT_CONNECTED: { type: 'info', title: '订阅省尚未同步', testId: 'sns-not-connected' },
  NO_DATA: { type: 'info', title: '尚无记录', testId: 'sns-no-data' },
}

export default function SubscribeSavePage() {
  const query = useApiQuery<SnsOverviewResponse>({ domain: 'analytics', path: '/subscribe-save' })
  const data = query.data
  const alert = data && data.state !== 'OK' ? STATE_ALERT[data.state] : null
  return (
    <div>
      <PageHeader
        title="订阅省"
        description="亚马逊订阅省（Subscribe & Save）的订阅、出货、销售额与未来预计出货，只读同步（约每 6 小时）。报价与折扣请在卖家后台设置；这里用来看趋势，并核对补货建议用到的预计订阅出货。"
      />
      <Card size="small" style={{ marginBottom: 12 }}>
        <FreshnessBar freshness={data?.freshness} />
        {query.error ? (
          <DataState {...stateFromError(describeError(query.error), { permission: 'analytics.read', onRetry: () => void query.refetch() })} />
        ) : !data ? (
          <DataState kind="skeleton" rows={5} />
        ) : (
          <>
            <SyncNotice sync={data.sync} />
            {alert ? <Alert type={alert.type} showIcon style={{ marginBottom: 12 }} message={alert.title} description={data.note ?? undefined} data-testid={alert.testId} /> : <Overview data={data} />}
            <p style={{ margin: '8px 0 0' }} data-testid="sns-basis">
              <Muted>口径：{data.basis}</Muted>
            </p>
          </>
        )}
      </Card>
      <Card size="small">
        <Tabs
          items={[
            { key: 'asins', label: 'ASIN 明细', children: <AsinTab /> },
            { key: 'offers', label: '报价参与列表', children: <OfferTab /> },
          ]}
        />
      </Card>
    </div>
  )
}
