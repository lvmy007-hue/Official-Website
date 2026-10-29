import { Alert } from 'antd'
import { PACKING_FIELDS, PACKING_FIELD_LABEL, SKU_ALIAS_MANAGE, type PackingField, type PackingMappingOneResponse, type PackingPreviewResponse } from '@nova/api-contracts'
import { apiFetch } from '../../../../api'
import { FormAction } from '../../../components'
import { unitsOrDefault, type PackingSettings } from './packing-list-state'

// 把这份装箱单的“列对应”和单位存为该供应商的列映射（下次选同一个供应商，同样格式的装箱单自动对上列）。
// 保存的是“标准列 → 表头文字”，不是列序号，所以供应商调整列的顺序也不影响。需要“维护外部货号映射与装箱单列映射”权限。

/** 当前生效的列对应（手动改过的优先）→ 表头文字。 */
export function mappingColumns(analysis: PackingPreviewResponse, settings: PackingSettings): Partial<Record<PackingField, string>> {
  const result: Partial<Record<PackingField, string>> = {}
  for (const field of PACKING_FIELDS) {
    const given = settings.columns[field]
    const index = given === undefined ? analysis.columns[field] : given
    const header = typeof index === 'number' ? analysis.headers[index]?.trim() : ''
    if (header) result[field] = header
  }
  return result
}

export function SaveMappingAction({ analysis, settings }: { analysis: PackingPreviewResponse | null; settings: PackingSettings }) {
  const supplierId = settings.supplierId
  const columns = analysis && !analysis.fatal ? mappingColumns(analysis, settings) : {}
  const count = Object.keys(columns).length
  const reason = !supplierId ? '先选择供应商（列映射按供应商保存）' : !analysis || analysis.fatal ? '先选择并识别装箱单' : count === 0 ? '还没有识别出任何列' : undefined
  return (
    <FormAction
      label="保存为该供应商的列映射"
      guard={{ permission: SKU_ALIAS_MANAGE, condition: { ok: !reason, reason } }}
      title="保存列映射"
      description={
        <Alert
          type="info"
          showIcon
          message={`将保存 ${count} 个列对应：${PACKING_FIELDS.filter(field => columns[field])
            .map(field => `${PACKING_FIELD_LABEL[field]}=${columns[field]}`)
            .join('、')}`}
          description="已有映射会被这一份替换；保存后该供应商之后的装箱单会按表头文字自动对列。"
        />
      }
      okText="保存"
      successText="已保存列映射"
      onSubmit={async () => {
        if (!supplierId || !analysis) throw new Error('先选择供应商并识别装箱单')
        const current = await apiFetch<PackingMappingOneResponse>(`/packing-list-mappings/${encodeURIComponent(supplierId)}`)
        const units = unitsOrDefault(settings.units, analysis.units)
        await apiFetch(`/packing-list-mappings/${encodeURIComponent(supplierId)}`, {
          method: 'PUT',
          body: JSON.stringify({ ...(current.mapping ? { version: current.mapping.version } : {}), columns, units }),
        })
      }}
    />
  )
}
