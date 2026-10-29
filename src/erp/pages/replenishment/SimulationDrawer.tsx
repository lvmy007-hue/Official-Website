import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Descriptions, Drawer, Form, InputNumber, Space, Tabs, Typography } from 'antd'
import type { AwdSimulation, RecommendationRow, StockoutRange, TrendSimulation } from '@nova/api-contracts'
import { ChartPanel, DataState, stateFromError } from '../../components'
import { formatMoney } from '../../format'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { stockoutText, trendOption } from './simulation-chart'

// 模拟抽屉（两种）：
// 1. 90 天库存趋势：不补货 / 按建议补货 / 自定义补货三条曲线，列出断货区间；假设写在图下（在途按固定天数一次性到达等）。
// 2. 上游仓储（AWD）模拟：通过亚马逊数据中心的“经济模拟”估算发往上游仓储对销售、费用、净收入的影响。查询在亚马逊侧排队，这里每 5 秒查一次进度。
//    结果是官方估算，不是实际账单；该 SKU 没有资格使用上游仓储时返回 0 行，如实说明。

function Stockouts({ label, ranges }: { label: string; ranges: StockoutRange[] }) {
  if (ranges.length === 0) return <li>{label}：90 天内不断货</li>
  return (
    <li>
      {label}：
      {ranges.map(range => (
        <div key={range.from}>{stockoutText(range)}</div>
      ))}
    </li>
  )
}

