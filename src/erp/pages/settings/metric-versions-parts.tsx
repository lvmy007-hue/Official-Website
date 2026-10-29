import { useCallback, useMemo, useState } from 'react'
import { Alert, Button, Input, Modal, Space, Tag, Typography } from 'antd'
import {
  FINANCE_POLICY_STEP_UP,
  FINANCE_POLICY_WRITE,
  METRIC_STATUS_LABEL,
  type MetricDecisionResult,
  type MetricDiffReport,
  type MetricDiffRow,
  type MetricKind,
  type MetricVersionList,
  type MetricVersionView,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FormAction, PagedGrid, renderColumn, type ErpColDef, type PageFetcher } from '../../components'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'

// 口径版本的共用零件（P6-31）：待审批提示与审批动作、版本历史表、差异报告。利润公式页与业务口径页共用。

const STATUS_COLOR: Record<MetricVersionView['status'], string> = { DRAFT: 'default', PENDING_APPROVAL: 'warning', ACTIVE: 'success', RETIRED: 'default' }
const APPROVE_GUARD = { permission: FINANCE_POLICY_WRITE } as const
const money = (value: number | null) => (value === null ? '尚无记录' : value.toLocaleString('en-US', { style: 'currency', currency: 'USD' }))

/** 通过或驳回（发起人本人点“撤回”走驳回）；通过必须由别人来。 */
export function DecisionActions({ view, onDone }: { view: MetricVersionView; onDone: () => void }) {
  const send = (decision: 'APPROVED' | 'REJECTED', comment: string) =>
    apiFetch<MetricDecisionResult>(`/metric-versions/${encodeURIComponent(view.id)}/decision`, { method: 'POST', body: JSON.stringify({ decision, comment, version: view.version }) })
  return (
    <Space size={4}>
      <FormAction
        label="通过"
        title={`通过第 ${view.versionNo} 版`}
        okText="通过并生效"
        guard={{ ...APPROVE_GUARD, condition: { ok: !view.mine, reason: '不能审批自己提交的修改，请换一位有权限的同事' } }}
        stepUp={FINANCE_POLICY_STEP_UP}
        buttonProps={{ size: 'small', type: 'primary' }}
        description={view.summary}
        successText="已通过，新口径自下一次读取起生效；已关账月份不改动"
        onSubmit={() => send('APPROVED', '')}
        onDone={onDone}
      />
      <FormAction
        label={view.mine ? '撤回' : '驳回'}
        title={`${view.mine ? '撤回' : '驳回'}第 ${view.versionNo} 版`}
        okText={view.mine ? '撤回' : '驳回'}
        danger
        guard={APPROVE_GUARD}
        stepUp={FINANCE_POLICY_STEP_UP}
        reason={{ label: view.mine ? '撤回原因' : '驳回意见' }}
        buttonProps={{ size: 'small' }}
        successText={view.mine ? '已撤回' : '已驳回'}
        onSubmit={values => send('REJECTED', String(values.reason ?? ''))}
        onDone={onDone}
      />
    </Space>
  )
}

export function PendingAlert({ pending, onDone }: { pending: MetricVersionView | null; onDone: () => void }) {
  if (!pending) return null
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      data-testid="metric-pending"
      message={`第 ${pending.versionNo} 版待审批：${pending.summary}`}
      description={`${pending.createdByName ?? '同事'} 提交${pending.reason ? `，原因：${pending.reason}` : ''}。审批通过前，页面与报表仍按当前口径计算。`}
      action={<DecisionActions view={pending} onDone={onDone} />}
    />
  )
}

function DiffTable({ report }: { report: MetricDiffReport }) {
  const fetchRows = useCallback<PageFetcher<MetricDiffRow>>(async ({ page, pageSize }) => ({ items: report.rows.slice((page - 1) * pageSize, page * pageSize), total: report.rows.length }), [report])
  const columns = useMemo<ErpColDef<MetricDiffRow>[]>(
    () => [
      renderColumn<MetricDiffRow>('月份', 'month', row => <span className="erp-num">{row.month}</span>, { width: 110, sortable: false }),
      renderColumn<MetricDiffRow>('关账', 'closed', row => (row.closed ? <Tag bordered={false}>已关账，快照不变</Tag> : <Muted>未关账</Muted>), { width: 150, sortable: false }),
      renderColumn<MetricDiffRow>('当前口径', 'baseline', row => <span className="erp-num">{money(row.baseline)}</span>, { width: 140, sortable: false }),
      renderColumn<MetricDiffRow>('新口径', 'proposed', row => <span className="erp-num">{money(row.proposed)}</span>, { width: 140, sortable: false }),
      renderColumn<MetricDiffRow>('差额', 'delta', row => <span className="erp-num">{money(row.delta)}</span>, { width: 140, sortable: false }),
      renderColumn<MetricDiffRow>('说明', 'note', row => row.note ?? <Muted>—</Muted>, { width: 260, sortable: false }),
    ],
    [],
  )
  return (
    <PagedGrid<MetricDiffRow>
      gridId="settings.metricVersions.diff"
      columns={columns}
      fetchPage={fetchRows}
      getRowId={row => row.month}
      resetKey={report.versionId + report.from + report.to}
      height={320}
      emptyState={{ kind: 'empty', domain: '差异报告', prerequisite: '这个区间里没有可比较的月份。' }}
    />
  )
}

