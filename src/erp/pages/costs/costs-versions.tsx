import { useState } from 'react'
import { Alert, Select, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { COST_COMPONENT_LABEL, type CostCompareResponse, type CostVersionView } from '@nova/api-contracts'
import { DataState, stateFromError, SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { VersionActivateAction, VersionDiscardAction, VersionEditAction } from './costs-forms'
import { StatusTag, amountText, usdText } from './costs-ui'

// 版本时间线与版本对比（P2b-14，05 章 5.9）：每个版本的来源（采购收货、头程分摊、手工、文件导入）、状态、四项成本、入库批次件数、操作人；
// 草稿可以修改、丢弃、确认生效；被入库批次压过的价格版本、被替换的版本都写明原因，不让人误以为它们还在计价。

function sourceCell(row: CostVersionView) {
  return (
    <div>
      <div>{row.sourceLabel}</div>
      {row.sourceDocNo ? (
        <div className="erp-num" style={{ fontSize: 12 }}>
          {row.sourceDocNo}
        </div>
      ) : null}
    </div>
  )
}

function statusCell(row: CostVersionView) {
  return (
    <Space direction="vertical" size={2}>
      <StatusTag status={row.status} />
      {row.status === 'REPLACED' ? <Muted>被第 {row.replacedByVersionNo ?? '?'} 版替换</Muted> : null}
      {row.ignoredComponents.length > 0 ? <Tag color="warning">{row.ignoredComponents.map(item => COST_COMPONENT_LABEL[item]).join('、')}已被入库批次压过，不参与计价</Tag> : null}
      {row.blockedReason ? <Muted>{row.blockedReason}</Muted> : null}
    </Space>
  )
}

export function VersionTimeline({ sku, versions, canWrite, truncated }: { sku: string; versions: CostVersionView[]; canWrite: boolean; truncated: boolean }) {
  const columns: ColumnsType<CostVersionView> = [
    { title: '版本', dataIndex: 'versionNo', width: 70, render: (value: number) => <span className="erp-num">第 {value} 版</span> },
    { title: '状态', key: 'status', width: 190, render: (_value, row) => statusCell(row) },
    { title: '来源', key: 'source', width: 130, render: (_value, row) => sourceCell(row) },
    { title: '生效日期', dataIndex: 'effectiveFrom', width: 110, render: (value: string) => <span className="erp-num">{value}</span> },
    { title: '币种', dataIndex: 'currency', width: 70 },
    { title: '采购单价', dataIndex: 'product', width: 100, align: 'right', render: (value: string | null) => amountText(value) },
    { title: '头程分摊', dataIndex: 'firstMile', width: 100, align: 'right', render: (value: string | null) => amountText(value) },
    { title: '关税', dataIndex: 'duty', width: 80, align: 'right', render: (value: string | null) => amountText(value) },
    { title: '其他成本', dataIndex: 'other', width: 90, align: 'right', render: (value: string | null) => amountText(value) },
    { title: '批次件数', dataIndex: 'quantity', width: 90, align: 'right', render: (value: number | null) => (value === null ? <Muted>价格版本</Muted> : <span className="erp-num">{value}</span>) },
    {
      title: '录入 / 生效',
      key: 'people',
      width: 170,
      render: (_value, row) => (
        <div style={{ fontSize: 12 }}>
          <div>
            录入：{row.createdByName ?? <Muted>系统</Muted>} · {formatDateTime(row.createdAt)}
          </div>
          {row.activatedAt ? (
            <div>
              生效：{row.activatedByName ?? <Muted>历史数据</Muted>} · {formatDateTime(row.activatedAt)}
            </div>
          ) : null}
        </div>
      ),
    },
    { title: '备注', dataIndex: 'note', width: 140, ellipsis: true, render: (value: string | null) => value ?? <Muted>无</Muted> },
    {
      title: '操作',
      key: 'actions',
      width: 210,
      fixed: 'right',
      render: (_value, row) =>
        row.status === 'DRAFT' ? (
          <Space size={4}>
            {row.editable ? <VersionEditAction canWrite={canWrite} version={row} sku={sku} /> : null}
            {row.canDiscard ? <VersionDiscardAction canWrite={canWrite} version={row} sku={sku} /> : null}
            <VersionActivateAction canWrite={canWrite} version={row} sku={sku} />
          </Space>
        ) : (
          <Muted>已定稿，不能修改</Muted>
        ),
    },
  ]
  return (
    <div data-testid="cost-versions">
      <SimpleGrid<CostVersionView>
        gridId="costs.costs-versions"
        columns={columns}
        rows={versions}
        rowKey={row => row.id}
        emptyState={{ kind: 'empty', domain: '明细', prerequisite: '还没有任何成本版本' }}
      />
      {truncated ? <Muted>只显示最近 200 个版本</Muted> : null}
    </div>
  )
}

function changeText(row: CostCompareResponse['rows'][number]) {
  if (row.delta !== null)
    return <span className="erp-num">{`${row.delta > 0 ? '+' : ''}${row.delta}${row.deltaPct === null ? '' : `（${row.deltaPct > 0 ? '+' : ''}${(row.deltaPct * 100).toFixed(1)}%）`}`}</span>
  if (row.usdDelta !== null) return <span>折合美元 {usdText(row.usdDelta)}（币种不同）</span>
  return <Muted>只有一边有这一项，或缺汇率，不给差额</Muted>
}

/** 版本对比：选两个版本，看四项成本的差额；币种不同只给折合美元的差额。 */
export function VersionCompare({ sku, versions }: { sku: string; versions: CostVersionView[] }) {
  const [a, setA] = useState<string>()
  const [b, setB] = useState<string>()
  const options = versions.map(item => ({ value: item.id, label: `第 ${item.versionNo} 版 · ${item.statusLabel} · ${item.effectiveFrom}` }))
  const query = useApiQuery<CostCompareResponse>({ domain: 'list', path: `/costs/${encodeURIComponent(sku)}/compare`, params: { a, b }, scoped: false, enabled: Boolean(a && b && a !== b) })
  return (
    <div data-testid="cost-compare">
      <Space wrap style={{ marginBottom: 8 }}>
        <Select aria-label="对比版本 A" placeholder="选择版本 A" style={{ width: 280 }} options={options} value={a} onChange={setA} allowClear />
        <Typography.Text type="secondary">对比</Typography.Text>
        <Select aria-label="对比版本 B" placeholder="选择版本 B" style={{ width: 280 }} options={options} value={b} onChange={setB} allowClear />
      </Space>
      {a && b && a === b ? <Alert type="info" showIcon message="请选择两个不同的版本" /> : null}
      {query.error ? <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} /> : null}
      {query.data ? (
        <>
          <SimpleGrid
            gridId="costs.costs-versions"
            columns={[
              { title: '成本项', dataIndex: 'label', width: 110 },
              { title: `第 ${query.data.a.versionNo} 版（${query.data.a.currency}）`, dataIndex: 'a', align: 'right', render: (value: string | null) => amountText(value) },
              { title: `第 ${query.data.b.versionNo} 版（${query.data.b.currency}）`, dataIndex: 'b', align: 'right', render: (value: string | null) => amountText(value) },
              { title: '变化', key: 'change', render: (_value, row) => changeText(row) },
            ]}
            rows={query.data.rows}
            rowKey={row => row.component}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '两个版本都没有成本' }}
          />
          <div style={{ margin: '4px 0', fontWeight: 400 }}>{(() => <Muted>生效日期相差 {query.data?.effectiveDays} 天；变化是第二个版本相对第一个版本。</Muted>)()}</div>
        </>
      ) : null}
    </div>
  )
}
