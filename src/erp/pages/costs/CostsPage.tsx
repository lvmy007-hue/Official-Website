import { useMemo, useState } from 'react'
import { Alert, Button, Card, Checkbox, Input, Space, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { COST_COVERAGES, COST_COVERAGE_LABEL, type CostCoverage, type CostListResponse, type CostRow } from '@nova/api-contracts'
import { PageHeader, SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { PAGE_SIZES, Pager, Pick } from '../reimbursements/reimbursements-ui'
import { CostDetailDrawer } from './CostDetailDrawer'
import { CostCreateAction, CostImportAction } from './costs-forms'
import { CoverageTag, PartCell, landedText } from './costs-ui'

// 商品成本（P2b-14，05 章 5.9）：每个 SKU 当前的成本版本——采购单价、头程分摊、关税、其他成本、到岸成本合计与覆盖状态。
// 成本在企业层面（采购没有店铺归属）；草稿不参与利润，确认生效后才计价；已关账期间的利润不受之后的成本变更影响。
// 利润分析、价格模拟与补货资金估算都读这里的生效版本。

function columnsOf(open: (sku: string) => void): ColumnsType<CostRow> {
  return [
    {
      title: 'SKU',
      dataIndex: 'sku',
      width: 170,
      fixed: 'left',
      render: (value: string) => (
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => open(value)}>
          {value}
        </Button>
      ),
    },
    { title: '商品', dataIndex: 'title', width: 220, ellipsis: true, render: (value: string | null) => value ?? <Muted>没有同步到商品信息</Muted> },
    { title: '覆盖状态', dataIndex: 'coverage', width: 100, render: (_value, row) => <CoverageTag coverage={row.coverage} /> },
    { title: '采购单价', key: 'product', width: 130, align: 'right', render: (_value, row) => <PartCell part={row.parts.product} /> },
    { title: '头程分摊', key: 'firstMile', width: 130, align: 'right', render: (_value, row) => <PartCell part={row.parts.firstMile} /> },
    { title: '关税', key: 'duty', width: 120, align: 'right', render: (_value, row) => <PartCell part={row.parts.duty} /> },
    { title: '其他成本', key: 'other', width: 120, align: 'right', render: (_value, row) => <PartCell part={row.parts.other} /> },
    { title: '到岸成本合计', key: 'landed', width: 120, align: 'right', render: (_value, row) => landedText(row.landedUsd, row.landedState) },
    { title: '采购单价生效日', dataIndex: 'productEffectiveFrom', width: 130, render: (value: string | null) => (value ? <span className="erp-num">{value}</span> : <Muted>无</Muted>) },
    {
      title: '版本',
      key: 'versions',
      width: 130,
      render: (_value, row) => (
        <Space size={4}>
          <span>生效 {row.activeCount}</span>
          {row.draftCount > 0 ? <Tag color="processing">待确认 {row.draftCount}</Tag> : null}
        </Space>
      ),
    },
    { title: '最近变更', dataIndex: 'lastChangedAt', width: 170, render: (value: string | null) => timeText(value) },
  ]
}

function Summary({ data, active, onPick }: { data: CostListResponse; active?: string; onPick: (coverage: CostCoverage | undefined) => void }) {
  return (
    <Space wrap style={{ marginBottom: 8 }} data-testid="cost-summary">
      {COST_COVERAGES.map(coverage => (
        <Tag.CheckableTag key={coverage} checked={active === coverage} onChange={checked => onPick(checked ? coverage : undefined)}>
          {COST_COVERAGE_LABEL[coverage]} {data.summary[coverage]}
        </Tag.CheckableTag>
      ))}
      <Muted>有待确认草稿的 SKU：{data.draftSkus} 个</Muted>
    </Space>
  )
}

export default function CostsPage() {
  const [coverage, setCoverage] = useState<CostCoverage>()
  const [draft, setDraft] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [q, setQ] = useState<string>()
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const [sku, setSku] = useState<string | null>(null)
  const reset = () => setStack([undefined])
  const list = useApiQuery<CostListResponse>({
    domain: 'list',
    path: '/costs',
    params: { coverage, draft: draft ? true : undefined, q, pageSize, cursor: stack[stack.length - 1] },
    scoped: false,
  })
  const data = list.data
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null
  const columns = useMemo(() => columnsOf(setSku), [])

  return (
    <div>
      <PageHeader
        title="商品成本"
        description="每个 SKU 当前生效的成本：采购单价、头程分摊、关税、其他成本，以及折合美元的到岸成本。成本版本只增不改，草稿确认生效后才参与利润计价，已关账期间的利润不受之后的变更影响。"
        actions={
          <Space>
            <CostCreateAction canWrite={data?.canWrite ?? false} today={data?.today ?? ''} />
            <CostImportAction canWrite={data?.canWrite ?? false} />
          </Space>
        }
      />
      <Card size="small">
        {data ? (
          <Summary
            data={data}
            active={coverage}
            onPick={value => {
              setCoverage(value)
              reset()
            }}
          />
        ) : null}
        {data?.truncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="SKU 或版本太多，只汇总了前面一部分；请用搜索或筛选缩小范围" /> : null}
        <Space wrap style={{ margin: '8px 0' }}>
          <Input.Search
            allowClear
            aria-label="搜索 SKU"
            placeholder="搜索 SKU"
            style={{ width: 220 }}
            value={keyword}
            onChange={event => setKeyword(event.target.value)}
            onSearch={value => {
              setQ(value.trim() || undefined)
              reset()
            }}
          />
          <Pick
            label="覆盖状态"
            value={coverage}
            options={COST_COVERAGES.map(value => ({ value, label: COST_COVERAGE_LABEL[value] }))}
            onChange={value => {
              setCoverage(value as CostCoverage | undefined)
              reset()
            }}
          />
          <Checkbox
            checked={draft}
            onChange={event => {
              setDraft(event.target.checked)
              reset()
            }}
          >
            只看有待确认草稿的
          </Checkbox>
          <Pick
            label="每页条数"
            value={String(pageSize)}
            options={PAGE_SIZES.map(size => ({ value: String(size), label: `${size} 条/页` }))}
            onChange={value => {
              setPageSize(Number(value ?? PAGE_SIZES[0]))
              reset()
            }}
          />
        </Space>
        <SimpleGrid<CostRow>
          gridId="costs.costs-page"
          columns={columns}
          rows={data?.items}
          rowKey={row => row.sku}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => void list.refetch()}
          emptyState={{ kind: 'empty', domain: '商品成本', prerequisite: data?.note ?? '尚无记录：还没有商品，也没有成本版本' }}
        />
        <Pager stack={stack} next={next} busy={list.isFetching} onStack={setStack} />
      </Card>
      <CostDetailDrawer sku={sku} onClose={() => setSku(null)} />
    </div>
  )
}
