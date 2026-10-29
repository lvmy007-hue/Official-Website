import { useMemo, useState } from 'react'
import { Card, Segmented, Space } from 'antd'
import type { EChartsOption } from 'echarts'
import { FX_CURVE_DEFAULT_DAYS } from '@nova/api-contracts'
import { ActionGuard, ChartPanel, FormAction, PageHeader, SimpleGrid } from '../../components'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { CurrencyFields, OverrideFields, OverrideTable, SourceCards, SourceFields, WRITE, latestColumns, type FxOverview } from './fx-parts'

// 汇率（P1-28-2，09 章 9.14）：以美元为基准，保存每日汇率、来源与手工覆盖。
// - 主源与备源由后台每 6 小时获取；两个来源都失败时不编造汇率，利润等计算沿用最近一天的汇率（最多 10 天），页面标注“沿用”；
// - 手工覆盖与调整来源要写原因并再次验证身份，写入审计；已被关账锁定的日期不能改；
// - 附加币种供采购、费用使用；立即获取交给后台任务，结果在刷新后看到。

const PATH = '/settings/fx'
const DAY_OPTIONS = [30, FX_CURVE_DEFAULT_DAYS, 365].map(value => ({ value, label: `${value} 天` }))

export default function FxSettingsPage() {
  const [quote, setQuote] = useState<string | undefined>()
  const [days, setDays] = useState<number>(FX_CURVE_DEFAULT_DAYS)
  const query = useApiQuery<FxOverview>({ domain: 'config', path: PATH, scoped: false, params: { quote, days } })
  const overview = query.data
  const post = useApiMutation<{ path: string; body: unknown }, unknown>({ method: 'POST', path: v => v.path, body: v => v.body, invalidate: ['config'], silent: true })
  const remove = useApiMutation<string, unknown>({ method: 'DELETE', path: id => `${PATH}/overrides/${encodeURIComponent(id)}`, body: () => undefined, invalidate: ['config'], silent: true })
  const refresh = () => void query.refetch()

  const providerLabel = useMemo(() => {
    const map = new Map((overview?.providers ?? []).map(item => [item.key, item.label]))
    return (key: string | null) => (key ? (map.get(key) ?? key) : '—')
  }, [overview])

  const option = useMemo<EChartsOption>(
    () => ({
      grid: { left: 48, right: 16, top: 24, bottom: 28 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: overview?.curve.map(point => point.date) ?? [] },
      yAxis: { type: 'value', scale: true },
      series: [{ type: 'line', name: `1 美元折合 ${overview?.quote ?? ''}`, showSymbol: false, data: overview?.curve.map(point => point.rate) ?? [] }],
    }),
    [overview],
  )

  const actions = overview ? (
    <>
      <ActionGuard label="立即获取" guard={{ permission: WRITE }} onExecute={() => post.mutateAsync({ path: `${PATH}/refresh`, body: {} })} successText="已提交获取任务，稍后刷新页面查看结果" />
      <FormAction
        label="手工覆盖汇率"
        guard={{ permission: WRITE }}
        title="手工覆盖某一天的汇率"
        description="覆盖优先于系统获取的汇率，用于来源当天缺失或明显异常时；每次覆盖都会写入审计。"
        reason={{ label: '覆盖原因', placeholder: '例如：来源当天返回异常，按银行实际结汇价调整' }}
        stepUp="fx.write"
        initialValues={{ quoteCurrency: overview.quote }}
        onSubmit={values => post.mutateAsync({ path: PATH, body: { kind: 'override', quoteCurrency: values.quoteCurrency, rateDate: values.rateDate, rate: values.rate, reason: values.reason } })}
        successText="已覆盖该日汇率"
        onDone={refresh}
      >
        <OverrideFields currencies={overview.currencies} />
      </FormAction>
      <FormAction
        label="调整来源"
        guard={{ permission: WRITE }}
        title="选择汇率来源"
        reason={{ label: '调整原因' }}
        stepUp="fx.write"
        initialValues={{ primary: overview.sources.find(item => item.role === 'PRIMARY')?.provider, backup: overview.sources.find(item => item.role === 'BACKUP')?.provider }}
        onSubmit={values => post.mutateAsync({ path: PATH, body: { kind: 'source', primary: { provider: values.primary }, backup: { provider: values.backup }, reason: values.reason } })}
        successText="已调整汇率来源"
        onDone={refresh}
      >
        <SourceFields providers={overview.providers} />
      </FormAction>
      <FormAction
        label="管理币种"
        guard={{ permission: WRITE }}
        title="管理附加币种"
        reason={{ label: '调整原因' }}
        initialValues={{ currencies: overview.extraCurrencies }}
        onSubmit={values => post.mutateAsync({ path: `${PATH}/currencies`, body: { currencies: (values.currencies as string[]).map(item => item.trim().toUpperCase()), reason: values.reason } })}
        successText="已更新附加币种"
        onDone={refresh}
      >
        <CurrencyFields />
      </FormAction>
    </>
  ) : null

  return (
    <div>
      <PageHeader title="汇率" description="以美元为基准的每日汇率。系统每 6 小时自动获取；获取失败时沿用最近一天的汇率并标注，不会编造。" actions={actions} />
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card size="small" title="各币种最新汇率">
          <SimpleGrid
            gridId="settings.fx-settings-page"
            columns={latestColumns(providerLabel)}
            rows={overview?.latest}
            rowKey={row => row.currency}
            loading={query.isPending}
            error={query.error}
            onRetry={refresh}
            emptyState={{ kind: 'empty', domain: '汇率', prerequisite: '尚未获取到汇率；后台任务会自动获取，也可以点击“立即获取”。' }}
          />
        </Card>
        {overview ? (
          <>
            <ChartPanel
              title={`美元 → ${overview.quote} 汇率曲线`}
              ariaLabel={`美元兑${overview.quote}最近 ${overview.days} 天汇率曲线`}
              option={option}
              emptyState={overview.curve.length === 0 ? { kind: 'empty', domain: '汇率曲线', prerequisite: '该币种在所选时间内还没有汇率记录。' } : undefined}
              extra={
                <Space>
                  <Segmented value={overview.quote} onChange={value => setQuote(String(value))} options={overview.currencies} />
                  <Segmented value={days} onChange={value => setDays(Number(value))} options={DAY_OPTIONS} />
                </Space>
              }
            />
            <Card size="small" title="汇率来源与最近获取状态">
              <SourceCards sources={overview.sources} />
            </Card>
            <Card size="small" title="手工覆盖记录">
              <OverrideTable overview={overview} onRemove={id => remove.mutateAsync(id)} onDone={refresh} />
            </Card>
          </>
        ) : null}
      </Space>
    </div>
  )
}
