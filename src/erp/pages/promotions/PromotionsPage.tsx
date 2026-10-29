import { useState } from 'react'
import { Alert, Card, Input, Space, Tabs } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  PROMOTION_STATUSES,
  PROMOTION_STATUS_LABEL,
  PROMOTION_TYPES,
  PROMOTION_TYPE_LABEL,
  PROMOTIONS_WRITE_NOTE,
  budgetTextOf,
  type PromotionListResponse,
  type PromotionRow,
} from '@nova/api-contracts'
import { FreshnessBar, PageHeader, SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { PAGE_SIZES, Pager, Pick } from '../reimbursements/reimbursements-ui'
import { PromotionStackingPanel } from './promotion-stacking-panel'
import { PromotionStatusTag, SyncNotice, countOr, platformFeeCell, reportedCell } from './promotions-ui'

// 促销与优惠券（P4-05，04 章 4.8）：亚马逊促销接口里的秒杀、优惠券、价格折扣、满减，只读同步（每日）。
// 亚马逊接口只提供查询，不支持创建、修改或取消：所有改动都在卖家后台进行，这里用来看进度、绩效、平台费用与问题。
// 绩效来自促销绩效报告与优惠券绩效报告（按映射编号关联），平台费用按所选商品与活动期间从费用事件归集；没有记录写原因，不写 0。

const problemText = (row: PromotionRow) =>
  row.errorCount + row.warningCount === 0 ? (
    <Muted>无</Muted>
  ) : (
    <span className="erp-num">{[row.errorCount ? `${row.errorCount} 个错误` : null, row.warningCount ? `${row.warningCount} 个警告` : null].filter(Boolean).join('、')}</span>
  )

const columns: ColumnsType<PromotionRow> = [
  {
    title: '促销',
    dataIndex: 'title',
    width: 280,
    fixed: 'left',
    render: (value: string, row) => (
      <div>
        <LiveLink component="PromotionDetailPage" id={row.id}>
          {value}
        </LiveLink>
        <div>
          <Muted>{row.promotionId}</Muted>
        </div>
      </div>
    ),
  },
  { title: '类型', dataIndex: 'typeLabel', width: 100 },
  { title: '状态', dataIndex: 'status', width: 100, render: (_value, row) => <PromotionStatusTag row={row} /> },
  { title: '店铺', dataIndex: 'storeName', width: 120 },
  { title: '开始时间', dataIndex: 'startAt', width: 170, render: (value: string | null) => timeText(value) },
  { title: '结束时间', dataIndex: 'endAt', width: 170, render: (value: string | null) => (value ? timeText(value) : <Muted>长期有效</Muted>) },
  { title: '折扣力度', dataIndex: 'discountText', width: 150, render: (value: string | null) => value ?? <Muted>未提供</Muted> },
  { title: '预算', key: 'budget', width: 110, render: (_value, row) => budgetTextOf(row.budget) ?? <Muted>未设置</Muted> },
  {
    title: '商品数',
    dataIndex: 'itemCount',
    width: 100,
    align: 'right',
    render: (value: number | null, row) => (row.selectionType === 'CATALOG' ? <Muted>整个目录</Muted> : value === null ? <Muted>尚未同步</Muted> : countOr(value)),
  },
  { title: '报告销量', key: 'units', width: 100, align: 'right', render: (_value, row) => reportedCell(row.reported, item => item.units) },
  { title: '报告销售额', key: 'sales', width: 120, align: 'right', render: (_value, row) => reportedCell(row.reported, item => item.sales, true) },
  { title: '使用次数', key: 'redemptions', width: 100, align: 'right', render: (_value, row) => reportedCell(row.reported, item => item.redemptions) },
  { title: '平台费用', key: 'fee', width: 120, align: 'right', render: (_value, row) => platformFeeCell(row.platformFee) },
  { title: '问题', key: 'problems', width: 150, render: (_value, row) => problemText(row) },
]

export default function PromotionsPage() {
  const [tab, setTab] = useState<'list' | 'stacking'>('list')
  const [status, setStatus] = useState<string>()
  const [type, setType] = useState<string>()
  const [keyword, setKeyword] = useState('')
  const [q, setQ] = useState<string>()
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const reset = () => setStack([undefined])
  const list = useApiQuery<PromotionListResponse>({ domain: 'list', path: '/promotions', params: { status, type, q, pageSize, cursor: stack[stack.length - 1] } })
  const data = list.data
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null

  return (
    <div>
      <PageHeader title="促销与优惠券" description="亚马逊促销接口里的秒杀、优惠券、价格折扣与满减，只读同步（每日）。创建与调整请在卖家后台进行；这里用来看进度、绩效、平台费用与问题。" />
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message={PROMOTIONS_WRITE_NOTE} data-testid="promotions-readonly" />
      <Tabs
        activeKey={tab}
        onChange={key => setTab(key as 'list' | 'stacking')}
        items={[
          { key: 'list', label: '促销列表' },
          { key: 'stacking', label: '叠加情况' },
        ]}
      />
      {tab === 'stacking' ? (
        <Card size="small">
          <PromotionStackingPanel />
        </Card>
      ) : (
        <Card size="small">
          {data ? <SyncNotice sync={data.sync} /> : null}
          <FreshnessBar freshness={data?.freshness} />
          {data ? <Muted>{data.basis}</Muted> : null}
          <Space wrap style={{ margin: '8px 0', display: 'flex' }}>
            <Input.Search
              allowClear
              aria-label="搜索促销"
              placeholder="搜索标题或促销编号"
              style={{ width: 240 }}
              value={keyword}
              onChange={event => setKeyword(event.target.value)}
              onSearch={value => {
                setQ(value.trim() || undefined)
                reset()
              }}
            />
            <Pick
              label="促销类型"
              value={type}
              options={PROMOTION_TYPES.map(value => ({ value, label: PROMOTION_TYPE_LABEL[value] }))}
              onChange={value => {
                setType(value)
                reset()
              }}
            />
            <Pick
              label="促销状态"
              value={status}
              options={PROMOTION_STATUSES.map(value => ({ value, label: PROMOTION_STATUS_LABEL[value] }))}
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
          <SimpleGrid<PromotionRow>
            gridId="promotions.promotions-page"
            columns={columns}
            rows={data?.items}
            rowKey={row => row.id}
            loading={list.isFetching}
            error={list.error}
            onRetry={() => void list.refetch()}
            emptyState={{
              kind: 'empty',
              domain: '促销',
              prerequisite: (data?.state === 'ROLE_PENDING' ? '未授权：申请方式见上方说明' : data?.note) ?? '尚无记录：亚马逊促销接口里没有这个店铺的促销',
            }}
          />
          <Pager stack={stack} next={next} busy={list.isFetching} onStack={setStack} />
        </Card>
      )}
    </div>
  )
}
