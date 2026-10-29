import { Alert, Descriptions, Drawer, List, Space, Typography } from 'antd'
import type { FeeEventDetailResponse, FeeEventRow } from '@nova/api-contracts'
import { DataState, stateFromError } from '../../components'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { money, text } from '../orders/orders-ui'
import { ReconciliationTag } from './fee-columns'

// 查看证据（07 章 7.5）：这条费用明细本身、来源交易与关联标识、同一笔交易里的其他明细、对账变更记录；能链到订单时给订单入口。
// 报告类的费用事件（仓储费、入仓不合规）没有来源交易，直接说明来源，不显示空白。

const num = (value: string | null | undefined) => (value ? <span className="erp-num">{value}</span> : <Muted>无</Muted>)

export function FeeEvidenceDrawer({ row, onClose }: { row: FeeEventRow | null; onClose: () => void }) {
  const query = useApiQuery<FeeEventDetailResponse>({ domain: 'list', path: `/finance/events/${encodeURIComponent(row?.id ?? '')}`, scoped: false, enabled: Boolean(row), staleMs: 0 })
  const detail = query.data
  const event = detail?.event ?? row
  return (
    <Drawer open={Boolean(row)} onClose={onClose} width={640} title="费用证据" destroyOnClose>
      {query.error ? <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} /> : null}
      {!detail && !query.error ? <DataState kind="skeleton" rows={6} /> : null}
      {event && detail ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions size="small" column={2} bordered title="费用明细">
            <Descriptions.Item label="费用类型">{event.categoryLabel}</Descriptions.Item>
            <Descriptions.Item label="子类型">{event.subtypeLabel ?? <Muted>无子类型</Muted>}</Descriptions.Item>
            <Descriptions.Item label="金额">{money(event.amount, event.currency)}</Descriptions.Item>
            <Descriptions.Item label="发生时间">{formatDateTime(event.postedAt)}</Descriptions.Item>
            <Descriptions.Item label="店铺">{event.storeName}</Descriptions.Item>
            <Descriptions.Item label="来源">{event.sourceLabel}</Descriptions.Item>
            <Descriptions.Item label="订单号">
              {event.amazonOrderId ? (
                detail.orderId ? (
                  <AppLink to={`/app/orders/${encodeURIComponent(detail.orderId)}`}>{event.amazonOrderId}</AppLink>
                ) : (
                  num(event.amazonOrderId)
                )
              ) : (
                <Muted>无订单</Muted>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="货件">{num(event.shipmentId)}</Descriptions.Item>
            <Descriptions.Item label="ASIN">{num(event.asin)}</Descriptions.Item>
            <Descriptions.Item label="SKU">{num(event.sellerSku)}</Descriptions.Item>
            <Descriptions.Item label="结算单">{event.settlementId ? num(event.settlementId) : <Muted>未关联</Muted>}</Descriptions.Item>
            <Descriptions.Item label="对账状态">
              <ReconciliationTag row={event} />
            </Descriptions.Item>
          </Descriptions>

          <div>
            <Typography.Title level={5}>来源交易</Typography.Title>
            {detail.transaction ? (
              <Descriptions size="small" column={2} bordered>
                <Descriptions.Item label="交易编号" span={2}>
                  <span className="erp-num">{detail.transaction.transactionId}</span>
                </Descriptions.Item>
                <Descriptions.Item label="交易类型">{text(detail.transaction.transactionType)}</Descriptions.Item>
                <Descriptions.Item label="交易状态">{detail.transaction.transactionStatusLabel ?? <Muted>状态未知</Muted>}</Descriptions.Item>
                <Descriptions.Item label="交易金额">{money(detail.transaction.amount, detail.transaction.currency)}</Descriptions.Item>
                <Descriptions.Item label="入账时间">{formatDateTime(detail.transaction.postedAt)}</Descriptions.Item>
                <Descriptions.Item label="描述" span={2}>
                  {text(detail.transaction.description)}
                </Descriptions.Item>
                <Descriptions.Item label="关联标识" span={2}>
                  {detail.transaction.relatedIdentifiers.length === 0 ? (
                    <Muted>交易没有带关联标识</Muted>
                  ) : (
                    detail.transaction.relatedIdentifiers.map(item => (
                      <div key={`${item.name}|${item.value}`} className="erp-num">
                        {item.name}：{item.value}
                      </div>
                    ))
                  )}
                </Descriptions.Item>
              </Descriptions>
            ) : event.source === 'FINANCE_API' ? (
              <Alert type="warning" showIcon message="来源交易记录没有找到" description="这条费用来自财务接口，但对应的交易记录已不在库里（可能超出保留期）；费用明细本身仍然有效。" />
            ) : (
              <Alert type="info" showIcon message={`这条费用来自${event.sourceLabel}，没有对应的交易流水`} description="报告类费用按报告里的行直接记录，没有交易编号与关联标识。" />
            )}
          </div>

          {detail.transaction ? (
            <div>
              <Typography.Title level={5}>同一笔交易里的其他明细</Typography.Title>
              <List
                size="small"
                bordered
                locale={{ emptyText: '这笔交易没有其他费用明细' }}
                dataSource={detail.siblings}
                renderItem={item => (
                  <List.Item>
                    <span>
                      {item.categoryLabel}
                      {item.subtypeLabel ? <span className="erp-num"> · {item.subtypeLabel}</span> : null}
                    </span>
                    {money(item.amount, item.currency)}
                  </List.Item>
                )}
              />
              {detail.siblingsTruncated ? <Muted>只显示前 50 条</Muted> : null}
            </div>
          ) : null}

          <div>
            <Typography.Title level={5}>对账变更记录</Typography.Title>
            {event.reconciliationNote ? (
              <Typography.Paragraph>
                当前备注：<span>{event.reconciliationNote}</span>
              </Typography.Paragraph>
            ) : null}
            <List
              size="small"
              bordered
              locale={{ emptyText: '还没有对账变更' }}
              dataSource={detail.history}
              renderItem={item => (
                <List.Item>
                  <span>{item.title}</span>
                  <Muted>
                    {item.actorName ?? '系统'} · {formatDateTime(item.at)}
                  </Muted>
                </List.Item>
              )}
            />
          </div>
        </Space>
      ) : null}
    </Drawer>
  )
}
