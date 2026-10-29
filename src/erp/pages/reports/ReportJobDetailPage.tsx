import { useParams } from '@tanstack/react-router'
import { Alert, Descriptions, Timeline } from 'antd'
import { REPORT_SOURCE_LABEL, type ReportDetailResponse, type ReportTimelineItem } from '@nova/api-contracts'
import { DataState, DetailLayout, stateFromError } from '../../components'
import type { IdentityMetric } from '../../components/detail/DetailLayout'
import { formatDateTime } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { FailureText, ReportActions, ReportStatusTag, fileText, parseText, retentionText, rowsText } from './reports-ui'

// 报告任务详情（P5-03，09 章 9.3）：身份区 ≤6 项 → 请求参数 / 亚马逊侧状态时间线 / 导入统计与解析警告 / 关联同步任务。
// 时间线只记录真实发生过的事件；广告报告与数据中心任务没有逐阶段的亚马逊侧状态，页面用说明告知，不编造阶段。
// 新增与更新行数导入器不区分，写“未区分”；失败行数只对已完成的任务有意义（一个批次失败整份报告失败）。

const metricsOf = (detail: ReportDetailResponse): IdentityMetric[] => {
  const row = detail.report
  return [
    { label: '状态', value: <ReportStatusTag row={row} /> },
    { label: '来源', value: REPORT_SOURCE_LABEL[row.source] },
    { label: '数据周期', value: row.periodText },
    { label: '文件', value: fileText(row) },
    { label: '解析', value: parseText(row) },
    { label: '导入行数', value: rowsText(row.importedRows) },
  ]
}

const maybe = (value: string | null | undefined) => value || <Muted>尚无记录</Muted>
const list = (values: string[]) => (values.length ? values.join('、') : <Muted>尚无记录</Muted>)

