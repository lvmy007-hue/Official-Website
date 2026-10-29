import { useParams } from '@tanstack/react-router'
import { Alert, Descriptions, Tag, Timeline } from 'antd'
import { SYNC_DOMAIN_AVAILABILITY, syncFailureText, type SyncJobDetailResponse, type SyncStepView, type SyncTimelineItem, type SyncWorkflowView } from '@nova/api-contracts'
import { DataState, DetailLayout, stateFromError, SimpleGrid } from '../../components'
import type { IdentityMetric } from '../../components/detail/DetailLayout'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { FailureCell, RetryAction, SyncStateTag, attemptsText, logText, progressText } from './sync-ui'

// 同步任务详情（P5-06，09 章 9.8）：身份区 ≤6 项 → 参数 / 过程时间线与分步 / 写入统计 / 错误详情 / 关联报告任务。
// 时间线只记录真实发生过的事件（开始、等待重试、等待报告、完成、失败、人工重试）；旧任务没有过程记录，页面写“尚无记录”，不编造。
// 写入统计只有同步器返回了数字才有，没有写“尚无统计”，不拿 0 冒充。

const metricsOf = (detail: SyncJobDetailResponse): IdentityMetric[] => {
  const { job } = detail
  return [
    { label: '状态', value: <SyncStateTag row={job} /> },
    { label: '数据域', value: job.domainLabel },
    { label: '店铺', value: job.storeName ?? <Muted>账户级连接</Muted> },
    { label: '尝试次数', value: attemptsText(job) },
    { label: '进度', value: progressText(job) },
    { label: '队列', value: detail.queue },
  ]
}

const TONE_COLOR: Record<SyncTimelineItem['tone'], string> = { default: 'blue', success: 'green', error: 'red', warning: 'orange' }

function ParamsTab({ detail }: { detail: SyncJobDetailResponse }) {
  const { job } = detail
  return (
    <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered data-testid="sync-params">
      {detail.params.map(item => (
        <Descriptions.Item key={item.label} label={item.label}>
          {item.value}
        </Descriptions.Item>
      ))}
      <Descriptions.Item label="请求编号">{job.requestId}</Descriptions.Item>
      <Descriptions.Item label="任务编号">{job.id}</Descriptions.Item>
      <Descriptions.Item label="创建时间">{timeText(job.createdAt)}</Descriptions.Item>
      <Descriptions.Item label="开始时间">{job.startedAt ? timeText(job.startedAt) : <Muted>尚未开始</Muted>}</Descriptions.Item>
      <Descriptions.Item label="结束时间">{job.finishedAt ? timeText(job.finishedAt) : <Muted>尚未结束</Muted>}</Descriptions.Item>
      <Descriptions.Item label="去重来源">{detail.sourceKey ?? <Muted>尚无记录</Muted>}</Descriptions.Item>
      <Descriptions.Item label="断点">{detail.hasCheckpoint ? '已保存（重试时从断点继续）' : <Muted>没有保存断点</Muted>}</Descriptions.Item>
      <Descriptions.Item label="日志摘要">{logText(job)}</Descriptions.Item>
    </Descriptions>
  )
}

const stepColumns = [
  { title: '步骤', dataIndex: 'name', key: 'name' },
  { title: '状态', dataIndex: 'status', key: 'status', width: 110 },
  { title: '尝试', dataIndex: 'attempt', key: 'attempt', width: 70 },
  { title: '开始', key: 'start', width: 160, render: (_value: unknown, step: SyncStepView) => (step.startedAt ? formatDateTime(step.startedAt) : <Muted>尚无记录</Muted>) },
  { title: '结束', key: 'end', width: 160, render: (_value: unknown, step: SyncStepView) => (step.finishedAt ? formatDateTime(step.finishedAt) : <Muted>尚无记录</Muted>) },
  { title: '失败原因', key: 'err', render: (_value: unknown, step: SyncStepView) => (step.errorCode ? syncFailureText(step.errorCode) : <Muted>无</Muted>) },
]

function Workflows({ items }: { items: SyncWorkflowView[] }) {
  if (!items.length) return <Muted>这个任务没有登记流程分步（只有写入类、报告类等多步骤任务才有）</Muted>
  return (
    <div data-testid="sync-workflows">
      {items.map(run => (
        <div key={`${run.kind}-${run.startedAt}`} style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 4 }}>
            <strong>{run.kind}</strong>
            <Tag style={{ marginLeft: 8 }}>{run.status}</Tag>
            <Muted>
              {formatDateTime(run.startedAt)}
              {run.finishedAt ? ` → ${formatDateTime(run.finishedAt)}` : ''}
            </Muted>
          </div>
          <SimpleGrid<SyncStepView>
            gridId="sync.sync-job-detail-page"
            columns={stepColumns}
            rows={run.steps}
            rowKey={row => row.seq}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
          />
        </div>
      ))}
    </div>
  )
}

