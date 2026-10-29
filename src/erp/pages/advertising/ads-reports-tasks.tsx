import { useState } from 'react'
import { Alert, Button, Radio, Select, Space } from 'antd'
import {
  ADS_REPORT_STATUS_LABEL,
  ADS_REPORT_STATUSES,
  ADS_REPORT_TEMPLATES,
  type AdsReportListResponse,
  type AdsReportRow,
  type AdsReportStatus,
  type AdsReportTemplateKey,
  type AdsReportTemplatesResponse,
} from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { BackfillAction, CreateReportAction } from './ads-reports-actions'
import { reportColumns } from './ads-reports-columns'
import { REFRESH_MS } from './ads-reports-data'

// 报告任务页签（08 章 8.12）：任务列表、创建、历史回补、失败重试；有没做完的任务时自动刷新。
// “历史可用起点”写在顶部：每个广告档案已经取得数据的最早日期，只会往前推，没有取过数据写“尚未取得”。

const PAGE_SIZES = [20, 50, 100]
type StatusFilter = AdsReportStatus | 'ALL'

export function HistoryStrip({ data }: { data: AdsReportTemplatesResponse }) {
  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 8 }}
      data-testid="ads-reports-history"
      message="历史可用起点"
      description={
        <div>
          {data.profiles.length === 0 ? <div>还没有广告档案</div> : null}
          {data.profiles.map(profile => (
            <div key={profile.id}>
              {profile.name}
              {profile.storeName ? ` · ${profile.storeName}` : ''}：{profile.historyFrom ?? '尚未取得数据'}
            </div>
          ))}
          <div style={{ marginTop: 4 }}>{data.historyNote}</div>
        </div>
      }
    />
  )
}

export function ReportTasks({ templates }: { templates: AdsReportTemplatesResponse | undefined }) {
  const [status, setStatus] = useState<StatusFilter>('ALL')
  const [templateKey, setTemplateKey] = useState<AdsReportTemplateKey>()
  const [adsProfileId, setAdsProfileId] = useState<string>()
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const reset = () => setStack([undefined])
  const query = useApiQuery<AdsReportListResponse>({
    domain: 'list',
    path: '/ads/reports',
    params: { status: status === 'ALL' ? undefined : status, templateKey, adsProfileId, pageSize, cursor: stack[stack.length - 1] },
    refetchIntervalMs: data => (data?.items.some(item => item.status === 'PENDING' || item.status === 'GENERATING') ? REFRESH_MS : false),
  })
  const data = query.data
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null
  const total = data ? ADS_REPORT_STATUSES.reduce((sum, key) => sum + data.counts[key], 0) : null
  const filtered = Boolean(status !== 'ALL' || templateKey || adsProfileId)
  const refresh = () => {
    reset()
    void query.refetch()
  }

  return (
    <div data-testid="ads-reports-tasks">
      {templates ? <HistoryStrip data={templates} /> : null}
      <Space wrap style={{ marginBottom: 8 }}>
        <CreateReportAction data={templates} onDone={refresh} />
        <BackfillAction data={templates} onDone={refresh} />
        <Button onClick={() => void query.refetch()} loading={query.isFetching}>
          刷新
        </Button>
      </Space>
      <Space wrap style={{ marginBottom: 8, display: 'flex' }}>
        <Radio.Group
          value={status}
          aria-label="状态"
          optionType="button"
          onChange={event => {
            setStatus(event.target.value as StatusFilter)
            reset()
          }}
          options={[
            { value: 'ALL', label: `全部${total === null ? '' : `（${total}）`}` },
            ...ADS_REPORT_STATUSES.map(key => ({ value: key, label: `${ADS_REPORT_STATUS_LABEL[key]}${data ? `（${data.counts[key]}）` : ''}` })),
          ]}
        />
        <Select
          allowClear
          style={{ width: 180 }}
          placeholder="报告模板"
          aria-label="报告模板"
          value={templateKey}
          options={ADS_REPORT_TEMPLATES.map(template => ({ value: template.key, label: template.label }))}
          onChange={value => {
            setTemplateKey(value)
            reset()
          }}
        />
        <Select
          allowClear
          style={{ width: 220 }}
          placeholder="广告档案"
          aria-label="广告档案"
          value={adsProfileId}
          options={(templates?.profiles ?? []).map(profile => ({ value: profile.id, label: profile.storeName ? `${profile.name} · ${profile.storeName}` : profile.name }))}
          onChange={value => {
            setAdsProfileId(value)
            reset()
          }}
        />
        <Select
          value={String(pageSize)}
          aria-label="每页条数"
          style={{ width: 110 }}
          options={PAGE_SIZES.map(size => ({ value: String(size), label: `${size} 条/页` }))}
          onChange={value => {
            setPageSize(Number(value))
            reset()
          }}
        />
      </Space>
      <SimpleGrid<AdsReportRow>
        gridId="advertising.ads-reports-tasks"
        columns={reportColumns(refresh)}
        rows={data?.items}
        rowKey={row => row.id}
        loading={query.isFetching && !data}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '报告任务', prerequisite: data?.note ?? (filtered ? '没有符合条件的报告任务；可以放宽筛选条件。' : '还没有创建过报告任务。') }}
      />
      <Space style={{ marginTop: 8 }}>
        <Button disabled={stack.length <= 1 || query.isFetching} onClick={() => setStack(current => current.slice(0, -1))}>
          上一页
        </Button>
        <Button disabled={!next || query.isFetching} onClick={() => next && setStack(current => [...current, next])}>
          下一页
        </Button>
        <span style={{ color: 'rgba(0,0,0,0.45)' }}>
          第 {stack.length} 页{data ? `，共 ${data.pageInfo.approxTotal ?? data.items.length} 条` : ''}
        </span>
      </Space>
    </div>
  )
}
