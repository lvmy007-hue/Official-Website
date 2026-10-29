import { useState } from 'react'
import { Alert, App, Input, Modal, Radio, Space, Typography } from 'antd'
import { OVERVIEW_REPORT_KIND, REPORT_TEMPLATES, REPORT_TEMPLATE_HINT, REPORT_TEMPLATE_LABEL, reportRange, type ReportTemplate } from '@nova/api-contracts'
import { useApiMutation } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { addDays, todayInMarketplace } from '../../scope/dates'
import { DrillLink } from './dash-parts'

// 经营日报、周报、月报（04 章 4.1 第 1 项）：走导出任务，生成后在“导出中心”下载。
// 内容是店铺日汇总里已接入的列（日期、店铺、订单、销量、销售额、退款、平台费用）；广告、利润、会话未接入，不放空列。
// 定时邮件推送暂不做（需要邮件通道，见变更记录）。

const MAX_END = () => todayInMarketplace()

export function ReportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const { scope } = useScope()
  const [template, setTemplate] = useState<ReportTemplate>('daily')
  const [format, setFormat] = useState<'CSV' | 'XLSX'>('XLSX')
  const [endDate, setEndDate] = useState(() => addDays(todayInMarketplace(), -1))
  const [submitted, setSubmitted] = useState(false)
  const create = useApiMutation<Record<string, unknown>, unknown>({ method: 'POST', path: '/exports', invalidate: ['realtime'] })
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(endDate) && endDate <= MAX_END()
  const range = valid ? reportRange(template, endDate) : null
  const storeIds = (scope.storeIds as string[] | undefined) ?? []
  const narrowedByEntity = ((scope.legalEntityIds as string[] | undefined)?.length ?? 0) > 0 && storeIds.length === 0

  const submit = async () => {
    if (!range) return
    const label = REPORT_TEMPLATE_LABEL[template]
    await create.mutateAsync({
      kind: OVERVIEW_REPORT_KIND,
      format,
      filters: { ...(storeIds.length ? { storeIds } : {}), from: range.from, to: range.to, template },
      filterSummary: `经营${label}：${range.from} 至 ${range.to}${storeIds.length ? `，${storeIds.length} 家店铺` : ''}`,
    })
    void message.success(`经营${label}已提交，生成后可在导出中心下载`)
    setSubmitted(true)
  }

  return (
    <Modal
      open={open}
      title="生成经营报表"
      okText="生成"
      cancelText={submitted ? '关闭' : '取消'}
      okButtonProps={{ disabled: !valid || submitted, loading: create.isPending }}
      onOk={() => void submit().catch(() => undefined)}
      onCancel={() => {
        setSubmitted(false)
        onClose()
      }}
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Radio.Group
          value={template}
          onChange={event => setTemplate(event.target.value)}
          optionType="button"
          options={REPORT_TEMPLATES.map(value => ({ value, label: REPORT_TEMPLATE_LABEL[value] }))}
        />
        <Typography.Text type="secondary">{REPORT_TEMPLATE_HINT[template]}</Typography.Text>
        <div>
          <label htmlFor="report-end">截止日期</label>
          <Input id="report-end" type="date" max={MAX_END()} value={endDate} onChange={event => setEndDate(event.target.value)} style={{ width: 180, marginLeft: 8 }} />
          {range ? (
            <Typography.Text style={{ marginLeft: 8 }}>{`${range.from} 至 ${range.to}`}</Typography.Text>
          ) : (
            <Typography.Text type="danger" style={{ marginLeft: 8 }}>
              请选择不晚于今天的日期
            </Typography.Text>
          )}
        </div>
        <Radio.Group
          value={format}
          onChange={event => setFormat(event.target.value)}
          options={[
            { value: 'XLSX', label: 'Excel' },
            { value: 'CSV', label: 'CSV' },
          ]}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          范围：{storeIds.length ? `当前所选的 ${storeIds.length} 家店铺` : '你有权限的全部店铺'}。包含订单数、销量、销售额、退款额、平台费用；广告、利润、会话尚未接入，不在报表里。
        </Typography.Text>
        {narrowedByEntity ? <Alert type="warning" showIcon message="报表暂不支持按法律主体筛选，会包含你有权限的全部店铺；如需限定，请在范围栏里直接选择店铺。" /> : null}
        {submitted ? (
          <Typography.Text>
            已提交。
            <DrillLink component="ExportCenterPage" label="去导出中心下载" />
          </Typography.Text>
        ) : null}
      </Space>
    </Modal>
  )
}
