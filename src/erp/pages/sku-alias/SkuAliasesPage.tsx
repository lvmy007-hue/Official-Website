import { useCallback, useMemo, useState } from 'react'
import { Alert, Card, Space, Tabs, Typography } from 'antd'
import { SKU_ALIAS_GENERAL, SKU_ALIAS_SOURCES, SKU_ALIAS_SOURCE_LABEL, type SkuAliasListResponse, type SkuAliasRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FilterBar, PageHeader, PagedGrid, useUrlFilters, type FilterField, type PageFetcher, type SearchMode, type ViewFilterBinding } from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { buildPath } from '../../query/api-query'
import { MappingsTab } from './MappingsTab'
import { AliasRowActions, CreateAliasAction, ExportAliasButton, ImportAliasAction, useSupplierOptions } from './sku-alias-actions'
import { SKU_ALIAS_DEFAULT_SORT, SKU_ALIAS_SORT_FIELDS, skuAliasColumns } from './sku-alias-columns'

// 外部货号映射（P6-11，16 章第 5 节）：供应商装箱单里的货号（或条码）对应我们的 SKU。装箱单匹配时先精确比对 SKU、FNSKU、ASIN，再查这里。
// 同一个供应商的同一个外部货号只能有一条；通用映射（不选供应商）所有供应商都能用，供应商专属的优先。增删改写审计，修改带版本号。
// 另有“装箱单列映射”页签：每个供应商保存的列对应。

type Meta = Pick<SkuAliasListResponse, 'summary' | 'canManage' | 'manageBlockedReason'>
const MODES: SearchMode[] = [{ id: 'keyword', label: '货号', key: 'q', placeholder: '搜索外部货号或 SKU' }]

export default function SkuAliasesPage() {
  const supplierOptions = useSupplierOptions()
  const fields = useMemo<FilterField[]>(
    () => [
      { key: 'supplierId', label: '适用供应商', kind: 'select', width: 220, options: [{ value: SKU_ALIAS_GENERAL, label: '只看通用映射' }, ...supplierOptions] },
      { key: 'source', label: '来源', kind: 'select', width: 120, options: SKU_ALIAS_SOURCES.map(value => ({ value, label: SKU_ALIAS_SOURCE_LABEL[value] })) },
    ],
    [supplierOptions],
  )
  const url = useUrlFilters(fields, MODES)
  const { values, replaceAll } = url
  const [meta, setMeta] = useState<Meta | null>(null)
  const [version, setVersion] = useState(0)
  const refresh = useCallback(() => setVersion(current => current + 1), [])
  const columns = useMemo(() => skuAliasColumns(row => <AliasRowActions row={row} onDone={refresh} />), [refresh])

  const fetchPage = useCallback<PageFetcher<SkuAliasRow>>(
    async ({ page, pageSize, sort, signal }) => {
      const path = buildPath('/sku-aliases', { supplierId: values.supplierId, source: values.source, q: values.q, sort: sort ? `${sort.field}:${sort.direction}` : undefined, page, pageSize })
      const response = await apiFetch<SkuAliasListResponse>(path, { signal })
      setMeta({ summary: response.summary, canManage: response.canManage, manageBlockedReason: response.manageBlockedReason })
      return { items: response.items, total: response.total }
    },
    [values.supplierId, values.source, values.q],
  )
  const viewFilters = useMemo<ViewFilterBinding>(() => ({ value: values, dimension: null, apply: (filters, dimension) => replaceAll(filters) + (dimension === null ? 0 : 1) }), [values, replaceAll])
  const narrowed = appliedCount(fields, MODES, values) > 0

  const aliasTab = (
    <div>
      {meta?.manageBlockedReason ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="你可以查看外部货号映射，但不能修改" description={meta.manageBlockedReason} /> : null}
      {meta ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          <Space size={16}>
            <span>共 {meta.summary.total} 条映射</span>
            <span>通用 {meta.summary.general} 条</span>
            <span>供应商专属 {meta.summary.supplier} 条</span>
          </Space>
        </Typography.Paragraph>
      ) : null}
      <Card size="small" styles={{ body: { paddingTop: 12 } }}>
        <FilterBar fields={fields} modes={MODES} values={values} onChange={url.set} onReset={url.reset} />
        <PagedGrid<SkuAliasRow>
          gridId="settings.sku-aliases"
          serverViews
          viewFilters={viewFilters}
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          sortableFields={SKU_ALIAS_SORT_FIELDS}
          defaultSort={SKU_ALIAS_DEFAULT_SORT}
          resetKey={JSON.stringify([url.signature, version])}
          appliedFilterCount={appliedCount(fields, MODES, values)}
          onClearFilters={url.reset}
          emptyState={{
            kind: 'empty',
            domain: '外部货号映射',
            prerequisite: narrowed
              ? '没有符合当前搜索与筛选的映射；可以放宽条件，或点“重置”。'
              : '还没有外部货号映射。点右上角“新增映射”，或用“文件导入”一次导入多条；在装箱单匹配里选好 SKU 后勾选“记住”也会自动生成。',
          }}
          height={520}
        />
      </Card>
    </div>
  )

  return (
    <div>
      <PageHeader
        title="外部货号映射"
        description="供应商装箱单里的货号（或条码）对应我们的哪个 SKU。入仓计划的“装箱单匹配”会先精确比对 SKU、FNSKU、ASIN，再查这里；商品条码（UPC、EAN）目录里尚未接入，可以先记在这里。"
        actions={
          <Space>
            <ExportAliasButton />
            <ImportAliasAction onDone={refresh} />
            <CreateAliasAction onDone={refresh} />
          </Space>
        }
      />
      <Tabs
        size="small"
        items={[
          { key: 'aliases', label: '外部货号映射', children: aliasTab },
          { key: 'mappings', label: '装箱单列映射', children: <MappingsTab /> },
        ]}
      />
    </div>
  )
}
