import { useMemo, useState } from 'react'
import { Alert, Button, Card, InputNumber, Space, Statistic } from 'antd'
import { ASIN360_WIN_PRICE_NOTE, simulatePrice, type Asin360EconomicsResponse } from '@nova/api-contracts'
import { formatMoney, formatPercent } from '../../format'
import { Muted } from '../inventory/inventory-ui'

// 价格模拟器（05 章 5.2 利润与成本页签）：输入目标售价，估算每件净利润。
// 假设写在页面上：佣金、退款、促销按售价等比例变化，其余费用与成本每件固定；这是模型估算，不是亚马逊的结果。
// 只用“每件净利润”和“比例项占售价的份额”，不需要看到各项成本，所以没有成本字段权限的人也能用；缺成本算不出净利润时不能模拟，也不拿部分数字代替。

const ASSUMPTION = '假设：佣金、退款、促销按售价等比例变化，其余费用（配送、仓储、广告、头程、采购成本等）每件固定不变；没有考虑售价变化引起的销量变化。这是模型估算。'

export function PriceSimulator({ data }: { data: Asin360EconomicsResponse }) {
  const { unit, currency } = data
  const [price, setPrice] = useState<number | null>(null)
  const target = price ?? (unit.avgPrice === null ? null : Math.round(unit.avgPrice * 100) / 100)
  const result = useMemo(() => (target === null ? null : simulatePrice(unit, target)), [unit, target])
  const money = (value: number) => formatMoney(value, currency, { digits: 2 })
  return (
    <Card size="small" title="价格模拟器" data-testid="asin360-simulator">
      {unit.state !== 'OK' ? (
        <Alert type="info" showIcon message="暂时不能模拟" description={unit.note ?? '范围内没有可用于估算的销量与净利润。'} />
      ) : (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space wrap>
            <span>目标售价（{currency}）</span>
            <InputNumber aria-label="目标售价" min={0.01} step={0.5} precision={2} value={target} onChange={value => setPrice(typeof value === 'number' ? value : null)} />
            {data.listPrice !== null ? (
              <Button size="small" onClick={() => setPrice(data.listPrice)}>
                用上架价 {money(data.listPrice)}
              </Button>
            ) : (
              <Muted>上架价：尚无记录</Muted>
            )}
            {unit.avgPrice !== null ? (
              <Button size="small" onClick={() => setPrice(Math.round(unit.avgPrice! * 100) / 100)}>
                用本期平均售价 {money(unit.avgPrice)}
              </Button>
            ) : null}
          </Space>
          {result ? (
            <Space size={32} wrap data-testid="asin360-simulation">
              <Statistic title="每件净利润" value={money(result.net)} />
              <Statistic title="净利率" value={formatPercent(result.margin, { digits: 1 })} />
              <Statistic title="较本期平均每件净利润" value={`${result.deltaNet >= 0 ? '+' : '-'}${money(Math.abs(result.deltaNet))}`} />
              <Statistic
                title="保本价"
                formatter={() => (result.breakEvenPrice === null ? <Muted>无法估算（比例项吃掉全部涨幅）</Muted> : <span className="erp-num">{money(result.breakEvenPrice)}</span>)}
              />
            </Space>
          ) : (
            <Muted>请输入大于 0 的目标售价。</Muted>
          )}
          <Alert type="info" showIcon message={ASSUMPTION} />
        </Space>
      )}
      <div style={{ marginTop: 8 }}>
        <Alert type="info" showIcon message="预期获胜价：尚未接入" description={data.winPrice.note || ASIN360_WIN_PRICE_NOTE} data-testid="asin360-win-price" />
      </div>
    </Card>
  )
}