function RequestTab({ detail }: { detail: ReportDetailResponse }) {
  const { report: row, request, syncJob } = detail
  return (
    <div>
      <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered data-testid="report-request">
        <Descriptions.Item label="报告">{row.label}</Descriptions.Item>
        <Descriptions.Item label="类型编号">{row.reportKey}</Descriptions.Item>
        <Descriptions.Item label="店铺">{maybe(row.storeName)}</Descriptions.Item>
        <Descriptions.Item label="站点">{maybe(request.marketplaceId)}</Descriptions.Item>
        <Descriptions.Item label="申请条件" span={2}>
          {row.requirement}
        </Descriptions.Item>
        <Descriptions.Item label="数据周期">{row.periodText}</Descriptions.Item>
        <Descriptions.Item label="创建人">{row.createdByName ?? <Muted>系统</Muted>}</Descriptions.Item>
        <Descriptions.Item label="创建时间">{timeText(row.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="亚马逊报告编号">{maybe(request.externalReportId)}</Descriptions.Item>
        <Descriptions.Item label="请求编号">{request.requestId}</Descriptions.Item>
        <Descriptions.Item label="第几次尝试">{row.attempt}</Descriptions.Item>
        <Descriptions.Item label="重试自">
          {row.retryOfId ? (
            <LiveLink component="ReportJobDetailPage" id={row.retryOfId}>
              上一次任务
            </LiveLink>
          ) : (
            <Muted>首次创建</Muted>
          )}
        </Descriptions.Item>
        {request.adProduct ? <Descriptions.Item label="广告产品">{request.adProduct}</Descriptions.Item> : null}
        {request.dimensions.length || request.metrics.length ? (
          <Descriptions.Item label="维度与指标" span={2}>
            维度：{list(request.dimensions)}；指标：{list(request.metrics)}
          </Descriptions.Item>
        ) : null}
        {request.dataset ? <Descriptions.Item label="数据集">{request.dataset}</Descriptions.Item> : null}
        {request.params
          ? Object.entries(request.params).map(([key, value]) => (
              <Descriptions.Item key={key} label={key}>
                {value}
              </Descriptions.Item>
            ))
          : null}
        <Descriptions.Item label="原始文件">
          {fileText(row)}（保留期至 {retentionText(row)}）
        </Descriptions.Item>
        <Descriptions.Item label="失败原因">
          <FailureText row={row} />
        </Descriptions.Item>
      </Descriptions>
      <div style={{ marginTop: 12 }} data-testid="sync-job">
        <h4>关联的同步任务</h4>
        {syncJob ? (
          <Descriptions size="small" column={{ xs: 1, md: 3 }}>
            <Descriptions.Item label="任务类型">{syncJob.type}</Descriptions.Item>
            <Descriptions.Item label="状态">{syncJob.status}</Descriptions.Item>
            <Descriptions.Item label="尝试次数">{syncJob.attempts}</Descriptions.Item>
            <Descriptions.Item label="失败码">{maybe(syncJob.failureCode)}</Descriptions.Item>
            <Descriptions.Item label="开始">{timeText(syncJob.startedAt)}</Descriptions.Item>
            <Descriptions.Item label="结束">{timeText(syncJob.finishedAt)}</Descriptions.Item>
          </Descriptions>
        ) : (
          <Muted>没有关联的同步任务（检索类与历史任务不经过同步任务）</Muted>
        )}
      </div>
    </div>
  )
}

function Events({ items, empty, testId }: { items: ReportTimelineItem[]; empty: string; testId: string }) {
  if (!items.length) return <Muted>{empty}</Muted>
  return (
    <Timeline
      data-testid={testId}
      items={items.map((item, index) => ({
        key: `${item.stage}-${index}`,
        color: item.stage === 'FAILED' ? 'red' : item.stage === 'IMPORTED' ? 'green' : 'blue',
        children: (
          <span>
            {item.label}
            <span className="erp-num" style={{ marginLeft: 8 }}>
              {formatDateTime(item.at)}
            </span>
            {item.text ? <div style={{ fontSize: 12 }}>{item.text}</div> : null}
          </span>
        ),
      }))}
    />
  )
}

function TimelineTab({ detail }: { detail: ReportDetailResponse }) {
  const amazon = detail.timeline.filter(item => item.side === 'AMAZON')
  const local = detail.timeline.filter(item => item.side === 'LOCAL')
  return (
    <div>
      <h4>亚马逊侧状态</h4>
      <Events items={amazon} testId="amazon-timeline" empty="尚无亚马逊侧状态：任务还没有向亚马逊申请，或这类任务没有逐阶段的状态记录" />
      <h4>本系统处理过程</h4>
      <Events items={local} testId="local-timeline" empty="尚无记录" />
    </div>
  )
}

function StatsTab({ detail }: { detail: ReportDetailResponse }) {
  const { stats, warnings } = detail
  return (
    <div>
      <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered data-testid="report-stats">
        <Descriptions.Item label="读到行数">{rowsText(stats.read)}</Descriptions.Item>
        <Descriptions.Item label="导入行数">{rowsText(stats.imported)}</Descriptions.Item>
        <Descriptions.Item label="跳过行数">{rowsText(stats.skipped)}</Descriptions.Item>
        <Descriptions.Item label="忽略行数">{rowsText(stats.ignored)}</Descriptions.Item>
        <Descriptions.Item label="新增 / 更新">未区分（导入器只统计写入的总行数）</Descriptions.Item>
        <Descriptions.Item label="失败行数">{rowsText(stats.failed)}</Descriptions.Item>
      </Descriptions>
      <h4 style={{ marginTop: 12 }}>解析警告</h4>
      {warnings.length ? (
        <div data-testid="report-warnings">
          {warnings.map(item => (
            <Alert key={`${item.code}-${item.message}`} type="warning" showIcon style={{ marginBottom: 8 }} message={item.message} />
          ))}
        </div>
      ) : (
        <Muted>没有解析警告（只检测字段名与上一份相比的新增和消失，不检测取值）</Muted>
      )}
    </div>
  )
}

export default function ReportJobDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const query = useApiQuery<ReportDetailResponse>({
    domain: 'list',
    path: `/reports/${encodeURIComponent(id)}`,
    scoped: false,
    refetchIntervalMs: data => (data && (data.report.status === 'PENDING' || data.report.status === 'GENERATING') ? 5000 : false),
  })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'reports.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />

  const detail = query.data
  return (
    <div>
      {detail.notes.map(note => (
        <Alert key={note} type="info" showIcon style={{ marginBottom: 8 }} message={note} data-testid="report-note" />
      ))}
      <DetailLayout
        title={`报告任务：${detail.report.label}`}
        subtitle={detail.report.periodText}
        metrics={metricsOf(detail)}
        primaryActions={<ReportActions row={detail.report} onChanged={() => void query.refetch()} />}
        tabs={[
          { key: 'request', label: '请求参数', children: <RequestTab detail={detail} /> },
          { key: 'timeline', label: '时间线', children: <TimelineTab detail={detail} /> },
          { key: 'stats', label: '导入统计与警告', children: <StatsTab detail={detail} /> },
        ]}
      />
    </div>
  )
}
