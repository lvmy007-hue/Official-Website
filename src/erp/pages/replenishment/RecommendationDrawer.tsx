import { Alert, Button, Descriptions, Space, Typography } from 'antd'
import { INVENTORY_RISK_LABEL, FORECAST_SCOPE_LABEL, type RecommendationRow } from '@nova/api-contracts'
import { DetailDrawer } from '../../components'
import type { StatusTag } from '../../components/detail/DetailLayout'
import { formatNumber } from '../../format'
import { shipInText } from './recommendation-grid-columns'
import { AmazonCompareView, CalcStepsView, qty, RISK_COLOR, ShipmentList } from './replenishment-ui'

// 建议行详情抽屉（P6-09，15 章第 8 节）：点列表里的一行，在右侧看这条建议的来龙去脉，不离开列表。
// 三个页签：计算链（8 步逐步展开）、供给与必断货（提前期内外供给、必断货量、用到的人工预测规则）、亚马逊对照（双源核对）。
// 批次冻结了这条建议计算时的全部数字：之后改策略、改人工规则都不会让这里的数字变化。

const dash = <Typography.Text type="secondary">旧批次没有记录</Typography.Text>

export function SupplyAndOverrideView({ row }: { row: RecommendationRow }) {
  const missing = row.supplyInLeadTime === null
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {missing ? <Alert type="info" showIcon message="这条建议在“供给拆分与必断货量”上线之前计算，没有这部分记录" description="重新计算一个批次后，这里会显示提前期内外的供给与必断货量。" /> : null}
      <Descriptions size="small" column={2} bordered data-testid="supply-split">
        <Descriptions.Item label="提前期内供给">{missing ? dash : <>{qty(row.supplyInLeadTime)} 件</>}</Descriptions.Item>
        <Descriptions.Item label="提前期外供给（不参与建议量）">{missing ? dash : <>{qty(row.supplyBeyondLeadTime)} 件</>}</Descriptions.Item>
        <Descriptions.Item label="必断货量">{row.unavoidableShortage === null ? dash : <>{qty(row.unavoidableShortage)} 件</>}</Descriptions.Item>
        <Descriptions.Item label="是否计入建议补货量">
          {row.unavoidableIncluded === null ? dash : row.unavoidableIncluded ? '已计入（策略开关已开启）' : '未计入（策略开关默认关闭）'}
        </Descriptions.Item>
      </Descriptions>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        必断货量 = 即使今天下单并走最快的运输方式，到仓前仍然补不上的需求。只有提前期内到仓的供给参与建议量；到仓晚于主提前期的在途单独列出。
      </Typography.Text>
      <Typography.Title level={5} style={{ margin: 0 }}>
        用到的人工预测规则
      </Typography.Title>
      {row.appliedOverride.length === 0 ? (
        <Typography.Text type="secondary">这条建议没有命中人工预测规则，需求用模型预测。</Typography.Text>
      ) : (
        <Descriptions size="small" column={1} bordered data-testid="applied-overrides">
          {row.appliedOverride.map(item => (
            <Descriptions.Item key={item.id} label={`${FORECAST_SCOPE_LABEL[item.scopeType]} ${item.scopeId}`}>
              {item.from} 至 {item.to}，{item.mode === 'FIXED' ? `固定日销 ${item.value} 件/天` : `去年同期 × ${item.value}`}
              {item.rate === null ? '' : `（日销 ${formatNumber(item.rate, { digits: 2 })} 件/天）`}：{item.applied ? `取代模型预测 ${item.days} 天` : `未生效${item.note ? `，${item.note}` : ''}`}
            </Descriptions.Item>
          ))}
        </Descriptions>
      )}
    </Space>
  )
}

export function RecommendationDrawer({ row, onClose, onSimulate }: { row: RecommendationRow | null; onClose: () => void; onSimulate: (row: RecommendationRow) => void }) {
  const statuses: StatusTag[] = row
    ? [
        ...(row.risk ? [{ text: INVENTORY_RISK_LABEL[row.risk], color: RISK_COLOR[row.risk] as StatusTag['color'] }] : []),
        { text: `建议发货 ${shipInText(row.shipInDays)}`, color: row.shipInDays < 0 ? 'error' : row.shipInDays <= 6 ? 'warning' : 'default' },
      ]
    : []
  return (
    <DetailDrawer
      open={row !== null}
      onClose={onClose}
      width={960}
      title={row?.sku ?? ''}
      subtitle={row ? `${row.title ?? row.asin} · ${row.storeName}` : undefined}
      statuses={statuses}
      actions={
        row ? (
          <Button size="small" onClick={() => onSimulate(row)}>
            模拟
          </Button>
        ) : undefined
      }
      tabs={
        row
          ? [
              {
                key: 'calc',
                label: '计算链',
                children: (
                  <Space direction="vertical" size={10} style={{ width: '100%', paddingTop: 8 }}>
                    <ShipmentList shipments={row.shipments} />
                    <CalcStepsView steps={row.steps} />
                    {row.capital.state === 'OK' ? null : <Typography.Text type="secondary">资金占用：{row.capital.note ?? '尚未接入'}</Typography.Text>}
                  </Space>
                ),
              },
              { key: 'supply', label: '供给与必断货', children: <SupplyAndOverrideView row={row} /> },
              { key: 'amazon', label: '亚马逊对照', children: <AmazonCompareView ours={row.recommendedQty} amazon={row.amazon} /> },
            ]
          : []
      }
    />
  )
}
