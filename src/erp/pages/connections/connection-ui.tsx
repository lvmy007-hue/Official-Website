import { Space, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { CONNECTION_KIND_LABEL, type ConnectionKind, type ConnectionRow, type ConnectionTone, type HealthCheckItem } from '@nova/api-contracts'
import { formatDateTime } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { RowActions } from './connection-row-actions'

// 连接中心的单元格与列（P5-04，09 章 9.6）：每条连接显示授权主体、账户、授权范围、最近健康检查与最近成功同步、失败码、令牌更新时间与预计失效。

const TONE_COLOR: Record<ConnectionTone, string> = { success: 'success', warning: 'warning', error: 'error', default: 'default' }
const HEALTH_COLOR = { HEALTHY: 'success', UNHEALTHY: 'error', DEGRADED: 'warning', UNKNOWN: 'default' } as const
const sub = { color: 'rgba(0,0,0,0.45)', fontSize: 12 } as const

export function StateTag({ row }: { row: ConnectionRow }) {
  return (
    <Tag color={TONE_COLOR[row.tone]} bordered={false} style={{ marginInlineEnd: 0 }}>
      {row.stateLabel}
    </Tag>
  )
}

function CheckLine({ item }: { item: HealthCheckItem }) {
  const mark = item.ok === true ? '通过' : item.ok === false ? '未通过' : '未检查'
  return (
    <div style={sub} data-testid={`check-${item.key}`}>
      {item.label}：{mark}
      {item.message ? `（${item.message}）` : ''}
    </div>
  )
}

export function HealthCell({ row }: { row: ConnectionRow }) {
  if (!row.health) return <Muted>尚未检查</Muted>
  return (
    <div>
      <Tag color={HEALTH_COLOR[row.health.status]} bordered={false} style={{ marginInlineEnd: 0 }}>
        {row.health.statusLabel}
      </Tag>
      <div style={sub}>{formatDateTime(row.health.checkedAt)}</div>
      {row.health.checks.map(item => (
        <CheckLine key={item.key} item={item} />
      ))}
    </div>
  )
}

export function ExpiryCell({ row }: { row: ConnectionRow }) {
  const expiry = row.tokenExpiry
  if (!expiry || expiry.state === 'NO_TOKEN') return <Muted>没有令牌</Muted>
  if (expiry.state === 'NOT_ESTIMATED') {
    return (
      <Tooltip title={expiry.basis}>
        <span>
          <Muted>未推算</Muted>
        </span>
      </Tooltip>
    )
  }
  const color = expiry.state === 'PASSED' ? 'error' : expiry.state === 'SOON' ? 'warning' : 'success'
  const text = expiry.state === 'PASSED' ? '已超过预计失效时间' : `预计 ${expiry.daysLeft} 天后失效`
  return (
    <Tooltip title={expiry.basis}>
      <div data-testid="token-expiry">
        <div>{formatDateTime(expiry.expiresAt)}</div>
        <Tag color={color} bordered={false} style={{ marginInlineEnd: 0 }}>
          {text}
        </Tag>
      </div>
    </Tooltip>
  )
}

const failureCell = (row: ConnectionRow) =>
  row.failureCode ? (
    <div>
      <div className="erp-num">{row.failureCode}</div>
      <div style={sub}>{row.failureText}</div>
    </div>
  ) : (
    <Muted>无</Muted>
  )

const accountCell = (row: ConnectionRow) => (
  <div>
    <div>{row.accountLabel}</div>
    {row.storeName ? <div style={sub}>店铺 {row.storeName}</div> : null}
  </div>
)

const subjectCell = (row: ConnectionRow) =>
  row.subject || row.authorizedBy ? (
    <div>
      <div>{row.subject ?? <Muted>未记录</Muted>}</div>
      {row.authorizedBy ? <div style={sub}>授权人 {row.authorizedBy}</div> : null}
    </div>
  ) : (
    <Muted>未记录</Muted>
  )

const scopesCell = (row: ConnectionRow) =>
  row.scopes.length ? (
    <Space size={[4, 4]} wrap>
      {row.scopes.map(scope => (
        <Tag key={scope} bordered={false} style={{ marginInlineEnd: 0 }}>
          {scope}
        </Tag>
      ))}
    </Space>
  ) : (
    <Muted>未记录</Muted>
  )

/** 授权连接（卖家接口、广告接口）的列。 */
export function authorizedColumns(onDone: () => void): ColumnsType<ConnectionRow> {
  return [
    { title: '授权主体', key: 'subject', width: 170, render: (_value, row) => subjectCell(row) },
    { title: '卖家编号 / 广告账户', key: 'account', width: 200, render: (_value, row) => accountCell(row) },
    { title: '授权范围', key: 'scopes', width: 180, render: (_value, row) => scopesCell(row) },
    { title: '状态', key: 'state', width: 110, render: (_value, row) => <StateTag row={row} /> },
    { title: '最近健康检查', key: 'health', width: 230, render: (_value, row) => <HealthCell row={row} /> },
    { title: '最近成功同步', key: 'lastSuccess', width: 170, render: (_value, row) => (row.lastSuccessAt ? formatDateTime(row.lastSuccessAt) : <Muted>尚无成功同步</Muted>) },
    { title: '失败码', key: 'failure', width: 220, render: (_value, row) => failureCell(row) },
    {
      title: '令牌更新 / 预计失效',
      key: 'token',
      width: 200,
      render: (_value, row) => (
        <div>
          <div>{row.tokenUpdatedAt ? formatDateTime(row.tokenUpdatedAt) : <Muted>没有令牌</Muted>}</div>
          <ExpiryCell row={row} />
        </div>
      ),
    },
    { title: '操作', key: 'actions', width: 260, fixed: 'right', render: (_value, row) => <RowActions row={row} onDone={onDone} /> },
  ]
}

/** 报告权限、品牌分析资格（由同步结果推断的两类）的列：没有授权动作。 */
export function derivedColumns(kind: ConnectionKind): ColumnsType<ConnectionRow> {
  return [
    { title: kind === 'REPORT_ROLE' ? '店铺（报告权限）' : '店铺（品牌分析资格）', key: 'account', width: 220, render: (_value, row) => accountCell(row) },
    { title: '状态', key: 'state', width: 160, render: (_value, row) => <StateTag row={row} /> },
    { title: '依据', key: 'detail', render: (_value, row) => row.detail ?? <Muted>{CONNECTION_KIND_LABEL[row.kind]}</Muted> },
    { title: '最近成功', key: 'lastSuccess', width: 170, render: (_value, row) => (row.lastSuccessAt ? formatDateTime(row.lastSuccessAt) : <Muted>尚无成功记录</Muted>) },
    { title: '失败码', key: 'failure', width: 220, render: (_value, row) => failureCell(row) },
  ]
}
