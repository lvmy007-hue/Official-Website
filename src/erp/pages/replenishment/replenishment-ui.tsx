import { Alert, Collapse, Descriptions, Space, Tag, Typography } from 'antd'
import { INVENTORY_RISK_LABEL, TRANSPORT_LABEL, type AmazonCompare, type CalcStep, type InventoryRiskLevel, type RecommendationRow, type Shipment } from '@nova/api-contracts'
import { formatDate, formatNumber } from '../../format'

// 补货页共用的小件：风险标签、数量文案、计算链逐步展开、到仓批次、双源核对。
// 所有数字都能展开到公式与输入；没有数据的写“尚未接入”或“尚无记录”，不显示 0。

export const RISK_COLOR: Record<InventoryRiskLevel, string> = { HIGH: 'error', MEDIUM: 'warning', NORMAL: 'success', EXCESS: 'processing' }

export function RiskTag({ risk }: { risk: InventoryRiskLevel | null }) {
  if (!risk) return <Typography.Text type="secondary">—</Typography.Text>
  return (
    <Tag color={RISK_COLOR[risk]} bordered={false}>
      {INVENTORY_RISK_LABEL[risk]}
    </Tag>
  )
}

export const qty = (value: number | null | undefined) =>
  value === null || value === undefined ? <Typography.Text type="secondary">尚无记录</Typography.Text> : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>

export const day = (value: string | null | undefined) => (value ? <span className="erp-num">{formatDate(value)}</span> : <Typography.Text type="secondary">—</Typography.Text>)

/** 置信度是启发式分数（输入完整度），不是统计概率：只分档显示。 */
export function ConfidenceTag({ value }: { value: number }) {
  const level = value >= 0.8 ? ['高', 'success'] : value >= 0.5 ? ['中', 'warning'] : ['低', 'error']
  return (
    <Tag color={level[1]} bordered={false} title={`输入完整度评分 ${value.toFixed(2)}（启发式，不是统计概率）`}>
      {level[0]}
    </Tag>
  )
}

export function ShipmentList({ shipments }: { shipments: Shipment[] }) {
  if (shipments.length === 0) return <Typography.Text type="secondary">无需发货</Typography.Text>
  return (
    <Space direction="vertical" size={0}>
      {shipments.map(shipment => (
        <span key={`${shipment.mode}-${shipment.arriveDate}`}>
          {shipment.mode === 'DEFAULT' ? '默认时效' : TRANSPORT_LABEL[shipment.mode]} <span className="erp-num">{formatNumber(shipment.qty, { digits: 0 })}</span> 件，{formatDate(shipment.orderDate)}{' '}
          下单，{formatDate(shipment.arriveDate)} 到仓
          {shipment.lateDays > 0 ? (
            <Tag color="error" bordered={false} style={{ marginLeft: 4 }}>
              晚于断货日 {shipment.lateDays} 天
            </Tag>
          ) : null}
        </span>
      ))}
    </Space>
  )
}

/** 计算链：每一步一行，展开后看公式、输入与说明。 */
export function CalcStepsView({ steps }: { steps: CalcStep[] }) {
  if (steps.length === 0) return <Typography.Text type="secondary">没有计算步骤（该 SKU 没有产出建议）</Typography.Text>
  return (
    <Collapse
      size="small"
      data-testid="calc-steps"
      items={steps.map((step, index) => ({
        key: step.key,
        label: (
          <span>
            <strong>
              第 {index + 1} 步 {step.title}
            </strong>
            ：{step.result}
          </span>
        ),
        children: (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Typography.Text code>{step.formula}</Typography.Text>
            {step.details.length ? (
              <Descriptions size="small" column={2} bordered>
                {step.details.map(item => (
                  <Descriptions.Item key={item.label} label={item.label}>
                    {item.value}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            ) : null}
            {step.notes.map(note => (
              <Typography.Text key={note} type="secondary" style={{ fontSize: 12 }}>
                {note}
              </Typography.Text>
            ))}
          </Space>
        ),
      }))}
    />
  )
}

/** 双源核对：我方建议与亚马逊官方建议并排，差异按已知输入给出原因。 */
export function AmazonCompareView({ ours, amazon }: { ours: number; amazon: AmazonCompare }) {
  if (amazon.qty === null) return <Alert type="info" showIcon message="亚马逊官方补货建议" description={amazon.diffReason ?? '尚无记录：补货建议报告还没有同步，或该 SKU 不在报告里'} />
  return (
    <Descriptions size="small" column={2} bordered data-testid="amazon-compare">
      <Descriptions.Item label="我方建议">{qty(ours)} 件</Descriptions.Item>
      <Descriptions.Item label="亚马逊建议">
        {qty(amazon.qty)} 件，建议发货日 {day(amazon.shipDate)}
      </Descriptions.Item>
      <Descriptions.Item label="差异">{amazon.diffQty === null ? '—' : `${amazon.diffQty >= 0 ? '我方多 ' : '我方少 '}${Math.abs(amazon.diffQty)} 件`}</Descriptions.Item>
      <Descriptions.Item label="快照日期">{day(amazon.snapshotDate)}</Descriptions.Item>
      <Descriptions.Item label="差异原因" span={2}>
        {amazon.diffReason ?? '差异在可接受范围内'}
      </Descriptions.Item>
    </Descriptions>
  )
}

/** 一条建议展开后的内容：计算链 + 双源核对 + 已做过的动作。 */
export function RecommendationDetail({ row }: { row: RecommendationRow }) {
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <ShipmentList shipments={row.shipments} />
      <CalcStepsView steps={row.steps} />
      <AmazonCompareView ours={row.recommendedQty} amazon={row.amazon} />
      {row.capital.state === 'OK' ? null : <Typography.Text type="secondary">资金占用：{row.capital.note ?? '尚未接入'}</Typography.Text>}
    </Space>
  )
}
