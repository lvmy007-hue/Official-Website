import { useState } from 'react'
import { Alert, Space, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { OPPORTUNITY_RULES, OPPORTUNITY_RULE_LABEL, OPPORTUNITY_STATUSES, OPPORTUNITY_STATUS_LABEL, type OpportunityListResponse, type OpportunityRow } from '@nova/api-contracts'
import { FreshnessBar, SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { OpportunityActions } from './opportunity-actions'
import { PAGE_SIZES, Pager, Pick, amountOr, dayText } from './reimbursements-ui'

// 赔付机会：系统按 7 类规则识别出的“可能该向亚马逊索赔”的清单。机会不是案件——生成案件才开始跟踪；
// 过了申请期限的机会标为已过期，货件或台账后来自己消除了差异的标为“差异已消除”，都保留可查。

const columns: ColumnsType<OpportunityRow> = [
  { title: '类型', dataIndex: 'ruleLabel', width: 110 },
  { title: '店铺', dataIndex: 'storeName', width: 130 },
  { title: 'SKU', dataIndex: 'sku', width: 150, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
  { title: '数量', dataIndex: 'qty', width: 80, align: 'right', render: (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{value}</span>) },
  { title: '估算金额', key: 'amount', width: 150, align: 'right', render: (_value, row) => amountOr(row.estimatedAmount, row.currency, '无商品成本，无法估算') },
  { title: '申请截止', dataIndex: 'deadlineAt', width: 110, render: dayText },
  {
    title: '状态',
    dataIndex: 'statusLabel',
    width: 110,
    render: (_value, row) => (
      <Tag bordered={false} color={row.status === 'PENDING' ? 'warning' : row.status === 'CASE_CREATED' ? 'processing' : 'default'}>
        {row.statusLabel}
      </Tag>
    ),
  },
  { title: '发现时间', dataIndex: 'detectedAt', width: 110, render: dayText },
  { title: '证据', key: 'evidence', render: (_value, row) => (row.evidence.length ? row.evidence.map(item => item.label).join('；') : <Muted>尚无记录</Muted>) },
  { title: '操作', key: 'op', width: 170, fixed: 'right', render: (_value, row) => <OpportunityActions row={row} /> },
]

export function OpportunitiesTab() {
  const [rule, setRule] = useState<string>()
  const [status, setStatus] = useState<string | undefined>('PENDING')
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const reset = () => setStack([undefined])
  const list = useApiQuery<OpportunityListResponse>({ domain: 'list', path: '/reimbursements/opportunities', params: { rule, status, pageSize, cursor: stack[stack.length - 1] } })
  const data = list.data
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null

  return (
    <div>
      <FreshnessBar freshness={data?.freshness} />
      <Alert
        type="info"
        showIcon
        style={{ margin: '8px 0' }}
        message="机会是系统按规则识别的线索，不代表亚马逊一定会赔付；生成案件后在卖家后台提交，再回填亚马逊案件编号。官方赔付明细报告每天同步，到账会自动匹配到案件。"
      />
      <Space wrap style={{ margin: '8px 0' }}>
        <Pick
          label="机会类型"
          value={rule}
          width={160}
          options={OPPORTUNITY_RULES.map(value => ({ value, label: OPPORTUNITY_RULE_LABEL[value] }))}
          onChange={value => {
            setRule(value)
            reset()
          }}
        />
        <Pick
          label="状态"
          value={status}
          options={OPPORTUNITY_STATUSES.map(value => ({ value, label: OPPORTUNITY_STATUS_LABEL[value] }))}
          onChange={value => {
            setStatus(value)
            reset()
          }}
        />
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
      <SimpleGrid<OpportunityRow>
        gridId="reimbursements.opportunities-tab"
        columns={columns}
        rows={data?.items}
        rowKey={row => row.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        emptyState={{
          kind: 'empty',
          domain: '赔付机会',
          prerequisite:
            data?.note ??
            (rule || status !== 'PENDING' ? '没有符合条件的机会；可以换一个类型或状态。' : '目前没有待处理的赔付机会；货件接收、库存台账、退货、移除订单数据同步后，过了等待期才会识别出机会。'),
        }}
      />
      <Pager stack={stack} next={next} busy={list.isFetching} onStack={setStack} />
    </div>
  )
}
