import type { ReactNode } from 'react'
import { Space, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  LISTING_IMPACT_LABEL,
  LISTING_ISSUE_KIND_LABEL,
  LISTING_ISSUE_STATUS_LABEL,
  LISTING_SEVERITY_LABEL,
  type ListingChangeRow,
  type ListingImpactEstimate,
  type ListingInactiveRow,
  type ListingIssueRow,
  type ListingRestrictionRow,
} from '@nova/api-contracts'
import { EstimateTag } from '../../components'
import { formatDateTime, formatMoney } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { safeHttpUrl } from '../../security/safe-url'
import { SEVERITY_COLOR } from './listing-quality-state'

// 刊登质量各页签的表格列（05 章 5.4）。没有记录写“尚无记录”，不写 0；影响销售额是估算，必须带“估算”标签与方法。

const Muted = ({ children }: { children: ReactNode }) => <Typography.Text type="secondary">{children}</Typography.Text>

function Product({ row }: { row: { productId: string | null; title: string | null; sku: string; asin: string; storeName: string } }) {
  const title = row.title ?? '（商品目录里没有这个商品）'
  return (
    <div>
      {row.productId ? (
        <AppLink to={`/app/products/${encodeURIComponent(row.productId)}`}>
          <Typography.Link>{title}</Typography.Link>
        </AppLink>
      ) : (
        <span>{title}</span>
      )}
      <div>
        <Muted>
          {row.asin || '尚无 ASIN'} · {row.sku}
        </Muted>
      </div>
      <Muted>{row.storeName}</Muted>
    </div>
  )
}

function durationText(hours: number): string {
  if (hours < 1) return '不到 1 小时'
  if (hours < 48) return `${Math.round(hours)} 小时`
  return `${Math.round(hours / 24)} 天`
}

function Estimate({ estimate }: { estimate: ListingImpactEstimate | null }) {
  if (!estimate) return <Muted>尚无记录</Muted>
  if (estimate.state !== 'OK') return <Muted>{estimate.note ?? '不适用'}</Muted>
  const change = estimate.estimatedChange
  return (
    <Space size={4} wrap>
      <span>{change === null ? '尚无记录' : formatMoney(change, 'USD', { sign: true })}</span>
      <EstimateTag
        method="对比问题存续期与此前同长度时段的日均销售额，乘以存续天数；受季节、促销等影响，只作参考"
        range={`存续期日均 ${estimate.duringDaily === null ? '尚无记录' : formatMoney(estimate.duringDaily)}，此前日均 ${estimate.beforeDaily === null ? '尚无记录' : formatMoney(estimate.beforeDaily)}`}
      />
    </Space>
  )
}

export function issueColumns(options: { onFix?: (row: ListingIssueRow) => ReactNode }): ColumnsType<ListingIssueRow> {
  return [
    { title: '商品', key: 'product', width: 260, render: (_v, row) => <Product row={row} /> },
    {
      title: '问题',
      key: 'issue',
      width: 320,
      render: (_v, row) => (
        <div>
          <Space size={4} wrap>
            <Tag color={SEVERITY_COLOR[row.severity]}>{LISTING_SEVERITY_LABEL[row.severity]}</Tag>
            <Tag>{LISTING_ISSUE_KIND_LABEL[row.kind]}</Tag>
            <Muted>
              {row.code}
              {row.attributeName ? ` · ${row.attributeName}` : ''}
            </Muted>
          </Space>
          <div>{row.message}</div>
          <Muted>{row.advice}</Muted>
        </div>
      ),
    },
    { title: '对销售的影响', key: 'impact', width: 150, render: (_v, row) => LISTING_IMPACT_LABEL[row.impact] },
    { title: '估算销售额变化', key: 'estimate', width: 200, render: (_v, row) => <Estimate estimate={row.estimate} /> },
    {
      title: '状态',
      key: 'status',
      width: 110,
      render: (_v, row) => <Tag color={row.status === 'RESOLVED' ? 'green' : row.status === 'IN_PROGRESS' ? 'blue' : 'default'}>{LISTING_ISSUE_STATUS_LABEL[row.status]}</Tag>,
    },
    {
      title: '首次发现 / 持续',
      key: 'time',
      width: 170,
      render: (_v, row) => (
        <div>
          <div>{formatDateTime(row.firstSeenAt)}</div>
          <Muted>{row.resolvedAt ? `${durationText(row.durationHours)}后解决` : `已持续 ${durationText(row.durationHours)}`}</Muted>
        </div>
      ),
    },
    { title: '负责人', key: 'owner', width: 110, render: (_v, row) => row.ownerName ?? <Muted>未指定</Muted> },
    ...(options.onFix
      ? [{ title: '操作', key: 'action', width: 100, fixed: 'right' as const, render: (_v: unknown, row: ListingIssueRow) => (row.status === 'RESOLVED' ? null : options.onFix?.(row)) }]
      : []),
  ]
}

