import { useCallback, useMemo, useState } from 'react'
import { Alert, Space, Typography } from 'antd'
import {
  LABEL_EXPORT_PATH,
  LABEL_TEMPLATE_PATH,
  type InboundLabelView,
  type InboundLabelsResponse,
  type InboundOverview,
  type InboundShipmentView,
  type LabelGenerateResponse,
  type LabelPrintStat,
  type LabelTemplateListResponse,
} from '@nova/api-contracts'
import { DataState, PagedGrid, stateFromError, type PageFetcher } from '../../../components'
import { AppLink } from '../../../nav/AppLink'
import { useApiQuery } from '../../../query/api-query'
import { describeError } from '../../../query/errors'
import { LabelPrintAction } from '../inbound-option-actions'
import { CustomBoxLabelAction, ItemLabelAction } from './label-actions'
import { labelFileColumns, shipmentStatColumns } from './label-columns'

// 入仓计划详情的“标签”页签（P6-12，16 章第 5 节）：
// 1）按货件看生成情况：已经取到哪些纸张的亚马逊箱标签、自定义箱标签与商品标签各生成过几次，并在行上生成自定义箱标签；
// 2）生成商品标签（FNSKU 条码 PDF）；3）亚马逊箱标签文件（向亚马逊获取的 PDF，自定义箱标签以它为底）。
// 生成的文件都在导出中心下载（保留期、下载权限、审计沿用导出任务）。

const planPath = (overview: InboundOverview) => `/inbound/plans/${encodeURIComponent(overview.plan.id)}`
const page =
  <T,>(items: readonly T[]): PageFetcher<T> =>
  async ({ page: no, pageSize }) => ({ items: items.slice((no - 1) * pageSize, no * pageSize), total: items.length })

export function LabelsTab({ overview }: { overview: InboundOverview }) {
  const shipments = useApiQuery<{ shipments: InboundShipmentView[] }>({ domain: 'list', path: `${planPath(overview)}/shipments`, scoped: false })
  const templates = useApiQuery<LabelTemplateListResponse>({ domain: 'reference', path: '/label-templates', params: { pageSize: 50 }, scoped: false })
  const query = useApiQuery<InboundLabelsResponse>({
    domain: 'list',
    path: `${planPath(overview)}/labels`,
    scoped: false,
    refetchIntervalMs: data => (data?.labels.some(label => label.status === 'QUEUED' || label.status === 'GENERATING') ? 5000 : false),
  })
  const [generated, setGenerated] = useState<LabelGenerateResponse | null>(null)
  const shipmentList = useMemo(() => (shipments.data?.shipments ?? []).map(item => ({ id: item.id, shipmentId: item.shipmentId })), [shipments.data])
  const templateRows = useMemo(() => templates.data?.items ?? [], [templates.data])

  const statColumns = useMemo(
    () =>
      shipmentStatColumns((row: LabelPrintStat) => (
        <Space size={4}>
          <CustomBoxLabelAction stat={row} templates={templateRows} onGenerated={setGenerated} />
          <ItemLabelAction planId={overview.plan.id} shipments={shipmentList} presetShipmentRowId={row.shipmentRowId} onGenerated={setGenerated} buttonSize="small" />
        </Space>
      )),
    [templateRows, overview.plan.id, shipmentList],
  )
  const fileColumns = useMemo(() => labelFileColumns(), [])
  const data = query.data
  const fetchStats = useCallback<PageFetcher<LabelPrintStat>>(args => page(data?.printStats ?? [])(args), [data])
  const fetchFiles = useCallback<PageFetcher<InboundLabelView>>(args => page(data?.labels ?? [])(args), [data])

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} />
  if (query.isPending || !data) return <DataState kind="skeleton" rows={3} />

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap>
        <LabelPrintAction overview={overview} shipments={shipmentList} />
        <ItemLabelAction planId={overview.plan.id} shipments={shipmentList} onGenerated={setGenerated} />
        <AppLink to={LABEL_TEMPLATE_PATH}>
          <Typography.Link>管理标签模板</Typography.Link>
        </AppLink>
        <AppLink to={LABEL_EXPORT_PATH}>
          <Typography.Link>去导出中心下载</Typography.Link>
        </AppLink>
      </Space>
      <Alert type="info" showIcon message={data.note} />
      {generated ? (
        <Alert
          type="success"
          showIcon
          closable
          onClose={() => setGenerated(null)}
          message={`已创建“${generated.kindLabel}”任务（${generated.statusLabel}）`}
          description={
            <div>
              {generated.notes.map(note => (
                <div key={note}>{note}</div>
              ))}
              <AppLink to={LABEL_EXPORT_PATH}>
                <Typography.Link>打开导出中心</Typography.Link>
              </AppLink>
            </div>
          }
        />
      ) : null}
      <Typography.Text strong>按货件</Typography.Text>
      <PagedGrid<LabelPrintStat>
        gridId="inbound.labels.shipments"
        columns={statColumns}
        fetchPage={fetchStats}
        getRowId={row => row.shipmentRowId}
        resetKey={JSON.stringify([overview.plan.id, query.dataUpdatedAt, templateRows.length])}
        emptyState={{ kind: 'empty', domain: '货件', prerequisite: '还没有货件：分仓方案确认后，亚马逊才会生成货件，之后才能生成标签。' }}
        height={260}
      />
      <Typography.Text strong>亚马逊箱标签文件</Typography.Text>
      <PagedGrid<InboundLabelView>
        gridId="inbound.labels.files"
        columns={fileColumns}
        fetchPage={fetchFiles}
        getRowId={row => row.id}
        resetKey={JSON.stringify([overview.plan.id, query.dataUpdatedAt])}
        emptyState={{ kind: 'empty', domain: '亚马逊箱标签', prerequisite: '还没有取过箱标签。点上面的“获取亚马逊箱标签”，取到后可以在货件行上生成自定义箱标签。' }}
        height={320}
      />
    </Space>
  )
}
