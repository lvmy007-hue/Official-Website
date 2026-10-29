import { Button, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { REPLENISH_ACTION_LABEL, type RecommendationRow } from '@nova/api-contracts'
import { ConfidenceTag, day, qty, RiskTag } from './replenishment-ui'

// 建议列表的列：风险与数量在前，日期居中，亚马逊建议用于双源对照，最后是已做过的动作与模拟入口。

export const RECOMMENDATION_SORTS = [
  { value: 'risk:asc', label: '风险从高到低' },
  { value: 'recommendedQty:desc', label: '建议量从多到少' },
  { value: 'orderDate:asc', label: '下单日从早到晚' },
  { value: 'arriveDate:asc', label: '到仓日从早到晚' },
  { value: 'sku:asc', label: 'SKU 升序' },
]

export function recommendationColumns(onSimulate: (row: RecommendationRow) => void): ColumnsType<RecommendationRow> {
  return [
    {
      title: 'SKU',
      dataIndex: 'sku',
      width: 220,
      fixed: 'left',
      render: (_value, row) => (
        <Space direction="vertical" size={0}>
          <strong>{row.sku}</strong>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.title ?? row.asin} · {row.storeName}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '风险', dataIndex: 'risk', width: 130, render: (_value, row) => <RiskTag risk={row.risk} /> },
    { title: '建议补货量', dataIndex: 'recommendedQty', width: 110, align: 'right', render: (_value, row) => qty(row.recommendedQty) },
    { title: '建议采购量', dataIndex: 'purchaseQty', width: 110, align: 'right', render: (_value, row) => qty(row.purchaseQty) },
    { title: '下单日', dataIndex: 'orderDate', width: 110, render: (_value, row) => day(row.orderDate) },
    { title: '到仓日', dataIndex: 'arriveDate', width: 110, render: (_value, row) => day(row.arriveDate) },
    { title: '预计断货日', dataIndex: 'stockoutDate', width: 110, render: (_value, row) => day(row.stockoutDate) },
    {
      title: '亚马逊建议',
      key: 'amazon',
      width: 100,
      align: 'right',
      render: (_value, row) => (row.amazon.qty === null ? <Typography.Text type="secondary">尚无记录</Typography.Text> : qty(row.amazon.qty)),
    },
    { title: '置信度', dataIndex: 'confidence', width: 80, render: (_value, row) => <ConfidenceTag value={row.confidence} /> },
    {
      title: '已做动作',
      key: 'actions',
      width: 200,
      render: (_value, row) =>
        row.actions.length === 0 ? (
          <Typography.Text type="secondary">待处理</Typography.Text>
        ) : (
          <Space size={2} wrap>
            {row.actions.map(action => (
              <Tag
                key={`${action.action}-${action.createdAt}`}
                bordered={false}
                color={action.status === 'PENDING_TARGET' ? 'default' : 'blue'}
                title={action.status === 'PENDING_TARGET' ? '以前只登记了意向、没有生成单据；可以在补货建议页的“补建入仓草稿”里补建' : undefined}
              >
                {REPLENISH_ACTION_LABEL[action.action]}
                {action.finalQty === null ? '' : ` ${action.finalQty}`}
                {action.status === 'PENDING_TARGET' ? '（待补建）' : ''}
              </Tag>
            ))}
          </Space>
        ),
    },
    {
      title: '模拟',
      key: 'simulate',
      width: 80,
      fixed: 'right',
      render: (_value, row) => (
        <Button size="small" type="link" onClick={() => onSimulate(row)}>
          模拟
        </Button>
      ),
    },
  ]
}
