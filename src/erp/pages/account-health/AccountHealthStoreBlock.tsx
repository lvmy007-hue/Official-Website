import { useMemo } from 'react'
import { Alert, Button, Card, Descriptions, List, Space, Tag, Typography } from 'antd'
import { ACCOUNT_STATUS_LABEL, type AccountHealthStoreView } from '@nova/api-contracts'
import { ChartPanel } from '../../components'
import { Muted } from '../inventory/inventory-ui'
import { buildDefectTrendOption, buildRatingTrendOption } from './account-health-options'
import { AccountStatusTag, MetricTable, valueCell } from './account-health-ui'

// 一个店铺的账户健康块（P5-02，09 章 9.2）：账户状态与变更历史、账户健康评级与趋势、订单缺陷率与构成、政策合规、其他指标。
// 没有数据的店铺只显示原因（未接入、报告接口未授权、已接入但还没同步到），不画空图、不写 0。

const SOURCE_TEXT = { REPORT: '每日报告', PUSH: '状态推送' } as const

function StatusSection({ view }: { view: AccountHealthStoreView }) {
  const { accountStatus: status, statusHistory } = view
  return (
    <Card size="small" title="账户状态" data-testid="account-status">
      <Descriptions size="small" column={{ xs: 1, md: 2 }}>
        <Descriptions.Item label="当前状态">
          <AccountStatusTag status={status.status} />
        </Descriptions.Item>
        <Descriptions.Item label="状态日期">{status.asOf ? <span className="erp-num">{status.asOf}</span> : <Muted>尚无记录</Muted>}</Descriptions.Item>
        <Descriptions.Item label="数据来源">{status.source ? SOURCE_TEXT[status.source] : <Muted>尚无记录</Muted>}</Descriptions.Item>
        <Descriptions.Item label="最近一次变化">
          {status.changedAt && status.previousLabel ? (
            <span>
              {status.previousLabel} → {status.label}（<span className="erp-num">{status.changedAt}</span>）
            </span>
          ) : (
            <Muted>近 90 天没有变化记录</Muted>
          )}
        </Descriptions.Item>
      </Descriptions>
      {statusHistory.length > 1 ? (
        <List
          size="small"
          header="状态变更历史"
          data-testid="status-history"
          dataSource={[...statusHistory].reverse().filter(item => item.previousStatus !== null)}
          renderItem={item => (
            <List.Item>
              <span className="erp-num">{item.date}</span>
              <span style={{ marginLeft: 8 }}>
                {item.previousLabel} → {ACCOUNT_STATUS_LABEL[item.status]}
              </span>
              {item.worse ? (
                <Tag color="warning" bordered={false} style={{ marginLeft: 8 }}>
                  变差
                </Tag>
              ) : null}
            </List.Item>
          )}
        />
      ) : null}
    </Card>
  )
}

function RatingSection({ view }: { view: AccountHealthStoreView }) {
  const option = useMemo(() => buildRatingTrendOption(view.ratingTrend), [view.ratingTrend])
  const { rating } = view
  return (
    <Card size="small" title="账户健康评级" data-testid="account-rating">
      {rating ? (
        <Descriptions size="small" column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label="评分">{rating.score === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{rating.score}</span>}</Descriptions.Item>
          <Descriptions.Item label="评级">{rating.statusLabel ?? <Muted>尚无记录</Muted>}</Descriptions.Item>
        </Descriptions>
      ) : (
        <Muted>报告里没有账户健康评级</Muted>
      )}
      {view.ratingTrend.length > 1 ? <ChartPanel title="评级趋势" ariaLabel="账户健康评级趋势" option={option} height={200} /> : null}
    </Card>
  )
}

function DefectSection({ view }: { view: AccountHealthStoreView }) {
  const { orderDefect } = view
  const option = useMemo(() => buildDefectTrendOption(orderDefect.trend), [orderDefect.trend])
  const points = orderDefect.trend.reduce((most, item) => Math.max(most, item.points.length), 0)
  return (
    <Card size="small" title="订单缺陷率" data-testid="order-defect">
      <MetricTable metrics={orderDefect.metrics} testId="order-defect-metrics" empty="报告没有给出订单缺陷率" />
      <Descriptions size="small" column={{ xs: 1, md: 3 }} title="构成" style={{ marginTop: 12 }} data-testid="odr-breakdown">
        {orderDefect.breakdown.map(item => (
          <Descriptions.Item key={item.key} label={item.label}>
            {item.metric ? valueCell(item.metric) : <Muted>{item.note ?? '尚无记录'}</Muted>}
          </Descriptions.Item>
        ))}
      </Descriptions>
      {points > 1 ? <ChartPanel title="订单缺陷率趋势" ariaLabel="订单缺陷率趋势" option={option} height={220} /> : null}
    </Card>
  )
}

function PolicySection({ view, onOpenIssues }: { view: AccountHealthStoreView; onOpenIssues: () => void }) {
  const { policy } = view
  return (
    <Card
      size="small"
      title="政策合规"
      data-testid="policy-section"
      extra={
        <Button type="link" size="small" onClick={onOpenIssues}>
          查看问题列表
        </Button>
      }
    >
      <Space wrap size={12} style={{ marginBottom: 8 }}>
        <span>
          未解决的问题 <span className="erp-num">{policy.openCount}</span> 条
        </span>
        {policy.openByKind.map(item => (
          <Tag key={item.kind} bordered={false}>
            {item.label} {item.count}
          </Tag>
        ))}
      </Space>
      <MetricTable metrics={policy.metrics} testId="policy-metrics" empty="报告没有给出政策合规指标" />
    </Card>
  )
}

export function AccountHealthStoreBlock({ view, onOpenIssues }: { view: AccountHealthStoreView; onOpenIssues: () => void }) {
  const noData = view.state !== 'OK'
  return (
    <Card
      size="small"
      style={{ marginBottom: 12 }}
      data-testid={`store-block-${view.sellerAccountId}`}
      title={<Typography.Text strong>{view.storeName}</Typography.Text>}
      extra={view.snapshotDate ? <Muted>快照日期 {view.snapshotDate}</Muted> : null}
    >
      {noData ? (
        <Alert
          type={view.state === 'ROLE_PENDING' ? 'warning' : 'info'}
          showIcon
          message={view.state === 'NOT_CONNECTED' ? '尚未接入' : view.state === 'ROLE_PENDING' ? '报告接口未授权' : '暂无数据'}
          description={view.note}
          data-testid="store-no-data"
        />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <StatusSection view={view} />
          <RatingSection view={view} />
          <DefectSection view={view} />
          <PolicySection view={view} onOpenIssues={onOpenIssues} />
          <Card size="small" title="其他指标" data-testid="other-metrics">
            <MetricTable metrics={view.other} testId="other-metrics-table" empty="报告里没有其他指标" />
          </Card>
        </Space>
      )}
    </Card>
  )
}
