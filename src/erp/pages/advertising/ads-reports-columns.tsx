import { Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ADS_REPORT_AD_PRODUCT_LABEL, ADS_REPORT_SOURCE_LABEL, ADS_REPORT_STATUS_LABEL, adsReportGranularityText, type AdsReportAdProduct, type AdsReportRow } from '@nova/api-contracts'
import { formatDateTime, formatNumber } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { RetryAction } from './ads-reports-actions'
import { STATUS_COLOR } from './ads-reports-data'

// 报告任务列表的列（08 章 8.12）：状态、失败原因、导入行数、警告、重试。没有的数写“—”，不写 0。

const productText = (value: string) => ADS_REPORT_AD_PRODUCT_LABEL[value as AdsReportAdProduct] ?? value

export function reportColumns(onChanged: () => void): ColumnsType<AdsReportRow> {
  return [
    {
      title: '报告',
      key: 'title',
      width: 190,
      render: (_value, row) => (
        <div>
          <strong>{row.title}</strong>
          <div>
            <Tag bordered={false}>{ADS_REPORT_SOURCE_LABEL[row.source]}</Tag>
            {row.granularity ? <Muted>{adsReportGranularityText(row.granularity)}</Muted> : null}
            {row.attempt > 1 ? <Tag color="orange" bordered={false}>{`第 ${row.attempt} 次`}</Tag> : null}
          </div>
        </div>
      ),
    },
    {
      title: '广告档案',
      key: 'profile',
      width: 200,
      render: (_value, row) => (
        <div>
          {row.profile.name}
          <div>
            <Muted>{row.profile.storeName ?? '未绑定店铺'}</Muted>
          </div>
        </div>
      ),
    },
    { title: '广告产品', key: 'adProduct', width: 100, render: (_value, row) => productText(row.adProduct) },
    { title: '时间范围', key: 'range', width: 190, render: (_value, row) => (row.from && row.to ? <span className="erp-num">{`${row.from} 至 ${row.to}`}</span> : <Muted>—</Muted>) },
    {
      title: '状态',
      key: 'status',
      width: 190,
      render: (_value, row) => (
        <div>
          <Tag color={STATUS_COLOR[row.status]} bordered={false}>
            {ADS_REPORT_STATUS_LABEL[row.status]}
          </Tag>
          {row.failureText ? <div style={{ color: 'var(--ant-color-error)', fontSize: 12 }}>{row.failureText}</div> : null}
        </div>
      ),
    },
    {
      title: '导入行数',
      key: 'rows',
      width: 130,
      align: 'right',
      render: (_value, row) =>
        row.importedRows === null ? (
          <Muted>—</Muted>
        ) : (
          <span className="erp-num">
            {formatNumber(row.importedRows)}
            {row.skippedRows ? <Muted>{`（跳过 ${formatNumber(row.skippedRows)}）`}</Muted> : null}
          </span>
        ),
    },
    {
      title: '警告',
      key: 'warnings',
      width: 90,
      render: (_value, row) =>
        row.warnings.length === 0 ? (
          <Muted>—</Muted>
        ) : (
          <Tooltip title={row.warnings.map(warning => warning.message).join('；')}>
            <Tag color="warning" bordered={false}>{`${row.warnings.length} 条警告`}</Tag>
          </Tooltip>
        ),
    },
    { title: '创建时间', key: 'createdAt', width: 160, render: (_value, row) => <span className="erp-num">{formatDateTime(row.createdAt)}</span> },
    { title: '操作', key: 'actions', width: 80, fixed: 'right', render: (_value, row) => (row.status === 'FAILED' ? <RetryAction row={row} onDone={onChanged} /> : null) },
  ]
}
