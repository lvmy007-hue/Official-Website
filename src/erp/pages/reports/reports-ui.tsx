import type { ReactNode } from 'react'
import { Form, Input, Select, Space, Tag, Typography } from 'antd'
import {
  CREATABLE_REPORT_TYPES,
  REPORT_CATALOG,
  REPORT_DOMAINS,
  REPORT_DOMAIN_LABEL,
  REPORT_FILE_LABEL,
  REPORT_PARSE_LABEL,
  REPORT_PERIOD_LABEL,
  REPORT_RANGE_MAX_DAYS,
  REPORT_STATUS_LABEL,
  REPORT_WRITE,
  spReportOf,
  type ReportCreateResponse,
  type ReportDownloadResponse,
  type ReportRow,
  type ReportStatus,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { ActionGuard, FormAction } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { useApiMutation } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { openSignedUrl } from '../../security/safe-url'

// 报表中心页面共用的小件（P5-03）：状态、文件、解析、行数、保留期、失败原因的写法，行内动作，创建表单。
// 没有数据的写法：行数还没有统计写“尚无统计”，保留期没有写“没有留存”，任何时候都不拿 0 冒充。

const STATUS_COLOR: Record<ReportStatus, string> = { PENDING: 'default', GENERATING: 'processing', READY: 'success', FAILED: 'error', CANCELLED: 'default' }

export function ReportStatusTag({ row }: { row: Pick<ReportRow, 'status' | 'attempt'> }) {
  return (
    <span>
      <Tag color={STATUS_COLOR[row.status]} bordered={false}>
        {REPORT_STATUS_LABEL[row.status]}
      </Tag>
      {row.attempt > 1 ? <Muted>第 {row.attempt} 次</Muted> : null}
    </span>
  )
}

export const fileText = (row: Pick<ReportRow, 'fileState'>) => REPORT_FILE_LABEL[row.fileState]
export const parseText = (row: Pick<ReportRow, 'parseState'>) => REPORT_PARSE_LABEL[row.parseState]

export const rowsText = (value: number | null): ReactNode => (value === null ? <Muted>尚无统计</Muted> : <span className="erp-num">{value.toLocaleString('zh-CN')}</span>)

export const retentionText = (row: Pick<ReportRow, 'retentionUntil'>): ReactNode => (row.retentionUntil ? <span className="erp-num">{row.retentionUntil.slice(0, 10)}</span> : <Muted>没有留存</Muted>)

export function FailureText({ row }: { row: Pick<ReportRow, 'failureCode' | 'failureText'> }) {
  if (!row.failureText && !row.failureCode) return <Muted>无</Muted>
  return (
    <Typography.Text type="danger" style={{ fontSize: 12 }}>
      {row.failureText}
      {row.failureCode ? `（${row.failureCode}）` : ''}
    </Typography.Text>
  )
}

const REASON_NO_FILE = '没有可下载的原始文件'

/** 行内动作：取消、重试、下载原始文件、跳到分析页。权限按 reports.create 判断；下载只需要读取权限。 */
export function ReportActions({ row, onChanged }: { row: ReportRow; onChanged?: () => void }) {
  const cancel = useApiMutation<void, unknown>({ method: 'POST', path: `/reports/${encodeURIComponent(row.id)}/cancel`, invalidate: ['list', 'realtime'], silent: true })
  const retry = useApiMutation<void, ReportCreateResponse>({ method: 'POST', path: `/reports/${encodeURIComponent(row.id)}/retry`, invalidate: ['list', 'realtime'], silent: true })
  return (
    <Space size={0} wrap>
      {row.canCancel ? (
        <ActionGuard
          label="取消"
          danger
          guard={{ permission: REPORT_WRITE }}
          preview={{ title: '取消这个报告任务？', content: '只取消本系统的任务：亚马逊侧已经开始生成的报告不会被撤回；已开始下载解析的任务不能取消。', confirmText: '确认取消' }}
          onExecute={() => cancel.mutateAsync()}
          successText="已取消"
          onDone={onChanged}
          buttonProps={{ size: 'small', type: 'link' }}
        />
      ) : null}
      {row.canRetry ? (
        <ActionGuard
          label="重试"
          guard={{ permission: REPORT_WRITE }}
          onExecute={() => retry.mutateAsync()}
          successText="已创建重试任务"
          onDone={onChanged}
          buttonProps={{ size: 'small', type: 'link' }}
        />
      ) : null}
      <ActionGuard
        label="下载原始文件"
        guard={{ condition: { ok: row.canDownload, reason: row.fileState === 'STORED' ? REASON_NO_FILE : fileText(row) } }}
        onExecute={async () => {
          const link = await apiFetch<ReportDownloadResponse>(`/reports/${encodeURIComponent(row.id)}/download`)
          openSignedUrl(link.url)
        }}
        buttonProps={{ size: 'small', type: 'link' }}
      />
      {row.analysisPath ? (
        <AppLink to={row.analysisPath}>
          <Typography.Link>去分析页</Typography.Link>
        </AppLink>
      ) : null}
    </Space>
  )
}

const creatableOptions = REPORT_DOMAINS.map(domain => ({
  label: REPORT_DOMAIN_LABEL[domain],
  options: REPORT_CATALOG.filter(item => item.source === 'SP_API' && item.domain === domain && CREATABLE_REPORT_TYPES.includes(item.key)).map(item => ({ value: item.key, label: item.label })),
})).filter(group => group.options.length > 0)

const periodHint = (period: string): string =>
  period === 'RANGE' ? `按起止日期申请，最长 ${REPORT_RANGE_MAX_DAYS} 天` : period === 'BA_PERIOD' ? '必须是完整的自然周（周日至周六）、自然月或自然季度' : '当前状态的快照，不需要选日期'

/** 创建报告：只列目录里“可创建”的类型；日期框按所选类型的数据周期出现。站点固定为美国站。 */
export function CreateReportAction({ onDone }: { onDone?: () => void }) {
  const create = useApiMutation<Record<string, unknown>, ReportCreateResponse>({ method: 'POST', path: '/reports', invalidate: ['list', 'realtime'], silent: true })
  return (
    <FormAction
      label="创建报告"
      guard={{ permission: REPORT_WRITE }}
      title="创建报告"
      description="向亚马逊申请一份报告，生成后自动下载并导入。同一店铺、类型、周期有任务在进行时不能重复创建。当前只支持美国站。"
      onSubmit={values => {
        const entry = spReportOf(String(values.reportType))
        const body: Record<string, unknown> = { reportType: values.reportType }
        if (entry && entry.period !== 'SNAPSHOT') {
          body.from = values.from
          body.to = values.to
        }
        return create.mutateAsync(body)
      }}
      successText="已创建，进度见列表"
      onDone={onDone}
    >
      <Form.Item label="报告类型" name="reportType" rules={[{ required: true, message: '请选择报告类型' }]}>
        <Select showSearch optionFilterProp="label" aria-label="报告类型" placeholder="选择要创建的报告" options={creatableOptions} />
      </Form.Item>
      <Form.Item noStyle shouldUpdate={(before, after) => before.reportType !== after.reportType}>
        {({ getFieldValue }) => {
          const entry = spReportOf(getFieldValue('reportType') as string | undefined)
          if (!entry) return null
          return (
            <div>
              <Muted>
                {entry.requirement}；数据周期：{REPORT_PERIOD_LABEL[entry.period]}。{periodHint(entry.period)}
              </Muted>
              {entry.period === 'SNAPSHOT' ? null : (
                <Space size={12} style={{ display: 'flex', marginTop: 8 }}>
                  <Form.Item label="开始日期" name="from" rules={[{ required: true, message: '请选择开始日期' }]}>
                    <Input type="date" aria-label="开始日期" />
                  </Form.Item>
                  <Form.Item label="结束日期" name="to" rules={[{ required: true, message: '请选择结束日期' }]}>
                    <Input type="date" aria-label="结束日期" />
                  </Form.Item>
                </Space>
              )}
            </div>
          )
        }}
      </Form.Item>
    </FormAction>
  )
}
