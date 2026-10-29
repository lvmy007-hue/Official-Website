import type { ReactNode } from 'react'
import { Tag } from 'antd'
import { LENGTH_UNIT_LABEL, PACKING_FIELDS, PACKING_FIELD_LABEL, SKU_ALIAS_SOURCE_LABEL, WEIGHT_UNIT_LABEL, type PackingMappingRow, type SkuAliasRow } from '@nova/api-contracts'
import { actionColumn, dateTimeColumn, renderColumn, type ErpColDef } from '../../components'
import type { SortSpec } from '../../components/table/cursor-datasource'
import { EMPTY_VALUE } from '../../format'
import { Muted } from '../inventory/inventory-ui'

// 外部货号映射与装箱单列映射两张表的列（P6-11）。映射表服务端只允许按外部货号、SKU、更新时间排序。

export const SKU_ALIAS_SORT_FIELDS = { externalCode: 'externalCode', sku: 'sku', updatedAt: 'updatedAt' } as const
export const SKU_ALIAS_DEFAULT_SORT: SortSpec = { field: 'updatedAt', direction: 'desc' }

export function skuAliasColumns(actions: (row: SkuAliasRow) => ReactNode): ErpColDef<SkuAliasRow>[] {
  return [
    { headerName: '外部货号', colId: 'externalCode', pin: 'left', width: 220, valueGetter: ({ data }) => data?.externalCode ?? '' },
    renderColumn<SkuAliasRow>('对应 SKU', 'sku', row => <strong>{row.sku}</strong>, { width: 180 }),
    renderColumn<SkuAliasRow>('商品名称', 'skuTitle', row => (row.skuTitle ? <span title={row.skuTitle}>{row.skuTitle}</span> : <Muted>目录里没有标题</Muted>), { width: 280, sortable: false }),
    renderColumn<SkuAliasRow>('适用供应商', 'supplier', row => (row.supplierId ? `${row.supplierCode ?? ''} ${row.supplierName ?? ''}`.trim() : <Tag bordered={false}>通用（所有供应商）</Tag>), {
      width: 220,
      sortable: false,
    }),
    renderColumn<SkuAliasRow>('来源', 'source', row => SKU_ALIAS_SOURCE_LABEL[row.source], { width: 100, sortable: false }),
    dateTimeColumn<SkuAliasRow>('更新时间', 'updatedAt', { width: 170 }),
    actionColumn<SkuAliasRow>(actions, { width: 150 }),
  ]
}

const columnsText = (row: PackingMappingRow) => {
  const parts = PACKING_FIELDS.filter(field => row.columns[field]).map(field => `${PACKING_FIELD_LABEL[field]}＝${row.columns[field]}`)
  return parts.length > 0 ? parts.join('；') : EMPTY_VALUE
}

const unitsText = (row: PackingMappingRow) =>
  row.units ? [row.units.length ? LENGTH_UNIT_LABEL[row.units.length] : null, row.units.weight ? WEIGHT_UNIT_LABEL[row.units.weight] : null].filter(Boolean).join('、') : '未指定'

export function mappingColumns(actions: (row: PackingMappingRow) => ReactNode): ErpColDef<PackingMappingRow>[] {
  return [
    renderColumn<PackingMappingRow>('供应商', 'supplier', row => `${row.supplierCode} ${row.supplierName}`, { width: 220, pin: 'left', sortable: false }),
    renderColumn<PackingMappingRow>('列对应（标准列＝表头文字）', 'columns', row => <span title={columnsText(row)}>{columnsText(row)}</span>, { width: 520, sortable: false }),
    renderColumn<PackingMappingRow>('单位', 'units', unitsText, { width: 140, sortable: false }),
    dateTimeColumn<PackingMappingRow>('更新时间', 'updatedAt', { width: 170, sortable: false }),
    actionColumn<PackingMappingRow>(actions, { width: 110 }),
  ]
}
