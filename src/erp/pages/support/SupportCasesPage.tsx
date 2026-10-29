import { useState } from 'react'
import { Card, Input, Space } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { SUPPORT_CASE_STATUSES, SUPPORT_STATUS_LABEL, type SupportCaseListResponse, type SupportCaseRow } from '@nova/api-contracts'
import { FreshnessBar, PageHeader, SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { PAGE_SIZES, Pager, Pick } from '../reimbursements/reimbursements-ui'
import { SupportStatusTag, SyncNotice, contactCountText } from './support-ui'

// 支持案件（P2b-04，07 章 7.4）：亚马逊卖家支持里的案件，只读同步，每 2 小时一次。回复、传附件、预约回电都在卖家后台进行。
// 需要亚马逊批准“卖家支持”受限角色；没批时同步失败码 SUP_ROLE_PENDING，页面显示申请方式，赔付案件里的案件编号仍可手工回填。

const columns: ColumnsType<SupportCaseRow> = [
  {
    title: '案件编号',
    dataIndex: 'caseId',
    width: 150,
    fixed: 'left',
    render: (value: string, row) => (
      <LiveLink component="SupportCaseDetailPage" id={row.id}>
        {value}
      </LiveLink>
    ),
  },
  { title: '主题', dataIndex: 'subject', width: 320, ellipsis: true },
  { title: '店铺', dataIndex: 'storeName', width: 130 },
  { title: '状态', dataIndex: 'status', width: 130, render: (_value, row) => <SupportStatusTag row={row} /> },
  { title: '创建时间', dataIndex: 'createdAt', width: 170, render: (value: string) => timeText(value) },
  { title: '最近更新', dataIndex: 'updatedAt', width: 170, render: (value: string) => timeText(value) },
  { title: '解决时间', dataIndex: 'resolvedAt', width: 170, render: (value: string | null) => timeText(value) },
  { title: '沟通条数', dataIndex: 'contactCount', width: 100, align: 'right', render: (value: number | null) => contactCountText(value) },
  {
    title: '赔付案件',
    key: 'reimbursement',
    width: 170,
    render: (_value, row) =>
      row.reimbursementCaseId ? (
        <LiveLink component="ReimbursementDetailPage" id={row.reimbursementCaseId}>
          {row.reimbursementCaseNo}
        </LiveLink>
      ) : (
        <Muted>尚无关联</Muted>
      ),
  },
]

export default function SupportCasesPage() {
  const [status, setStatus] = useState<string>()
  const [keyword, setKeyword] = useState('')
  const [q, setQ] = useState<string>()
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const reset = () => setStack([undefined])
  const list = useApiQuery<SupportCaseListResponse>({ domain: 'list', path: '/support-cases', params: { status, q, pageSize, cursor: stack[stack.length - 1] } })
  const data = list.data
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null

  return (
    <div>
      <PageHeader title="支持案件" description="亚马逊卖家支持里的案件，只读同步（每 2 小时）。回复、上传附件、预约回电请在卖家后台进行；这里用来查看进度和沟通历史，并关联到赔付案件。" />
      <Card size="small">
        {data ? <SyncNotice sync={data.sync} /> : null}
        <FreshnessBar freshness={data?.freshness} />
        <Space wrap style={{ margin: '8px 0' }}>
          <Input.Search
            allowClear
            aria-label="搜索支持案件"
            placeholder="搜索主题或案件编号"
            style={{ width: 240 }}
            value={keyword}
            onChange={event => setKeyword(event.target.value)}
            onSearch={value => {
              setQ(value.trim() || undefined)
              reset()
            }}
          />
          <Pick
            label="案件状态"
            value={status}
            options={SUPPORT_CASE_STATUSES.map(value => ({ value, label: SUPPORT_STATUS_LABEL[value] }))}
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
        <SimpleGrid<SupportCaseRow>
          gridId="support.support-cases-page"
          columns={columns}
          rows={data?.items}
          rowKey={row => row.id}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => void list.refetch()}
          emptyState={{
            kind: 'empty',
            domain: '支持案件',
            prerequisite: (data?.state === 'ROLE_PENDING' ? '未授权：申请方式见上方说明' : data?.note) ?? '尚无记录：这个店铺在亚马逊卖家支持里还没有案件',
          }}
        />
        <Pager stack={stack} next={next} busy={list.isFetching} onStack={setStack} />
      </Card>
    </div>
  )
}
