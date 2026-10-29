import { useParams } from '@tanstack/react-router'
import { Alert, Descriptions } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { AuditChange, AuditDetailResponse, AuditRelatedRow } from '@nova/api-contracts'
import { DataState, DetailLayout, stateFromError, SimpleGrid } from '../../components'
import type { IdentityMetric } from '../../components/detail/DetailLayout'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { ActorText, NONE, PageText, ResultTag } from './audit-ui'

// 审计详情（P5-09，09 章 9.11）：身份区 → 修改内容（修改前后的字段差异）/ 请求上下文（来源地址、访问模式等）/ 关联资源。
// 修改前后的内容在写入时已脱敏（令牌、密码、买家信息等显示“已隐藏”）；读取类、系统类事件没有修改内容，页面直接说明，不画空表。

const MAX_VALUE_LENGTH = 300

function valueText(value: unknown): string {
  if (value === null || value === undefined) return '（空）'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text
}

const changeColumns: ColumnsType<AuditChange> = [
  { title: '字段', dataIndex: 'field', key: 'field', width: 220, render: (value: string) => <span className="erp-num">{value}</span> },
  {
    title: '修改前',
    key: 'before',
    render: (_value, row) => <span style={{ textDecoration: 'line-through', color: 'var(--ant-color-text-secondary)', wordBreak: 'break-all' }}>{valueText(row.before)}</span>,
  },
  { title: '修改后', key: 'after', render: (_value, row) => <span style={{ wordBreak: 'break-all' }}>{valueText(row.after)}</span> },
]

function ChangesTab({ detail }: { detail: AuditDetailResponse }) {
  if (!detail.hasSnapshot) return <Muted>这条记录没有修改前后的内容：它记录的是读取、登录、导出这类不改动数据的操作，或是系统任务的执行结果。</Muted>
  if (detail.changes.length === 0) return <Muted>修改前后的内容一致，没有字段变化。</Muted>
  return (
    <div data-testid="audit-changes">
      <SimpleGrid<AuditChange>
        gridId="audit.audit-detail-page"
        columns={changeColumns}
        rows={detail.changes}
        rowKey={row => row.field}
        emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
      />
    </div>
  )
}

function ContextTab({ detail }: { detail: AuditDetailResponse }) {
  const { event } = detail
  return (
    <div>
      <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered data-testid="audit-context">
        <Descriptions.Item label="来源地址">{event.ip ?? <Muted>{NONE}</Muted>}</Descriptions.Item>
        <Descriptions.Item label="访问模式">{event.accessModeLabel}</Descriptions.Item>
        <Descriptions.Item label="来源">{event.sourceLabel}</Descriptions.Item>
        <Descriptions.Item label="所属页面">
          <PageText page={event.page} />
        </Descriptions.Item>
        <Descriptions.Item label="请求编号">{event.requestId}</Descriptions.Item>
        <Descriptions.Item label="审计编号">{event.id}</Descriptions.Item>
        <Descriptions.Item label="终端" span={2}>
          {event.userAgent ?? <Muted>{NONE}</Muted>}
        </Descriptions.Item>
        <Descriptions.Item label="再次验证身份">{event.stepUpVerified ? '已通过' : '本次操作没有要求'}</Descriptions.Item>
        <Descriptions.Item label="异步流程编号">{event.writeRunId ?? <Muted>无</Muted>}</Descriptions.Item>
        <Descriptions.Item label="发起人" span={2}>
          {event.initiator ? <ActorText actor={event.initiator} /> : <Muted>无（不是系统代为写入）</Muted>}
        </Descriptions.Item>
        <Descriptions.Item label="操作原因" span={2}>
          {event.reason ?? <Muted>未填写</Muted>}
        </Descriptions.Item>
      </Descriptions>
      <h4 style={{ margin: '12px 0 4px' }}>补充说明</h4>
      {detail.extra.length === 0 ? (
        <Muted>没有其他说明</Muted>
      ) : (
        <Descriptions size="small" column={1} bordered data-testid="audit-extra">
          {detail.extra.map(item => (
            <Descriptions.Item key={item.key} label={item.key}>
              <span style={{ wordBreak: 'break-all' }}>{item.value}</span>
            </Descriptions.Item>
          ))}
        </Descriptions>
      )}
    </div>
  )
}

