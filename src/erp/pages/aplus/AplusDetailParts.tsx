import type { ReactNode } from 'react'
import { Alert, Button, Card, Tag, Timeline, Typography } from 'antd'
import { APLUS_LIMITS, aplusFailureText, type AplusAsinRow, type AplusRejection, type AplusRunRow, type AplusTimelineEvent } from '@nova/api-contracts'
import { formatDateTime } from '../../format'
import { NONE_TEXT } from './aplus-format'
import { Basis, NONE, StatusTag } from './aplus-ui'
import { SimpleGrid } from '../../components'

// 详情页的几个分区（P4-14）：被拒区块、关联 ASIN、审核时间线、写入记录。没有数据一律写“尚无记录”。

export function RejectionBlock({ rejection }: { rejection: AplusRejection }) {
  return (
    <Alert
      data-testid="aplus-rejection"
      type="error"
      showIcon
      style={{ marginTop: 8, border: '2px solid #cf1322' }}
      message="这份内容被亚马逊拒绝，请按下面的原因修改后重新提交"
      description={
        <div>
          <div style={{ whiteSpace: 'pre-wrap' }}>拒绝原文：{rejection.reason ?? '亚马逊没有返回拒绝原因，请到卖家后台查看'}</div>
          {rejection.advice.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              修复建议：
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {rejection.advice.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <Basis>{rejection.adviceBasis}</Basis>
        </div>
      }
    />
  )
}

export function AsinsCard({ asins, truncated, action }: { asins: readonly AplusAsinRow[]; truncated: boolean; action: ReactNode }) {
  return (
    <Card size="small" title="关联 ASIN" style={{ marginTop: 8 }} extra={action} data-testid="aplus-asins">
      <SimpleGrid<AplusAsinRow>
        gridId="aplus.aplus-detail-parts"
        columns={[
          { title: 'ASIN', dataIndex: 'asin', width: 140 },
          { title: '标题', key: 'title', render: (_v, row) => row.title ?? NONE },
          { title: '上线时间', key: 'publishedAt', width: 180, render: (_v, row) => (row.publishedAt ? formatDateTime(row.publishedAt) : NONE) },
        ]}
        rows={[...asins]}
        rowKey={row => row.asin}
        emptyState={{ kind: 'empty', domain: '关联 ASIN', prerequisite: '还没有关联 ASIN' }}
      />
      {truncated ? <Typography.Text type="secondary">关联的 ASIN 很多，只显示了前 {APLUS_LIMITS.asinsShown} 个</Typography.Text> : null}
    </Card>
  )
}

const SOURCE_LABEL: Record<AplusTimelineEvent['source'], string> = { SYNC: '亚马逊同步', LOCAL: '本系统操作' }

export function TimelineCard({ events }: { events: readonly AplusTimelineEvent[] }) {
  return (
    <Card size="small" title="审核时间线" style={{ marginTop: 8 }} data-testid="aplus-timeline">
      {events.length === 0 ? (
        <Typography.Text type="secondary">{NONE_TEXT}：还没有状态变化记录</Typography.Text>
      ) : (
        <Timeline
          items={events.map(event => ({
            color: event.status === 'REJECTED' ? 'red' : event.status === 'PUBLISHED' || event.status === 'APPROVED' ? 'green' : 'blue',
            children: (
              <div>
                <StatusTag status={event.status} label={event.statusLabel} />
                <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.55)' }}>
                  {formatDateTime(event.occurredAt)} · {SOURCE_LABEL[event.source]}
                </span>
                {event.message ? <div style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{event.message}</div> : null}
              </div>
            ),
          }))}
        />
      )}
      {events.length >= APLUS_LIMITS.timelineMax ? <Typography.Text type="secondary">只显示最近 {APLUS_LIMITS.timelineMax} 条</Typography.Text> : null}
    </Card>
  )
}

const RUN_COLOR: Record<AplusRunRow['status'], string> = { QUEUED: 'default', RUNNING: 'processing', SUCCEEDED: 'green', FAILED: 'red' }

export function RunsCard({ runs, busy, expired, onRefresh, refreshing }: { runs: readonly AplusRunRow[]; busy: boolean; expired: boolean; onRefresh: () => void; refreshing: boolean }) {
  return (
    <Card
      size="small"
      title="写入记录"
      style={{ marginTop: 8 }}
      data-testid="aplus-runs"
      extra={
        busy ? (
          <Button size="small" onClick={onRefresh} loading={refreshing}>
            刷新
          </Button>
        ) : null
      }
    >
      {busy ? (
        <Typography.Paragraph type="secondary" style={{ margin: '0 0 8px' }}>
          {expired ? '已停止自动刷新，请手动点“刷新”看结果' : '有写入正在处理，每 5 秒自动刷新一次（最多 2 分钟）'}
        </Typography.Paragraph>
      ) : null}
      <SimpleGrid<AplusRunRow>
        gridId="aplus.aplus-detail-parts-2"
        columns={[
          { title: '类型', dataIndex: 'kindLabel', width: 110 },
          { title: '状态', key: 'status', width: 90, render: (_v, row) => <Tag color={RUN_COLOR[row.status]}>{row.statusLabel}</Tag> },
          { title: '失败原因', key: 'failure', width: 260, render: (_v, row) => (row.status === 'FAILED' ? (row.failureText ?? aplusFailureText(row.failureCode) ?? '失败原因尚无记录') : NONE) },
          {
            title: '警告',
            key: 'warnings',
            render: (_v, row) =>
              row.warnings.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {row.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              ) : (
                NONE
              ),
          },
          { title: '提交人', key: 'by', width: 100, render: (_v, row) => row.requestedBy ?? NONE },
          { title: '提交时间', key: 'createdAt', width: 170, render: (_v, row) => formatDateTime(row.createdAt) },
          { title: '完成时间', key: 'finishedAt', width: 170, render: (_v, row) => (row.finishedAt ? formatDateTime(row.finishedAt) : NONE) },
        ]}
        rows={[...runs]}
        rowKey={row => row.id}
        emptyState={{ kind: 'empty', domain: '写入记录', prerequisite: '还没有写入过' }}
      />
    </Card>
  )
}