const textOf = (value: string | null) => (value === null || value === '' ? <Muted>尚无记录</Muted> : <span>{value}</span>)

export function changeColumns(): ColumnsType<ListingChangeRow> {
  return [
    { title: '商品', key: 'product', width: 260, render: (_v, row) => <Product row={{ ...row, title: row.title }} /> },
    { title: '变更内容', key: 'field', width: 120, render: (_v, row) => row.fieldLabel },
    { title: '变更前', key: 'before', width: 220, render: (_v, row) => textOf(row.before) },
    { title: '变更后', key: 'after', width: 220, render: (_v, row) => textOf(row.after) },
    { title: '来源', key: 'actor', width: 150, render: (_v, row) => row.actorLabel },
    { title: '发现时间', key: 'time', width: 170, render: (_v, row) => formatDateTime(row.occurredAt) },
  ]
}

export function inactiveColumns(): ColumnsType<ListingInactiveRow> {
  return [
    { title: '商品', key: 'product', width: 260, render: (_v, row) => <Product row={{ ...row, title: row.title }} /> },
    { title: '商品类型', key: 'type', width: 140, render: (_v, row) => row.productType ?? <Muted>尚无记录</Muted> },
    {
      title: '亚马逊状态',
      key: 'statuses',
      width: 200,
      render: (_v, row) => (row.statuses.length > 0 ? row.statuses.map(status => <Tag key={status}>{status}</Tag>) : <Muted>不可售也不可被发现</Muted>),
    },
    { title: '非活跃天数', key: 'days', width: 120, render: (_v, row) => `${row.inactiveDays} 天` },
    { title: '状态自', key: 'since', width: 170, render: (_v, row) => formatDateTime(row.statusSince) },
    { title: '同步时间', key: 'synced', width: 170, render: (_v, row) => formatDateTime(row.syncedAt) },
  ]
}

export function restrictionColumns(): ColumnsType<ListingRestrictionRow> {
  return [
    { title: 'ASIN', key: 'asin', width: 150, render: (_v, row) => row.asin },
    { title: '店铺', key: 'store', width: 150, render: (_v, row) => row.storeName },
    { title: '商品状况', key: 'condition', width: 110, render: (_v, row) => row.conditionType },
    { title: '结论', key: 'result', width: 110, render: (_v, row) => (row.restricted ? <Tag color="red">受限</Tag> : <Tag color="green">可以刊登</Tag>) },
    {
      title: '原因与处理',
      key: 'reasons',
      render: (_v, row) =>
        row.reasons.length === 0 ? (
          <Muted>没有限制</Muted>
        ) : (
          row.reasons.map(reason => (
            <div key={reason.code}>
              <Tooltip title={reason.code}>
                <span>{reason.label}</span>
              </Tooltip>
              {reason.message ? <div>{reason.message}</div> : null}
              {reason.links.map(link => (
                <div key={link.url}>
                  <Typography.Link href={safeHttpUrl(link.url)} target="_blank" rel="noopener noreferrer">
                    {link.title}
                  </Typography.Link>
                </div>
              ))}
            </div>
          ))
        ),
    },
    {
      title: '查询时间 / 有效至',
      key: 'time',
      width: 190,
      render: (_v, row) => (
        <div>
          <div>{formatDateTime(row.checkedAt)}</div>
          <Muted>{formatDateTime(row.expiresAt)}</Muted>
        </div>
      ),
    },
  ]
}