function TrendPane({ row }: { row: RecommendationRow }) {
  const run = useApiMutation<Record<string, unknown>, TrendSimulation>({ method: 'POST', path: '/replenishment/simulate', silent: true })
  const [form] = Form.useForm()
  const start = (values: Record<string, unknown>) =>
    run.mutate({
      kind: 'TREND',
      sellerAccountId: row.sellerAccountId,
      sku: row.sku,
      ...(values.customQty ? { customQty: Number(values.customQty), customArriveInDays: Number(values.customArriveInDays ?? 14) } : {}),
      inboundArrivalDays: Number(values.inboundArrivalDays ?? 14),
    })
  useEffect(() => {
    start({ inboundArrivalDays: 14 })
    // 打开即按默认假设模拟一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id])
  const data = run.data
  const option = useMemo(() => (data && data.state === 'OK' ? trendOption(data.points) : null), [data])
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Form form={form} layout="inline" initialValues={{ inboundArrivalDays: 14 }} onFinish={start}>
        <Form.Item label="在途到仓天数" name="inboundArrivalDays" tooltip="在途数量没有预计到仓日，模拟按这个天数一次性到达">
          <InputNumber min={1} max={90} precision={0} style={{ width: 90 }} />
        </Form.Item>
        <Form.Item label="自定义补货量" name="customQty">
          <InputNumber min={0} max={10_000_000} precision={0} style={{ width: 120 }} placeholder="不填则不画" />
        </Form.Item>
        <Form.Item label="多少天后到仓" name="customArriveInDays">
          <InputNumber min={1} max={365} precision={0} style={{ width: 90 }} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={run.isPending}>
          重新模拟
        </Button>
      </Form>
      {run.error ? <DataState {...stateFromError(describeError(run.error), { onRetry: () => start({ inboundArrivalDays: 14 }) })} /> : null}
      {run.isPending && !data ? <DataState kind="skeleton" rows={4} /> : null}
      {data && data.state !== 'OK' ? <Alert type="info" showIcon message="无法模拟" description={data.note ?? '缺少销量或库存数据'} /> : null}
      {data && option ? (
        <>
          <ChartPanel title="未来 90 天库存" ariaLabel="未来 90 天库存趋势：不补货、按建议补货与自定义补货" option={option} height={280} />
          <ul style={{ margin: 0, paddingLeft: 18 }} data-testid="stockouts">
            <Stockouts label="不补货" ranges={data.stockouts.none} />
            <Stockouts label="按建议补货" ranges={data.stockouts.recommended} />
            {data.points.some(point => point.custom !== null) ? <Stockouts label="自定义补货" ranges={data.stockouts.custom} /> : null}
          </ul>
          <Alert
            type="info"
            message="模拟假设"
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {data.assumptions.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            }
          />
        </>
      ) : null}
    </Space>
  )
}

const done = (data: AwdSimulation | undefined) => data !== undefined && data.status !== 'PENDING'

function AwdPane({ row }: { row: RecommendationRow }) {
  const [runId, setRunId] = useState<string | null>(null)
  const start = useApiMutation<Record<string, unknown>, AwdSimulation>({ method: 'POST', path: '/replenishment/simulate', silent: true, onSuccess: result => setRunId(result.runId) })
  const poll = useApiQuery<AwdSimulation>({
    domain: 'realtime',
    path: `/replenishment/simulations/${runId ?? 'none'}`,
    scoped: false,
    enabled: runId !== null,
    staleMs: 0,
    refetchIntervalMs: data => (done(data) ? false : 5000),
  })
  const run = poll.data ?? start.data
  const result = run?.result
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="上游仓储（AWD）经济模拟"
        description="用亚马逊数据中心估算：把这个 SKU 发一批到上游仓储，销售额、费用与净收入大概是多少。查询在亚马逊侧排队，通常几分钟；结果是官方估算，不是实际账单。需要“卖家洞察”角色，没有该角色时会失败并说明原因。"
      />
      <Form
        layout="inline"
        initialValues={{ quantity: row.recommendedQty > 0 ? row.recommendedQty : undefined, endInDays: 30 }}
        onFinish={values => start.mutate({ kind: 'AWD', sellerAccountId: row.sellerAccountId, sku: row.sku, quantity: Number(values.quantity), endInDays: Number(values.endInDays) })}
      >
        <Form.Item label="发往上游仓储（件）" name="quantity" rules={[{ required: true, message: '请输入数量' }]}>
          <InputNumber min={1} max={10_000_000} precision={0} style={{ width: 130 }} />
        </Form.Item>
        <Form.Item label="模拟天数" name="endInDays" tooltip="从今天起算，最多 90 天（亚马逊限制）">
          <InputNumber min={1} max={90} precision={0} style={{ width: 90 }} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={start.isPending}>
          发起模拟
        </Button>
      </Form>
      {start.error ? <DataState {...stateFromError(describeError(start.error))} /> : null}
      {run?.status === 'PENDING' ? <Alert type="info" showIcon message="排队或运行中" description={run.note ?? '正在向亚马逊查询，页面会自动刷新结果'} /> : null}
      {run?.status === 'FAILED' ? <Alert type="error" showIcon message="模拟失败" description={run.note ?? '请稍后重试'} /> : null}
      {run?.status === 'DONE' && run.note ? <Alert type="warning" showIcon message="没有结果" description={run.note} /> : null}
      {run?.status === 'DONE' && result && result.rows > 0 ? (
        <Descriptions size="small" bordered column={1} data-testid="awd-result" title="官方估算结果">
          <Descriptions.Item label="销售额">{result.sales === null ? '尚无记录' : formatMoney(result.sales, result.currency ?? 'USD', { digits: 2 })}</Descriptions.Item>
          <Descriptions.Item label="费用合计">{result.fees === null ? '尚无记录' : formatMoney(result.fees, result.currency ?? 'USD', { digits: 2 })}</Descriptions.Item>
          <Descriptions.Item label="净收入">{result.netProceeds === null ? '尚无记录' : formatMoney(result.netProceeds, result.currency ?? 'USD', { digits: 2 })}</Descriptions.Item>
          <Descriptions.Item label="说明">{result.rows} 行官方估算记录。与“不发上游仓储”相比的变化需要再做一次对比模拟，本版只展示官方给出的估算值。</Descriptions.Item>
        </Descriptions>
      ) : null}
      {run ? (
        <Typography.Text type="secondary">
          模拟区间：{run.input.startDate} 至 {run.input.endDate}，发往上游仓储 {run.input.quantity} 件
        </Typography.Text>
      ) : null}
    </Space>
  )
}

export function SimulationDrawer({ row, onClose }: { row: RecommendationRow | null; onClose: () => void }) {
  return (
    <Drawer open={row !== null} onClose={onClose} width={860} title={row ? `模拟：${row.sku}（${row.storeName}）` : '模拟'} destroyOnClose>
      {row ? (
        <Tabs
          items={[
            { key: 'trend', label: '90 天库存趋势', children: <TrendPane row={row} /> },
            { key: 'awd', label: '上游仓储模拟', children: <AwdPane row={row} /> },
          ]}
        />
      ) : null}
    </Drawer>
  )
}
