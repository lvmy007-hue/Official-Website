import type { ReactNode } from 'react'
import { Space, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { PricingRow } from '@nova/api-contracts'
import { formatDateTime, formatMoney, formatPercent } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { moneyCell, percentCell } from '../advertising/ads-campaigns-ui'
import { Muted } from '../inventory/inventory-ui'
import { HEALTH_COLOR, detailPath } from './pricing-state'

// 定价列表的列（05 章 5.5）：没有记录写“尚无记录”，没有权限写“无权限”，不补 0。利润率是估算（假设佣金、退款、促销随售价等比例变化），带“估算”标签。

const marginCell = (row: PricingRow, at: 'atCurrent' | 'atExpected'): ReactNode => {
  const margin = row.margin
  if (margin.state === 'RESTRICTED') return <Muted>无权限</Muted>
  const value = margin[at]
  if (value === null) {
    return (
      <Tooltip title={margin.note ?? '没有利润数据'}>
        <span>
          <Muted>尚无记录</Muted>
        </span>
      </Tooltip>
    )
  }
  return (
    <Space size={4}>
      <span className="erp-num">{formatPercent(value, { digits: 1 })}</span>
      <Tag bordered={false}>估算</Tag>
    </Space>
  )
}

export function pricingColumns(actions: { onChange: (row: PricingRow) => ReactNode }): ColumnsType<PricingRow> {
  return [
    {
      title: '商品',
      key: 'product',
      fixed: 'left',
      width: 280,
      render: (_v, row) => (
        <div>
          <AppLink to={detailPath(row.sku)} search={{ storeId: row.storeId }}>
            {row.title}
          </AppLink>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.asin || '尚无 ASIN'} · {row.sku} · {row.storeName}
            </Typography.Text>
          </div>
        </div>
      ),
    },
    {
      title: '当前价',
      key: 'price',
      width: 110,
      render: (_v, row) =>
        row.price === null ? (
          <Muted>尚无记录</Muted>
        ) : (
          <Tooltip title={row.priceObservedAt ? `最近一次同步：${formatDateTime(row.priceObservedAt)}` : undefined}>
            <span className="erp-num">{formatMoney(row.price, row.currency, { digits: 2 })}</span>
          </Tooltip>
        ),
    },
    { title: '推荐报价价格', key: 'featured', width: 120, render: (_v, row) => moneyCell(row.featured.price, row.currency) },
    { title: '最低竞争价', key: 'lowest', width: 110, render: (_v, row) => moneyCell(row.lowestPrice, row.currency) },
    {
      title: '预期获胜价',
      key: 'expected',
      width: 120,
      render: (_v, row) => (
        <Tooltip title={row.expectedStatus ? `接口结论：${row.expectedStatus}` : undefined}>
          <span>{moneyCell(row.expectedPrice, row.currency)}</span>
        </Tooltip>
      ),
    },
    {
      title: '差距',
      key: 'gap',
      width: 100,
      render: (_v, row) =>
        row.gap === null ? (
          <Muted>尚无记录</Muted>
        ) : (
          <span className="erp-num" style={{ color: row.gap > 0.005 ? 'var(--ant-color-warning)' : undefined }}>
            {formatMoney(row.gap, row.currency, { digits: 2, sign: true })}
          </span>
        ),
    },
    { title: '购物车获得率', key: 'buyBox', width: 120, render: (_v, row) => percentCell(row.buyBoxPct) },
    {
      title: '价格健康',
      key: 'health',
      width: 150,
      render: (_v, row) => (
        <Tag color={HEALTH_COLOR[row.health]} bordered={false}>
          {row.healthLabel}
        </Tag>
      ),
    },
    { title: '当前价利润率', key: 'marginNow', width: 130, render: (_v, row) => marginCell(row, 'atCurrent') },
    { title: '预期价利润率', key: 'marginExpected', width: 130, render: (_v, row) => marginCell(row, 'atExpected') },
    {
      title: '最近调价',
      key: 'lastChange',
      width: 190,
      render: (_v, row) =>
        row.lastChange ? (
          <span>
            <span className="erp-num">
              {row.lastChange.from === null ? '—' : formatMoney(row.lastChange.from, row.currency, { digits: 2 })} → {formatMoney(row.lastChange.to, row.currency, { digits: 2 })}
            </span>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatDateTime(row.lastChange.at)}
              </Typography.Text>
            </div>
          </span>
        ) : (
          <Muted>尚无记录</Muted>
        ),
    },
    {
      title: '护栏',
      key: 'limits',
      width: 150,
      render: (_v, row) => {
        const limits = row.limits
        if (!limits) return <Muted>未设置</Muted>
        const parts = [
          limits.minPrice === null ? null : `最低 ${formatMoney(limits.minPrice, row.currency, { digits: 2 })}`,
          limits.maxPrice === null ? null : `最高 ${formatMoney(limits.maxPrice, row.currency, { digits: 2 })}`,
          limits.minMarginPct === null ? null : `利润率 ≥ ${formatPercent(limits.minMarginPct, { digits: 0 })}`,
          limits.maxChangePct === null ? null : `单次 ≤ ${formatPercent(limits.maxChangePct, { digits: 0 })}`,
        ].filter(Boolean)
        return <span style={{ fontSize: 12 }}>{parts.join('；')}</span>
      },
    },
    { title: '操作', key: 'actions', fixed: 'right', width: 90, render: (_v, row) => actions.onChange(row) },
  ]
}
