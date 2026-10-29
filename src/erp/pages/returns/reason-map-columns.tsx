import type { ReactNode } from 'react'
import { Tag } from 'antd'
import type { ReturnReasonMapRow, ReturnReasonSource } from '@nova/api-contracts'
import { actionColumn, dateTimeColumn, renderColumn, type ErpColDef } from '../../components'
import type { SortSpec } from '../../components/table/cursor-datasource'
import { Muted } from '../inventory/inventory-ui'
import { CategoryText } from './returns-ui'

// 原因映射表的列（P6-13，16 章第 6 节）：原因代码、中文释义、大类、来源、预置的出厂值、更新时间、操作。服务端只允许按代码、大类、更新时间排序。

export const REASON_MAP_SORTABLE = { code: 'code', category: 'category', updatedAt: 'updatedAt' } as const
export const REASON_MAP_DEFAULT_SORT: SortSpec = { field: 'category', direction: 'asc' }

export const REASON_SOURCE_LABEL: Readonly<Record<Exclude<ReturnReasonSource, 'UNMAPPED' | 'NONE'>, string>> = {
  PRESET: '预置',
  PRESET_EDITED: '预置（已修改）',
  CUSTOM: '自己添加',
  AUTO: '导入时自动加入，待补全',
}

const sourceTag = (row: ReturnReasonMapRow) => (
  <Tag color={row.source === 'AUTO' ? 'warning' : row.source === 'PRESET' ? 'default' : 'processing'} bordered={false}>
    {REASON_SOURCE_LABEL[row.source]}
  </Tag>
)

export function reasonMapColumns(actions: (row: ReturnReasonMapRow) => ReactNode): ErpColDef<ReturnReasonMapRow>[] {
  return [
    renderColumn<ReturnReasonMapRow>('原因代码', 'code', row => <span className="erp-num">{row.code}</span>, { pin: 'left', width: 240 }),
    renderColumn<ReturnReasonMapRow>('中文释义', 'labelZh', row => row.labelZh, { width: 200, sortable: false }),
    renderColumn<ReturnReasonMapRow>('大类', 'category', row => <CategoryText category={row.category} />, { width: 150 }),
    renderColumn<ReturnReasonMapRow>('来源', 'source', sourceTag, { width: 220, sortable: false }),
    renderColumn<ReturnReasonMapRow>('预置的释义与大类', 'preset', row => (row.presetLabelZh ? `${row.presetLabelZh} / ${row.presetCategory}` : <Muted>无（自己添加的项）</Muted>), {
      width: 240,
      sortable: false,
    }),
    dateTimeColumn<ReturnReasonMapRow>('更新时间', 'updatedAt', { width: 180 }),
    actionColumn<ReturnReasonMapRow>(actions, { width: 190 }),
  ]
}
