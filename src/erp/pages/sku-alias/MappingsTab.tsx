import { useCallback, useMemo, useState } from 'react'
import { Alert, Typography } from 'antd'
import { SKU_ALIAS_MANAGE, type PackingMappingListResponse, type PackingMappingRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FormAction, PagedGrid, type PageFetcher } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { mappingColumns } from './sku-alias-columns'

// 装箱单列映射（P6-11）：每个供应商一份“标准列 → 装箱单表头文字”。在入仓计划的“装箱单匹配”里识别出列后点“保存为该供应商的列映射”即可生成；
// 这里集中查看与删除。存的是表头文字而不是列序号，供应商调整列顺序也不影响。

export function MappingsTab() {
  const [meta, setMeta] = useState<Pick<PackingMappingListResponse, 'canManage' | 'manageBlockedReason'> | null>(null)
  const [version, setVersion] = useState(0)
  const refresh = useCallback(() => setVersion(current => current + 1), [])
  const remove = useApiMutation<string, { supplierId: string }>({
    method: 'DELETE',
    path: id => `/packing-list-mappings/${encodeURIComponent(id)}`,
    body: () => undefined,
    invalidate: ['list', 'reference'],
    silent: true,
  })

  // 映射按供应商一份，数量有限（一个供应商一条）：一次取回后在本地分页
  const fetchPage = useCallback<PageFetcher<PackingMappingRow>>(async ({ page, pageSize, signal }) => {
    const response = await apiFetch<PackingMappingListResponse>('/packing-list-mappings', { signal })
    setMeta({ canManage: response.canManage, manageBlockedReason: response.manageBlockedReason })
    return { items: response.items.slice((page - 1) * pageSize, page * pageSize), total: response.items.length }
  }, [])

  const columns = useMemo(
    () =>
      mappingColumns(row => (
        <FormAction
          label="删除"
          guard={{ permission: SKU_ALIAS_MANAGE }}
          title={`删除「${row.supplierName}」的列映射`}
          description="删除后，这个供应商的装箱单要重新识别列（识别不出时需要手动指定）。已经写进箱内物品的数据不受影响。"
          okText="删除"
          successText="已删除"
          danger
          buttonProps={{ size: 'small' }}
          onSubmit={() => remove.mutateAsync(row.supplierId)}
          onDone={refresh}
        />
      )),
    [remove, refresh],
  )

  return (
    <div>
      <Typography.Paragraph type="secondary">
        每个供应商保存一份列映射：入仓计划的“装箱单匹配”里选了供应商，会先按这里保存的表头文字找列，找不到的再自动识别。要新增或修改，请在“装箱单匹配”里选好列后点“保存为该供应商的列映射”。
      </Typography.Paragraph>
      {meta?.manageBlockedReason ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="你可以查看列映射，但不能修改" description={meta.manageBlockedReason} /> : null}
      <PagedGrid<PackingMappingRow>
        gridId="settings.packing-list-mappings"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => row.supplierId}
        resetKey={String(version)}
        emptyState={{ kind: 'empty', domain: '装箱单列映射', prerequisite: '还没有保存过列映射。在入仓计划的“装箱单匹配”里识别一份装箱单后，点“保存为该供应商的列映射”。' }}
        height={420}
      />
    </div>
  )
}
