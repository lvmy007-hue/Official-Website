import { useCallback, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { Alert, Card, Descriptions, Drawer, Space, Statistic, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  BATCH_STATUS_LABEL,
  REPLENISH_ACTIONS,
  REPLENISH_ACTION_LABEL,
  REPLENISH_LEVEL_LABEL,
  type BatchDetailResponse,
  type EvaluateResponse,
  type OutcomeRow,
  type RecommendationRow,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { DataState, FormAction, PageHeader, SimplePagedGrid, stateFromError, type PageFetcher, SimpleGrid } from '../../components'
import { formatDateTime, formatNumber, formatPercent } from '../../format'
import { buildPath, useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { recommendationColumns } from './recommendation-columns'
import { RecommendationDetail } from './replenishment-ui'

// 补货批次详情（P2a-07）：冻结的输入（策略版本、数据时间）→ 执行情况（决策、草稿采购单）→ 结果回看（预测对比实际）→ 建议明细。
// 结果回看按需触发：到仓满 7 天且数据覆盖足够才评估；“是否按时到仓”需要入仓计划与货件接收，尚未接入，这里不猜。

const PLAN = 'replenishment.plan.create'
const noop = () => undefined

const outcomeColumns: ColumnsType<OutcomeRow> = [
  { title: 'SKU', dataIndex: 'sku', width: 180 },
  { title: '评估窗口', key: 'window', width: 200, render: (_value, row) => `${row.windowStart} 至 ${row.windowEnd}` },
  { title: '预测件数', dataIndex: 'forecastQty', width: 100, align: 'right', render: (value: number) => <span className="erp-num">{formatNumber(value, { digits: 0 })}</span> },
  { title: '实际件数', dataIndex: 'actualQty', width: 100, align: 'right', render: (value: number) => <span className="erp-num">{formatNumber(value, { digits: 0 })}</span> },
  {
    title: '预测误差',
    dataIndex: 'errorPct',
    width: 100,
    align: 'right',
    render: (value: number | null) => (value === null ? <Muted>实际为 0，无法计算</Muted> : <span className="erp-num">{formatPercent(value, { digits: 1 })}</span>),
  },
  { title: '断货天数', dataIndex: 'stockoutDays', width: 90, align: 'right' },
  {
    title: '多余库存',
    dataIndex: 'excessUnits',
    width: 100,
    align: 'right',
    render: (value: number | null) => (value === null ? <Muted>尚无库存记录</Muted> : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>),
  },
  { title: '评估日', dataIndex: 'evaluatedAt', width: 110 },
]

export default function ReplenishmentBatchDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  // 批次摘要、执行情况与结果回看取自详情响应（只取一行建议）；建议明细由表格按页码另取。
  const detail = useApiQuery<BatchDetailResponse>({ domain: 'list', path: `/replenishment/batches/${encodeURIComponent(id)}`, params: { page: 1, pageSize: 1 }, scoped: false })
  const [opened, setOpened] = useState<RecommendationRow | null>(null)
  const fetchPage = useCallback<PageFetcher<RecommendationRow>>(
    async ({ page, pageSize, signal }) => {
      const response = await apiFetch<BatchDetailResponse>(buildPath(`/replenishment/batches/${encodeURIComponent(id)}`, { page, pageSize }), { signal })
      return { items: response.items, total: response.total }
    },
    [id],
  )
  const evaluate = useApiMutation<Record<string, never>, EvaluateResponse>({
    method: 'POST',
    path: `/replenishment/batches/${encodeURIComponent(id)}/evaluate`,
    invalidate: ['list', 'analytics'],
    silent: true,
  })
  const [note, setNote] = useState<string | null>(null)

  if (detail.error) return <DataState {...stateFromError(describeError(detail.error), { permission: 'replenishment.read', onRetry: () => void detail.refetch() })} />
  if (detail.isPending || !detail.data) return <DataState kind="skeleton" rows={6} />

  const { batch, snapshot, execution, review } = detail.data
  const actionTags = REPLENISH_ACTIONS.filter(action => execution.actionCounts[action] > 0)

  return (
    <div>
      <PageHeader
        title={`补货批次 ${batch.batchNo}`}
        description={`${batch.today} 计算，由 ${batch.computedBy} 在 ${formatDateTime(batch.computedAt)} 发起；批次冻结了当时的策略版本与数据，之后改策略不影响它。`}
        actions={<Tag color="blue">{BATCH_STATUS_LABEL[batch.status]}</Tag>}
      />
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Card size="small" title="冻结的输入">
          <Descriptions size="small" column={2}>
            <Descriptions.Item label="SKU 总数">{batch.skuTotal}</Descriptions.Item>
            <Descriptions.Item label="产出建议">{batch.recommendedCount}</Descriptions.Item>
            <Descriptions.Item label="库存更新于">{snapshot.dataTimes.inventoryUpdatedAt ? formatDateTime(snapshot.dataTimes.inventoryUpdatedAt) : '尚无记录'}</Descriptions.Item>
            <Descriptions.Item label="亚马逊补货建议快照">{snapshot.dataTimes.restockSnapshotDate ?? '尚无记录'}</Descriptions.Item>
            <Descriptions.Item label="使用的策略版本" span={2}>
              {batch.policyVersions.length === 0 ? (
                <Muted>没有策略</Muted>
              ) : (
                batch.policyVersions.map(item => (
                  <Tag key={`${item.level}:${item.levelRef}`}>
                    {REPLENISH_LEVEL_LABEL[item.level]}
                    {item.level === 'TENANT' ? '' : ` ${item.levelRef}`} 第 {item.versionNo} 版
                  </Tag>
                ))
              )}
            </Descriptions.Item>
          </Descriptions>
        </Card>

        <Card size="small" title="执行情况">
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Space wrap>
              {actionTags.length === 0 ? (
                <Muted>尚未做任何决策</Muted>
              ) : (
                actionTags.map(action => (
                  <Tag key={action}>
                    {REPLENISH_ACTION_LABEL[action]} {execution.actionCounts[action]}
                  </Tag>
                ))
              )}
            </Space>
            {execution.purchaseOrders.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {execution.purchaseOrders.map(order => (
                  <li key={order.id}>
                    采购单草稿 {order.number}（{order.status}，{order.lineCount} 行）
                  </li>
                ))}
              </ul>
            ) : null}
            {execution.awdOrders.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {execution.awdOrders.map(order => (
                  <li key={order.id}>
                    <LiveLink component="AwdOrderDetailPage" id={order.id}>
                      上游仓储入库订单 {order.reference ?? order.id}
                    </LiveLink>
                    （{order.statusLabel}，{order.lineCount} 个 SKU）
                  </li>
                ))}
              </ul>
            ) : null}
            {execution.inboundPlans.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {execution.inboundPlans.map(plan => (
                  <li key={plan.id}>
                    <LiveLink component="InboundPlanDetailPage" id={plan.id}>
                      入仓计划草稿 {plan.name}
                    </LiveLink>
                    （{plan.stageLabel}，{plan.skuCount} 个 SKU，共 {formatNumber(plan.totalUnits, { digits: 0 })} 件，发货地址：{plan.shipFromAddressName ?? '未记录'}）
                  </li>
                ))}
              </ul>
            ) : null}
            {execution.pendingTargets > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={`有 ${execution.pendingTargets} 条动作只登记了、没有生成单据`}
                description="这些是以前登记的意向。现在可以到“补货建议”页点“补建入仓草稿”，按店铺的发货地址一键生成。"
              />
            ) : null}
          </Space>
        </Card>

        <Card
          size="small"
          title="结果回看"
          extra={
            <FormAction
              label="评估预测误差"
              guard={{ permission: PLAN }}
              title="评估预测误差"
              description="到仓满 7 天且这段时间的订单数据覆盖足够时才会评估；不满足的建议会被跳过并说明原因。"
              okText="开始评估"
              buttonProps={{ size: 'small' }}
              onSubmit={async () => setNote((await evaluate.mutateAsync({})).note)}
            />
          }
        >
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {note ? <Alert type="info" showIcon message={note} closable onClose={() => setNote(null)} /> : null}
            <Space size={32}>
              <Statistic title="已评估" value={review.summary.evaluated} suffix="条" />
              <Statistic title="平均绝对误差" value={review.summary.meanAbsErrorPct === null ? '尚无记录' : formatPercent(review.summary.meanAbsErrorPct, { digits: 1 })} />
              <Statistic title="断货天数合计" value={review.summary.evaluated === 0 ? '尚无记录' : review.summary.stockoutDays} />
            </Space>
            <Typography.Text type="secondary">{review.arrival.note}</Typography.Text>
            <SimpleGrid<OutcomeRow>
              gridId="replenishment.replenishment-batch-detail-page"
              columns={outcomeColumns}
              rows={review.outcomes}
              rowKey={row => row.recommendationId}
              emptyState={{ kind: 'empty', domain: '明细', prerequisite: '还没有评估结果' }}
            />
          </Space>
        </Card>

        <Card size="small" title="建议明细">
          <SimplePagedGrid<RecommendationRow>
            gridId="replenishment-batch-items"
            columns={recommendationColumns(noop).filter(column => column.key !== 'simulate')}
            fetchPage={fetchPage}
            rowKey={row => row.id}
            resetKey={id}
            onRowOpen={setOpened}
            emptyState={{ kind: 'empty', domain: '补货建议', prerequisite: '这个批次没有产出建议。' }}
          />
          <Drawer open={opened !== null} onClose={() => setOpened(null)} width={760} title={opened ? `建议明细：${opened.sku}` : null} destroyOnClose>
            {opened ? <RecommendationDetail row={opened} /> : null}
          </Drawer>
        </Card>
      </Space>
    </div>
  )
}
