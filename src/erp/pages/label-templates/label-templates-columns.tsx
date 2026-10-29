import type { ICellRendererParams } from 'ag-grid-community'
import { Space, Tag } from 'antd'
import type { ReactNode } from 'react'
import { LABEL_OPTION_META, LABEL_ORDER_LABEL, LABEL_PAPER_SPEC, boxNoPreview, type LabelOptions, type LabelTemplateRow } from '@nova/api-contracts'
import { actionColumn, dateTimeColumn, renderColumn, type ErpColDef } from '../../components'
import type { SortSpec } from '../../components/table/cursor-datasource'

// 标签模板表的列（P6-12，16 章第 5.1 节）：名称带“默认”标记、纸张、会印的内容、箱号预览、排序、更新时间、操作。
// 服务端只允许按名称与更新时间排序。

type Cell = ICellRendererParams<LabelTemplateRow>

export const LABEL_TEMPLATE_SORTABLE = { name: 'name', updatedAt: 'updatedAt' } as const
export const LABEL_TEMPLATE_DEFAULT_SORT: SortSpec = { field: 'updatedAt', direction: 'desc' }

/** 模板会印的内容，一句话列出（勾选了但不满足条件的内容，生成时才会被略去，这里只说“勾选了什么”）。 */
export function optionsSummary(options: LabelOptions): string {
  const picked = LABEL_OPTION_META.filter(item => options[item.key]).map(item => (item.key === 'showOrigin' ? `原产地（${options.originText}）` : item.label))
  return picked.length > 0 ? picked.join('、') : '没有勾选任何内容'
}

export function labelTemplateColumns(actions: (row: LabelTemplateRow) => ReactNode): ErpColDef<LabelTemplateRow>[] {
  return [
    {
      headerName: '模板名称',
      colId: 'name',
      pin: 'left',
      width: 220,
      valueGetter: ({ data }) => data?.name ?? '',
      cellRenderer: ({ data }: Cell) =>
        data ? (
          <Space size={6}>
            <strong>{data.name}</strong>
            {data.isDefault ? (
              <Tag color="blue" bordered={false} style={{ marginInlineEnd: 0 }}>
                默认
              </Tag>
            ) : null}
          </Space>
        ) : null,
    },
    { headerName: '纸张', colId: 'paper', width: 150, sortable: false, valueGetter: ({ data }) => (data ? LABEL_PAPER_SPEC[data.paper].label : '') },
    {
      headerName: '会印的内容',
      colId: 'content',
      width: 360,
      sortable: false,
      valueGetter: ({ data }) => (data ? optionsSummary(data.options) : ''),
      tooltipValueGetter: ({ data }) => (data ? optionsSummary(data.options) : ''),
    },
    renderColumn<LabelTemplateRow>('箱号示例', 'boxNo', row => <span className="erp-num">{boxNoPreview(row.boxNoRule, 'PLAN', 2).join('、')}</span>, { width: 170, sortable: false }),
    { headerName: '标签顺序', colId: 'order', width: 130, sortable: false, valueGetter: ({ data }) => (data ? LABEL_ORDER_LABEL[data.options.order] : '') },
    dateTimeColumn<LabelTemplateRow>('更新时间', 'updatedAt', { width: 170 }),
    actionColumn<LabelTemplateRow>(actions, { width: 270 }),
  ]
}
