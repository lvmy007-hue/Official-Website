import { useState } from 'react'
import { Space } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { CASE_STATUSES, CASE_STATUS_LABEL, CASE_TAB_STATUSES, OPPORTUNITY_RULES, OPPORTUNITY_RULE_LABEL, type CaseListResponse, type CaseRow, type ReimbursementTab } from '@nova/api-contracts'
import { FreshnessBar, SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { PAGE_SIZES, Pager, Pick, CaseStatusTag, amountOr, dayText, receivedText } from './reimbursements-ui'

// 案件列表：待提交、处理中、已到账、已拒绝、全部案件五个视图共用一张表，只是状态范围不同。
// 实收只来自官方赔付明细的自动匹配，页面上没有任何手填实收的入口；没有到账写“尚无到账”。

const EMPTY_HINT: Record<Exclude<ReimbursementTab, 'opportunities'>, string> = {
  pending: '没有待提交的案件。在“赔付机会”里对机会点“生成案件”后，案件会出现在这里。',
  processing: '没有处理中的案件。案件在卖家后台提交后，把状态改成“已提交”并回填亚马逊案件编号。',
  paid: '还没有已到账的案件。官方赔付明细报告每天同步，到账后会自动匹配并标为已到账。',
  rejected: '没有被拒绝的案件。',
  all: '还没有任何案件。',
}

const columns: ColumnsType<CaseRow> = [
  {
    title: '案件编号',
    dataIndex: 'caseNo',
    width: 170,
    fixed: 'left',
    render: (value: string, row) => (
      <LiveLink component="ReimbursementDetailPage" id={row.id}>
        {value}
      </LiveLink>
    ),
  },
  { title: '类型', dataIndex: 'ruleLabel', width: 110 },
  { title: '店铺', dataIndex: 'storeName', width: 130 },
  { title: 'SKU', dataIndex: 'sku', width: 150, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
  { title: '状态', dataIndex: 'status', width: 100, render: (_value, row) => <CaseStatusTag status={row.status} /> },
  { title: '应收', key: 'expected', width: 120, align: 'right', render: (_value, row) => amountOr(row.expectedAmount, row.currency, '尚未填写') },
  { title: '批准', key: 'approved', width: 120, align: 'right', render: (_value, row) => amountOr(row.approvedAmount, row.currency, '尚无记录') },
  { title: '实收', key: 'received', width: 120, align: 'right', render: (_value, row) => receivedText(row.receivedAmount, row.currency) },
  { title: '亚马逊案件编号', dataIndex: 'amazonCaseId', width: 150, render: (value: string | null) => value ?? <Muted>尚未回填</Muted> },
  { title: '负责人', dataIndex: 'ownerName', width: 110 },
  { title: '提交日', dataIndex: 'submittedAt', width: 110, render: dayText },
  { title: '申请截止', dataIndex: 'deadlineAt', width: 110, render: dayText },
]

export function CasesTab({ tab }: { tab: Exclude<ReimbursementTab, 'opportunities'> }) {
  const [rule, setRule] = useState<string>()
  const [status, setStatus] = useState<string>()
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const reset = () => setStack([undefined])
  const statuses = CASE_TAB_STATUSES[tab] ?? CASE_STATUSES
  const list = useApiQuery<CaseListResponse>({ domain: 'list', path: '/reimbursements', params: { tab, rule, status, pageSize, cursor: stack[stack.length - 1] } })
  const data = list.data
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null

  return (
    <div>
      <FreshnessBar freshness={data?.freshness} />
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
        {statuses.length > 1 ? (
          <Pick
            label="案件状态"
            value={status}
            options={statuses.map(value => ({ value, label: CASE_STATUS_LABEL[value] }))}
            onChange={value => {
              setStatus(value)
              reset()
            }}
          />
        ) : null}
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
      <SimpleGrid<CaseRow>
        gridId="reimbursements.cases-tab"
        columns={columns}
        rows={data?.items}
        rowKey={row => row.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        emptyState={{ kind: 'empty', domain: '赔付案件', prerequisite: data?.note ?? (rule || status ? '没有符合条件的案件；可以放宽筛选条件。' : EMPTY_HINT[tab]) }}
      />
      <Pager stack={stack} next={next} busy={list.isFetching} onStack={setStack} />
    </div>
  )
}
