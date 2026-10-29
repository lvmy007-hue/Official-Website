import { Tag, Typography } from 'antd'
import type { ReactNode } from 'react'
import type { InboundLabelView, LabelPrintStat } from '@nova/api-contracts'
import { actionColumn, dateTimeColumn, renderColumn, type ErpColDef } from '../../../components'
import { EMPTY_VALUE } from '../../../format'
import { safeHttpUrl } from '../../../security/safe-url'

// 入仓计划“标签”页签的两张表（P6-12）：按货件的生成统计（自定义箱标签与商品标签各生成过几次、已取到哪些亚马逊箱标签），
// 以及亚马逊箱标签文件（向亚马逊获取的 PDF，自定义箱标签以它为底）。

const pageName = (value: string) => value.replace('PackageLabel_', '')

export function shipmentStatColumns(actions: (row: LabelPrintStat) => ReactNode): ErpColDef<LabelPrintStat>[] {
  return [
    { headerName: '货件编号', colId: 'shipmentId', pin: 'left', width: 180, valueGetter: ({ data }) => data?.shipmentId ?? '' },
    renderColumn<LabelPrintStat>('箱数', 'boxes', row => (row.boxes === null ? <Typography.Text type="secondary">尚无记录</Typography.Text> : <span className="erp-num">{row.boxes}</span>), {
      width: 100,
      type: 'rightAligned',
    }),
    renderColumn<LabelPrintStat>(
      '已取到的亚马逊箱标签',
      'readyPageTypes',
      row => (row.readyPageTypes.length === 0 ? <Typography.Text type="secondary">还没取到</Typography.Text> : <span>{row.readyPageTypes.map(pageName).join('、')}</span>),
      { width: 260, tooltipValueGetter: ({ data }) => data?.readyPageTypes.join('、') ?? '' },
    ),
    renderColumn<LabelPrintStat>('自定义箱标签（次）', 'customCount', row => <span className="erp-num">{row.customCount}</span>, {
      width: 150,
      type: 'rightAligned',
    }),
    renderColumn<LabelPrintStat>('商品标签（次）', 'itemCount', row => <span className="erp-num">{row.itemCount}</span>, { width: 130, type: 'rightAligned' }),
    dateTimeColumn<LabelPrintStat>('最近生成', 'lastPrintedAt', { width: 170 }),
    actionColumn<LabelPrintStat>(actions, { width: 360 }),
  ]
}

export function labelFileColumns(): ErpColDef<InboundLabelView>[] {
  return [
    renderColumn<InboundLabelView>('类型', 'kind', row => (row.kind === 'BOX' ? '亚马逊箱标签' : '商品标签清单（旧，已停用）'), { width: 190 }),
    renderColumn<InboundLabelView>('货件', 'shipmentId', row => row.shipmentId ?? <Typography.Text type="secondary">全部</Typography.Text>, { width: 180 }),
    renderColumn<InboundLabelView>('状态', 'status', row => (row.status === 'FAILED' ? <Tag color="error">{row.statusLabel}</Tag> : row.statusLabel), { width: 110 }),
    renderColumn<InboundLabelView>('纸张', 'pageType', row => (row.pageType ? pageName(row.pageType) : EMPTY_VALUE), { width: 200 }),
    dateTimeColumn<InboundLabelView>('创建时间', 'createdAt', { width: 170 }),
    renderColumn<InboundLabelView>(
      '下载（5 分钟内有效）',
      'url',
      row => {
        const href = safeHttpUrl(row.url)
        if (href) {
          return (
            <a href={href} target="_blank" rel="noopener noreferrer">
              下载
            </a>
          )
        }
        return row.errorMessage ? <Typography.Text type="danger">{row.errorMessage}</Typography.Text> : <Typography.Text type="secondary">生成中</Typography.Text>
      },
      { width: 280, sortable: false },
    ),
  ]
}
