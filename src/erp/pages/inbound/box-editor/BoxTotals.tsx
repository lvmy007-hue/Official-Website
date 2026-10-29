import { Card, Space, Tag, Typography } from 'antd'
import { CUBIC_FEET_TO_CUBIC_METERS, type BoxTotals as Totals } from '@nova/api-contracts'
import { formatNumber } from '../../../format'
import { Muted } from '../../inventory/inventory-ui'

// 装箱草稿的底部合计：已装件数与计划件数按 SKU 对比（不相等的标红）、箱数、总重、总体积。
// 重量和体积只合计填全了的箱子；有没填全的箱子时写明“合计不完整”，不把没填的当成 0。

const num = (value: number, digits = 0) => <span className="erp-num">{formatNumber(value, { digits })}</span>

export function BoxTotals({ totals }: { totals: Totals }) {
  const volume = totals.totalVolumeCubicFeet
  return (
    <Card size="small" data-testid="box-totals">
      <Space size={24} wrap>
        <span>
          箱数：<strong>{num(totals.boxCount)}</strong>
          <Typography.Text type="secondary">（{totals.boxTypes} 种）</Typography.Text>
        </span>
        <span>
          已装 / 计划：
          <Typography.Text strong type={totals.matched ? undefined : 'danger'} data-testid="totals-units">
            {num(totals.packedUnits)} / {num(totals.plannedUnits)}
          </Typography.Text>
          件
        </span>
        <span data-testid="totals-weight">总重：{totals.totalWeightLb === null ? <Muted>尚无记录</Muted> : <strong>{num(totals.totalWeightLb, 2)} 磅</strong>}</span>
        <span data-testid="totals-volume">
          总体积：
          {volume === null ? (
            <Muted>尚无记录</Muted>
          ) : (
            <strong>
              {num(volume, 2)} 立方英尺（{num(volume * CUBIC_FEET_TO_CUBIC_METERS, 2)} 立方米）
            </strong>
          )}
        </span>
        {totals.incompleteBoxes > 0 ? <Tag color="warning">{totals.incompleteBoxes} 种箱子没填全，重量与体积合计不完整</Tag> : null}
      </Space>
      <Space size={[16, 4]} wrap style={{ marginTop: 8 }} aria-label="按 SKU 对比">
        {totals.skuRows.map(row => (
          <Typography.Text key={row.sku} type={row.diff === 0 ? undefined : 'danger'} data-testid={`sku-${row.sku}`}>
            {row.sku}：已装 {num(row.packed)} / 计划 {num(row.planned)}
            {row.diff === 0 ? '' : row.diff > 0 ? `（多 ${row.diff}）` : `（少 ${-row.diff}）`}
          </Typography.Text>
        ))}
        {totals.unknownSkus.map(sku => (
          <Typography.Text key={sku} type="danger">
            {sku}：不在计划内
          </Typography.Text>
        ))}
      </Space>
    </Card>
  )
}
