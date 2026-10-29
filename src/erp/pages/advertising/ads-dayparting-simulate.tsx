import { useState, type ReactNode } from 'react'
import { Alert, Button, Modal, Tag } from 'antd'
import { DAYPARTING_SIM_MODEL, type DaypartingSimulateResponse, type DaypartingStrategyRow, type DaypartingTotals } from '@nova/api-contracts'
import { describeError } from '../../query/errors'
import { useApiMutation } from '../../query/api-query'
import { moneyCell, numberCell, percentCell } from './ads-campaigns-ui'
import { StateNote } from './ads-ui'
import { SimpleGrid } from '../../components'

// 策略效果模拟（P3-12）：用作用对象最近 14 天的小时指标估算“如果当时就按这个策略跑”的差别。只读，不改任何数据；
// 结果是模型估算，不是亚马逊的预测，模型假设随结果一起列出。没有历史（数据流没接入、对象没有小时指标）写原因，不画估算数字。

type Line = { key: string; label: string; baseline: ReactNode; estimated: ReactNode }

const lines = (baseline: DaypartingTotals, estimated: DaypartingTotals): Line[] => [
  { key: 'spend', label: '花费', baseline: moneyCell(baseline.spend), estimated: moneyCell(estimated.spend) },
  { key: 'sales', label: '广告销售额', baseline: moneyCell(baseline.sales), estimated: moneyCell(estimated.sales) },
  { key: 'orders', label: '订单', baseline: numberCell(baseline.orders), estimated: numberCell(estimated.orders) },
  { key: 'clicks', label: '点击', baseline: numberCell(baseline.clicks), estimated: numberCell(estimated.clicks) },
  { key: 'acos', label: '广告成本销售比', baseline: percentCell(baseline.acos), estimated: percentCell(estimated.acos) },
  { key: 'cpc', label: '单次点击成本', baseline: moneyCell(baseline.cpc), estimated: moneyCell(estimated.cpc) },
]

export function SimulateButton({ strategy }: { strategy: DaypartingStrategyRow }) {
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<DaypartingSimulateResponse | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const mutation = useApiMutation<void, DaypartingSimulateResponse>({ method: 'POST', path: `/ads/dayparting/${strategy.id}/simulate`, body: () => undefined, silent: true })
  const start = () => {
    setOpen(true)
    setResult(null)
    setFailure(null)
    mutation.mutate(undefined, {
      onSuccess: data => setResult(data),
      onError: error => setFailure(describeError(error).message),
    })
  }
  return (
    <>
      <Button type="link" size="small" onClick={start}>
        模拟效果
      </Button>
      <Modal open={open} title={`效果模拟：${strategy.name}`} footer={null} onCancel={() => setOpen(false)} width={640} destroyOnHidden>
        {failure ? <Alert type="error" showIcon message={failure} /> : null}
        {!result && !failure ? <div>正在估算…</div> : null}
        {result ? (
          <div data-testid="dayparting-simulation">
            <Tag color="orange" bordered={false}>
              模型估算，不是亚马逊的预测
            </Tag>
            {result.state !== 'OK' ? (
              <div style={{ marginTop: 8 }}>
                <StateNote state={result.state} note={result.note} />
              </div>
            ) : (
              <>
                <p style={{ margin: '8px 0' }}>
                  最近 {result.historyDays} 天里有 {result.coveredCells} 个小时格有数据，策略改动了其中的 {result.changedCells} 格取值（共 168 格）。
                  {result.note ? ` ${result.note}。` : ''}
                </p>
                {result.baseline && result.estimated ? (
                  <SimpleGrid<Line>
                    gridId="advertising.ads-dayparting-simulate"
                    columns={[
                      { title: '指标', dataIndex: 'label', width: 140 },
                      { title: '历史实际', dataIndex: 'baseline', align: 'right' },
                      { title: '按策略估算', dataIndex: 'estimated', align: 'right' },
                    ]}
                    rows={lines(result.baseline, result.estimated)}
                    rowKey={row => row.key}
                    emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
                  />
                ) : null}
              </>
            )}
            <div style={{ marginTop: 12, fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
              <div>模型参数：点击量随系数的 {DAYPARTING_SIM_MODEL.clickElasticity} 次方变化，单次点击成本随系数变化。</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {result.assumptions.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  )
}