const relatedColumns: ColumnsType<AuditRelatedRow> = [
  { title: '时间', key: 'time', width: 160, render: (_value, row) => timeText(row.occurredAt) },
  { title: '操作人', dataIndex: 'actorName', key: 'actor', width: 130 },
  { title: '动作', dataIndex: 'actionLabel', key: 'action' },
  { title: '结果', key: 'result', width: 90, render: (_value, row) => <ResultTag result={row.result} label={row.resultLabel} /> },
  {
    title: '操作',
    key: 'open',
    width: 90,
    render: (_value, row) => (
      <AppLink to={`/app/audit/${encodeURIComponent(row.id)}`} keepScope={false}>
        查看
      </AppLink>
    ),
  },
]

function ResourceTab({ detail }: { detail: AuditDetailResponse }) {
  const { resource } = detail
  if (!resource.id) return <Muted>这条记录没有关联到具体的资源。</Muted>
  return (
    <div>
      <p style={{ marginTop: 0 }}>
        {resource.label}：
        {resource.path ? (
          <AppLink to={resource.path} keepScope={false}>
            {resource.id}
          </AppLink>
        ) : (
          <span className="erp-num">{resource.id}</span>
        )}
        {resource.path ? null : <Muted>（这类资源没有独立的详情页）</Muted>}
      </p>
      <h4 style={{ margin: '8px 0 4px' }}>这个资源的其他审计记录</h4>
      {resource.recent.length === 0 ? (
        <Muted>没有其他审计记录</Muted>
      ) : (
        <>
          <div data-testid="audit-related">
            <SimpleGrid<AuditRelatedRow>
              gridId="audit.audit-detail-page-2"
              columns={relatedColumns}
              rows={resource.recent}
              rowKey={row => row.id}
              emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
            />
          </div>
          {resource.recentTruncated ? <Muted>只显示最近 {resource.recent.length} 条；更多请在审计日志里按资源编号筛选。</Muted> : null}
        </>
      )}
    </div>
  )
}

const metricsOf = (detail: AuditDetailResponse): IdentityMetric[] => {
  const { event } = detail
  return [
    { label: '发生时间', value: timeText(event.occurredAt) },
    { label: '操作人', value: <ActorText actor={event.actor} /> },
    { label: '动作', value: event.actionLabel },
    { label: '结果', value: <ResultTag result={event.result} label={event.resultLabel} /> },
    { label: '来源', value: event.sourceLabel },
    { label: '访问模式', value: event.accessModeLabel },
  ]
}

export default function AuditDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const query = useApiQuery<AuditDetailResponse>({ domain: 'list', path: `/audit/${encodeURIComponent(id)}`, scoped: false })
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'audit.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />
  const detail = query.data
  return (
    <div>
      <Alert type="info" showIcon style={{ marginBottom: 8 }} message="审计记录只能新增，不能修改或删除；修改前后的内容里，令牌、密码、买家信息等已隐藏。" />
      <DetailLayout
        title={`${detail.event.actionLabel}：${detail.event.resourceLabel}`}
        subtitle={`请求编号 ${detail.event.requestId}`}
        metrics={metricsOf(detail)}
        primaryActions={
          <AppLink to="/app/audit" keepScope={false}>
            返回审计中心
          </AppLink>
        }
        tabs={[
          { key: 'changes', label: `修改内容${detail.changes.length ? `（${detail.changes.length}）` : ''}`, children: <ChangesTab detail={detail} /> },
          { key: 'context', label: '请求上下文', children: <ContextTab detail={detail} /> },
          { key: 'resource', label: '关联资源', children: <ResourceTab detail={detail} /> },
        ]}
      />
    </div>
  )
}
