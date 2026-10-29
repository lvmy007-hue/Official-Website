import { Alert, Card, Progress, Space, Tag, Typography } from 'antd'
import type { SourceHealthRow } from '@nova/api-contracts'
import type { ReactNode } from 'react'
import { renderColumn, type ErpColDef } from '../../components'
import { DetailGrid } from '../orders/DetailGrid'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { useSession } from '../../session/session'
import type { OnboardingView } from '../../onboarding/onboarding-types'

// 企业初始化与数据源健康（P1-30 过渡页的内容，P2a-02 起作为经营控制台的一个区域）。
// 只显示真实内容：初始化进度来自 /onboarding，数据源健康来自 /overview/source-health。
// 没有同步记录的来源如实显示“尚无记录”，同步器还没交付的来源显示“尚未接入”，不出现任何示例数字。

export type SourceHealth = { asOf: string; storeCount: number; rows: SourceHealthRow[]; summary: { completeness: number | null; attention: number } }

const STATUS_COLOR: Record<string, string> = { NORMAL: 'success', DELAYED: 'warning', FAILED: 'error', UNAUTHORIZED: 'error', WAITING_DEPENDENCY: 'warning' }

export const lagText = (minutes: number | null) => {
  if (minutes === null) return '—'
  if (minutes < 60) return `${minutes} 分钟`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} 小时`
  return `${Math.round(minutes / (24 * 60))} 天`
}

/** 健康灯：没有需要关注的来源为绿；有来源需要关注为黄；完整度不足一半为红；没有任何应同步的来源为灰。 */
export function healthLight(summary: SourceHealth['summary'] | undefined): { color: 'success' | 'warning' | 'error' | 'default'; label: string } {
  if (!summary || summary.completeness === null) return { color: 'default', label: '暂无应同步的数据源' }
  if (summary.completeness < 0.5) return { color: 'error', label: '数据源严重缺失' }
  if (summary.attention > 0) return { color: 'warning', label: `${summary.attention} 个数据源需要关注` }
  return { color: 'success', label: '数据源正常' }
}

const WRAP = { wrapText: true, autoHeight: true } as const
const column = (title: string, key: string, width: number, render: (row: SourceHealthRow) => ReactNode, extra: ErpColDef<SourceHealthRow> = {}) =>
  renderColumn<SourceHealthRow>(title, key, render, { width, sortable: false, ...extra })

const columns: ErpColDef<SourceHealthRow>[] = [
  column('数据来源', 'label', 130, row => row.label),
  column(
    '状态',
    'status',
    190,
    row => (
      <div>
        <Tag color={STATUS_COLOR[row.status] ?? 'default'}>{row.statusLabel}</Tag>
        {row.note ? <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>{row.note}</div> : null}
      </div>
    ),
    WRAP,
  ),
  column('最近成功同步', 'lastSuccessAt', 170, row => (row.lastSuccessAt ? formatDateTime(row.lastSuccessAt) : '—')),
  column('数据延迟', 'lagMinutes', 100, row => lagText(row.lagMinutes)),
  column('覆盖店铺', 'coverage', 110, row => (row.coverage ? `${row.coverage.fresh} / ${row.coverage.total}` : '—')),
  column('失败原因', 'error', 260, row => (row.errorMessage ? <span style={{ color: 'var(--ant-color-error)' }}>{row.errorMessage}</span> : '—'), WRAP),
  column('处理', 'actions', 120, row => (row.state === 'LIVE' && !['NORMAL', 'NO_RECORD', 'NOT_APPLICABLE'].includes(row.status) ? <AppLink to="/app/sync">去同步中心</AppLink> : '—')),
]

export function InitializationCard() {
  const { canPermission } = useSession()
  const allowed = canPermission('settings.write')
  const query = useApiQuery<OnboardingView>({ domain: 'config', path: '/onboarding', scoped: false, enabled: allowed, staleMs: 0 })
  if (!allowed) {
    return <Alert type="info" showIcon style={{ marginBottom: 12 }} message="企业初始化由企业管理员负责。初始化完成前，下方的数据可能尚未到位。" />
  }
  const view = query.data
  if (query.isError) return <Alert type="error" showIcon style={{ marginBottom: 12 }} message="初始化进度读取失败，请刷新重试" />
  if (!view) return <Card size="small" loading style={{ marginBottom: 12 }} />
  const done = view.steps.filter(step => step.state !== 'PENDING').length
  const next = view.steps.find(step => step.state === 'PENDING')
  return (
    <Card size="small" title="企业初始化" style={{ marginBottom: 12 }}>
      {view.completed ? (
        <Space direction="vertical" size={4}>
          <Typography.Text>企业初始化已完成{view.completedAt ? `（${formatDateTime(view.completedAt)}）` : ''}。</Typography.Text>
          {view.firstSync ? (
            <Typography.Text type="secondary">
              首次同步于 {formatDateTime(view.firstSync.startedAt)} 启动：{view.firstSync.jobs} 个任务，历史回补共 {view.firstSync.segments} 段（由近及远）。
            </Typography.Text>
          ) : null}
        </Space>
      ) : (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Progress percent={Math.round((done / view.steps.length) * 100)} format={() => `${done} / ${view.steps.length} 步`} />
          <Typography.Text>{next ? `下一步：${next.title}${next.required ? '（必填）' : '（选填）'}` : '所有步骤已处理，等待启动首次同步。'}</Typography.Text>
          <AppLink to="/app/onboarding" keepScope={false}>
            继续初始化
          </AppLink>
        </Space>
      )}
    </Card>
  )
}

export function SourceHealthSection({ health }: { health: ReturnType<typeof useApiQuery<SourceHealth>> }) {
  const data = health.data
  return (
    <div data-testid="source-health-section">
      <InitializationCard />
      <Card size="small" title="数据源健康" extra={data ? <Typography.Text type="secondary">范围内 {data.storeCount} 家店铺</Typography.Text> : null} style={{ marginBottom: 12 }}>
        {data && data.summary.completeness !== null ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            数据完整度 {Math.round(data.summary.completeness * 100)}%（按时同步成功的来源 ÷ 应同步的来源，未接入的不计入）；
            {data.summary.attention > 0 ? `${data.summary.attention} 个来源需要关注。` : '没有需要关注的来源。'}
          </Typography.Paragraph>
        ) : null}
        <DetailGrid<SourceHealthRow>
          gridId="overview.source-health"
          height={420}
          columns={columns}
          rows={data?.rows}
          getRowId={row => row.sourceKey}
          loading={health.isPending}
          error={health.error}
          onRetry={() => void health.refetch()}
          emptyState={{ kind: 'empty', domain: '数据源', prerequisite: '完成企业初始化并授权亚马逊账号后，这里会显示各来源的同步状态。' }}
        />
      </Card>
    </div>
  )
}
