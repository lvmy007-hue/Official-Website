import { Alert, Descriptions, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { InboundItemView, InboundOverview } from '@nova/api-contracts'
import { formatDateTime } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { PrepCostsAction } from './inbound-option-actions'
import { Countdown, money, qty, SOURCE_LABEL } from './inbound-ui'
import { SimpleGrid } from '../../components'

// 入仓计划详情的“概览”“商品”“费用”页签。预处理与贴标固定由卖家负责；没有数据的项写“尚无记录”，不写 0。

const addressText = (address: Record<string, unknown> | null) =>
  address
    ? [address.name, address.addressLine1, address.addressLine2, address.city, address.stateOrProvinceCode, address.postalCode, address.countryCode]
        .filter(part => typeof part === 'string' && part !== '')
        .join('，')
    : ''

export function OverviewTab({ overview }: { overview: InboundOverview }) {
  const { plan, deadlines, eligibilitySummary } = overview
  const address = addressText(overview.address)
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Descriptions size="small" column={{ xs: 1, md: 2, xl: 3 }} bordered>
        <Descriptions.Item label="店铺">{plan.storeName}</Descriptions.Item>
        <Descriptions.Item label="亚马逊计划编号">{plan.externalPlanId ?? <Muted>尚未提交亚马逊</Muted>}</Descriptions.Item>
        <Descriptions.Item label="来源">{SOURCE_LABEL[plan.sourceType] ?? plan.sourceType}</Descriptions.Item>
        <Descriptions.Item label="预处理与贴标">
          <Tag bordered={false}>卖家负责（固定）</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="创建时间">{formatDateTime(plan.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="更新时间">{formatDateTime(plan.updatedAt)}</Descriptions.Item>
        <Descriptions.Item label="发货地址" span={3}>
          {address || <Muted>尚无记录</Muted>}
        </Descriptions.Item>
      </Descriptions>
      <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered title="截止时间">
        <Descriptions.Item label="装箱方案有效期">{deadlines.packingExpiresAt ? <Countdown at={deadlines.packingExpiresAt} /> : <Muted>无待确认的方案</Muted>}</Descriptions.Item>
        <Descriptions.Item label="分仓方案有效期">{deadlines.placementExpiresAt ? <Countdown at={deadlines.placementExpiresAt} /> : <Muted>无待确认的方案</Muted>}</Descriptions.Item>
        <Descriptions.Item label="作废窗口">
          {deadlines.voidWindow.known ? <Countdown at={deadlines.voidWindow.deadline} expiredText="已过，不能再取消" /> : <Muted>运输方案确认后才有</Muted>}
        </Descriptions.Item>
      </Descriptions>
      <Typography.Text>
        资格预检：已检查 {eligibilitySummary.checked} 个，不合格 {eligibilitySummary.ineligible} 个，未检查 {eligibilitySummary.unchecked} 个
      </Typography.Text>
      <Alert type="info" showIcon message="取消说明" description={overview.cancelNote} />
    </Space>
  )
}

const itemColumns: ColumnsType<InboundItemView> = [
  { title: 'SKU', dataIndex: 'sku', width: 180 },
  { title: '商品', dataIndex: 'productName', width: 240, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
  { title: 'FNSKU', dataIndex: 'fnsku', width: 130, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
  { title: 'ASIN', dataIndex: 'asin', width: 120, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
  { title: '数量', dataIndex: 'quantity', width: 90, align: 'right', render: qty },
  { title: '到期日', dataIndex: 'expiry', width: 110, render: (value: string | null) => value ?? <Muted>无</Muted> },
  { title: '预处理与贴标', key: 'prep', width: 220, render: (_value, row) => row.prepInstruction ?? '卖家负责' },
  {
    title: '资格预检',
    key: 'eligibility',
    width: 220,
    render: (_value, row) =>
      row.eligibility === null ? (
        <Muted>未检查</Muted>
      ) : row.eligibility.eligible ? (
        <Tag color="success" bordered={false}>
          合格
        </Tag>
      ) : (
        <span>
          <Tag color="error" bordered={false}>
            不合格
          </Tag>
          {row.eligibility.reasonCodes.join('、')}
        </span>
      ),
  },
]

export function ItemsTab({ overview }: { overview: InboundOverview }) {
  return (
    <SimpleGrid<InboundItemView>
      gridId="inbound.inbound-tabs-plan"
      columns={itemColumns}
      rows={overview.items}
      rowKey={row => row.sku}
      emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
    />
  )
}

export function CostsTab({ overview }: { overview: InboundOverview }) {
  const { costs } = overview
  const row = (label: string, value: number | null) => <Descriptions.Item label={label}>{money(value, costs.currency)}</Descriptions.Item>
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space>
        <PrepCostsAction overview={overview} />
      </Space>
      <Descriptions size="small" column={{ xs: 1, md: 2, xl: 3 }} bordered>
        {row('装箱服务费', costs.packingFee)}
        {row('分仓费', costs.placementFee)}
        {row('分仓折扣', costs.placementDiscount)}
        {row('运费', costs.transportCost)}
        {row('预处理费用（卖家自理）', costs.prepCost)}
        {row('贴标费用（卖家自理）', costs.labelCost)}
        <Descriptions.Item label="已知部分合计">{money(costs.knownTotal, costs.currency)}</Descriptions.Item>
      </Descriptions>
      {costs.missing.length > 0 ? <Alert type="warning" showIcon message="以下费用还没有数据，合计只包含已知部分" description={costs.missing.join('、')} /> : null}
    </Space>
  )
}