function TimelineTab({ detail }: { detail: SyncJobDetailResponse }) {
  return (
    <div>
      <h4>过程时间线</h4>
      {detail.timeline.length ? (
        <Timeline
          data-testid="sync-timeline"
          items={detail.timeline.map((item, index) => ({
            key: `${item.at}-${index}`,
            color: TONE_COLOR[item.tone],
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
      ) : (
        <Muted>尚无记录：任务还没有开始执行，或创建于过程记录上线之前</Muted>
      )}
      <h4 style={{ marginTop: 12 }}>流程分步</h4>
      <Workflows items={detail.workflows} />
    </div>
  )
}

function StatsTab({ detail }: { detail: SyncJobDetailResponse }) {
  if (!detail.stats) return <Muted>尚无统计：任务没有记录写入统计（还没完成，或同步器没有返回数字统计）</Muted>
  return (
    <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered data-testid="sync-stats">
      {detail.stats.map(item => (
        <Descriptions.Item key={item.key} label={item.label}>
          <span className="erp-num">{item.value.toLocaleString('zh-CN')}</span>
        </Descriptions.Item>
      ))}
    </Descriptions>
  )
}

function ErrorTab({ detail }: { detail: SyncJobDetailResponse }) {
  const { job, deadLetter, connection } = detail
  return (
    <Descriptions size="small" column={1} bordered data-testid="sync-error">
      <Descriptions.Item label="失败原因">
        <FailureCell row={job} />
      </Descriptions.Item>
      <Descriptions.Item label="失败任务（死信）">
        {deadLetter ? (
          `已进入失败任务：队列 ${deadLetter.queue}，用尽 ${deadLetter.attempts} 次尝试，${timeText(deadLetter.createdAt)}${deadLetter.replayedAt ? `；已于 ${timeText(deadLetter.replayedAt)} 重放` : ''}`
        ) : (
          <Muted>没有</Muted>
        )}
      </Descriptions.Item>
      <Descriptions.Item label="连接状态">
        {connection ? (
          <span>
            {connection.state}
            {connection.lastErrorCode ? `（最近一次错误：${syncFailureText(connection.lastErrorCode)}）` : ''}
          </span>
        ) : (
          <Muted>连接信息暂不可用</Muted>
        )}
      </Descriptions.Item>
      <Descriptions.Item label="数据域可用性">{SYNC_DOMAIN_AVAILABILITY[job.domain].note ?? <Muted>无特别说明</Muted>}</Descriptions.Item>
    </Descriptions>
  )
}

function ReportsTab({ detail }: { detail: SyncJobDetailResponse }) {
  if (!detail.reports.length) return <Muted>没有关联的报告任务（只有报告申请、报告轮询、数据中心查询类的任务才有）</Muted>
  return (
    <ul data-testid="sync-reports" style={{ paddingLeft: 18, margin: 0 }}>
      {detail.reports.map(report => (
        <li key={report.id}>
          <AppLink to={report.path}>{report.label}</AppLink>
          <Tag style={{ marginLeft: 8 }}>{report.status}</Tag>
        </li>
      ))}
    </ul>
  )
}

export default function SyncJobDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const query = useApiQuery<SyncJobDetailResponse>({
    domain: 'list',
    path: `/sync/jobs/${encodeURIComponent(id)}`,
    scoped: false,
    refetchIntervalMs: data => (data && (data.job.state === 'RUNNING' || data.job.state === 'QUEUED' || data.job.state === 'POLL_WAIT' || data.job.state === 'RETRY_WAIT') ? 5000 : false),
  })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'sync.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />

  const detail = query.data
  return (
    <div>
      {detail.notes.map(note => (
        <Alert key={note} type="info" showIcon style={{ marginBottom: 8 }} message={note} data-testid="sync-note" />
      ))}
      <DetailLayout
        title={`同步任务：${detail.job.typeLabel}`}
        subtitle={`${detail.job.domainLabel} · 请求编号 ${detail.job.requestId}`}
        metrics={metricsOf(detail)}
        primaryActions={<RetryAction row={detail.job} onDone={() => void query.refetch()} />}
        tabs={[
          { key: 'params', label: '参数', children: <ParamsTab detail={detail} /> },
          { key: 'timeline', label: '时间线与分步', children: <TimelineTab detail={detail} /> },
          { key: 'stats', label: '写入统计', children: <StatsTab detail={detail} /> },
          { key: 'error', label: '错误详情', children: <ErrorTab detail={detail} /> },
          { key: 'reports', label: '关联报告任务', children: <ReportsTab detail={detail} /> },
        ]}
      />
    </div>
  )
}