/** 对比新口径与当前口径在历史区间上的差异；只读，不改任何数据。 */
export function DiffReportAction({ view }: { view: MetricVersionView }) {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<MetricDiffReport | null>(null)
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      setReport(await apiFetch<MetricDiffReport>(`/metric-versions/${encodeURIComponent(view.id)}/diff-report`, { method: 'POST', body: JSON.stringify({ from, to }) }))
    } catch (cause) {
      setError(describeError(cause).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>
        差异报告
      </Button>
      <Modal open={open} title={`第 ${view.versionNo} 版差异报告`} footer={null} width={840} onCancel={() => setOpen(false)} destroyOnClose>
        <Space wrap style={{ marginBottom: 12 }}>
          <Input type="date" aria-label="开始日期" value={from} onChange={event => setFrom(event.target.value)} />
          <Input type="date" aria-label="结束日期" value={to} onChange={event => setTo(event.target.value)} />
          <Button type="primary" loading={busy} disabled={!from || !to} onClick={() => void run()}>
            生成报告
          </Button>
        </Space>
        {error ? (
          <Typography.Paragraph type="danger" role="alert">
            {error}
          </Typography.Paragraph>
        ) : null}
        {report ? (
          <div data-testid="metric-diff">
            <Alert type="info" showIcon style={{ marginBottom: 8 }} message={report.note} description={report.configChanges.join('；')} />
            <Typography.Paragraph>{`${report.metricLabel}：当前 ${money(report.totalBaseline)}，新口径 ${money(report.totalProposed)}，差额 ${money(report.totalDelta)}`}</Typography.Paragraph>
            <DiffTable report={report} />
          </div>
        ) : null}
      </Modal>
    </>
  )
}

/** 版本历史：服务端分页，最新在前。 */
export function VersionHistory({ kind, tick, onDone }: { kind: MetricKind; tick: number; onDone: () => void }) {
  const fetchRows = useCallback<PageFetcher<MetricVersionView>>(
    async ({ page, pageSize, signal }) => {
      const response = await apiFetch<MetricVersionList>(`/metric-versions?kind=${kind}&page=${page}&pageSize=${pageSize}`, { signal })
      return { items: response.items, total: response.total }
    },
    [kind],
  )
  const columns = useMemo<ErpColDef<MetricVersionView>[]>(
    () => [
      renderColumn<MetricVersionView>('版本', 'versionNo', row => <span className="erp-num">{`第 ${row.versionNo} 版`}</span>, { pin: 'left', width: 100, sortable: false }),
      renderColumn<MetricVersionView>(
        '状态',
        'status',
        row => (
          <Tag color={STATUS_COLOR[row.status]} bordered={false}>
            {row.withdrawn ? '已撤回/驳回' : METRIC_STATUS_LABEL[row.status]}
          </Tag>
        ),
        { width: 120, sortable: false },
      ),
      renderColumn<MetricVersionView>('改了什么', 'summary', row => <span title={row.summary}>{row.summary}</span>, { width: 320, sortable: false }),
      renderColumn<MetricVersionView>('原因', 'reason', row => row.reason ?? <Muted>—</Muted>, { width: 220, sortable: false }),
      renderColumn<MetricVersionView>('提交人', 'createdByName', row => row.createdByName ?? <Muted>—</Muted>, { width: 120, sortable: false }),
      renderColumn<MetricVersionView>('提交时间', 'createdAt', row => <span className="erp-num">{row.createdAt.slice(0, 16).replace('T', ' ')}</span>, { width: 150, sortable: false }),
      renderColumn<MetricVersionView>('审批人', 'approvedByName', row => row.approvedByName ?? <Muted>—</Muted>, { width: 120, sortable: false }),
      renderColumn<MetricVersionView>(
        '操作',
        'actions',
        row => (
          <Space size={4}>
            {row.status === 'PENDING_APPROVAL' ? <DecisionActions view={row} onDone={onDone} /> : null}
            {kind === 'PROFIT_FORMULA' || kind === 'BUSINESS_RULES' ? <DiffReportAction view={row} /> : null}
          </Space>
        ),
        { pin: 'right', width: 260, sortable: false },
      ),
    ],
    [kind, onDone],
  )
  return (
    <PagedGrid<MetricVersionView>
      gridId={`settings.metricVersions.${kind}`}
      columns={columns}
      fetchPage={fetchRows}
      getRowId={row => row.id}
      resetKey={String(tick)}
      height={360}
      emptyState={{ kind: 'empty', domain: '口径版本', prerequisite: '还没有修改记录，当前使用系统默认口径。' }}
    />
  )
}
