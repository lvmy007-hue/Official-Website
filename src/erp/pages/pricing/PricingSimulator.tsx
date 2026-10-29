import { useState } from 'react'
import { Alert, Descriptions, InputNumber, Space, Tag } from 'antd'
import type { PriceSimulationResponse } from '@nova/api-contracts'
import { ActionGuard } from '../../components'
import { formatMoney, formatNumber, formatPercent } from '../../format'
import { useApiMutation } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { priceInputIssue } from './pricing-state'

// 价格模拟器（P4-11）：输入一个价格，看估算的单件净利润、利润率、盈亏平衡价、是否达到预期获胜价、护栏是否通过，
// 以及按历史价格弹性推算的日销量与日利润。模拟只读，不改价；弹性样本不足时不给预测，只写原因。
// 估算口径：佣金、退款、促销按售价等比例变化，其余费用与成本每件固定；弹性是历史相关性，不是因果。

const money = (value: number | null, currency: string) => (value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMoney(value, currency, { digits: 2 })}</span>)

export function PricingSimulator({ storeId, sku, currency, currentPrice }: { storeId: string; sku: string; currency: string; currentPrice: number | null }) {
  const [price, setPrice] = useState<number | null>(null)
  const [result, setResult] = useState<PriceSimulationResponse | null>(null)
  const simulate = useApiMutation<{ price: number }, PriceSimulationResponse>({
    method: 'POST',
    path: `/pricing/${encodeURIComponent(sku)}/simulation`,
    body: ({ price: value }) => ({ storeId, price: value }),
    silent: true,
  })
  const problem = price === null ? null : priceInputIssue(price)

  return (
    <div data-testid="pricing-simulator">
      <Space wrap style={{ marginBottom: 8 }}>
        <span>模拟价格（{currency}）</span>
        <InputNumber
          aria-label="模拟价格"
          min={0}
          max={100_000}
          step={0.01}
          precision={2}
          value={price}
          placeholder={currentPrice === null ? undefined : String(currentPrice)}
          status={problem ? 'error' : undefined}
          onChange={value => {
            setPrice(typeof value === 'number' ? value : null)
            setResult(null)
          }}
        />
        <ActionGuard
          label="开始模拟"
          guard={{}}
          onExecute={async () => {
            if (price === null || problem) throw new Error(problem ?? '请填写模拟价格')
            setResult(await simulate.mutateAsync({ price }))
          }}
          buttonProps={{ type: 'primary' }}
        />
        {problem ? <span style={{ color: 'var(--ant-color-error)' }}>{problem}</span> : null}
      </Space>
      {result ? (
        <>
          {result.note ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={result.note} /> : null}
          <Descriptions size="small" bordered column={2}>
            <Descriptions.Item label="单件净利润（估算）">{money(result.net, currency)}</Descriptions.Item>
            <Descriptions.Item label="较当前价变化">
              {result.deltaNet === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMoney(result.deltaNet, currency, { digits: 2, sign: true })}</span>}
            </Descriptions.Item>
            <Descriptions.Item label="利润率（估算）">
              {result.margin === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatPercent(result.margin, { digits: 1 })}</span>}
            </Descriptions.Item>
            <Descriptions.Item label="盈亏平衡价">{money(result.breakEvenPrice, currency)}</Descriptions.Item>
            <Descriptions.Item label="预期获胜价">{money(result.expectedPrice, currency)}</Descriptions.Item>
            <Descriptions.Item label="是否达到预期获胜价">
              {result.reachesExpected === null ? <Muted>尚无记录</Muted> : result.reachesExpected ? <Tag color="success">价格不高于预期获胜价</Tag> : <Tag color="warning">价格高于预期获胜价</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label="价格护栏" span={2}>
              {result.guardrail.ok ? (
                <Tag color="success">通过</Tag>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {result.guardrail.violations.map(item => (
                    <li key={item.code}>{item.text}</li>
                  ))}
                </ul>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="价格弹性" span={2}>
              {result.elasticity.state === 'OK' && result.elasticity.value !== null ? (
                <span>
                  <span className="erp-num">{formatNumber(result.elasticity.value, { digits: 2 })}</span>（{result.elasticity.samples} 天样本）
                </span>
              ) : (
                <Muted>{result.elasticity.note}</Muted>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="预计日销量" span={1}>
              {result.projection.unitsPerDay === null ? (
                <Muted>{result.projection.note ?? '尚无记录'}</Muted>
              ) : (
                <span className="erp-num">{formatNumber(result.projection.unitsPerDay, { digits: 1 })}</span>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="预计日利润" span={1}>
              {result.projection.profitPerDay === null ? (
                <Muted>{result.projection.note ?? '尚无记录'}</Muted>
              ) : (
                <span className="erp-num">{formatMoney(result.projection.profitPerDay, currency, { digits: 2 })}</span>
              )}
            </Descriptions.Item>
          </Descriptions>
          <p style={{ margin: '8px 0 0', fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{result.basis}</p>
        </>
      ) : null}
    </div>
  )
}
