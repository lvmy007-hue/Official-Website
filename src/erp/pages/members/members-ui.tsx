import { Form, Radio, Select, Tag } from 'antd'
import { SCOPE_EMPTY_MESSAGE, memberStatusLabel, type MemberGrantView, type ScopeInput } from '@nova/api-contracts'
import { formatDateTime } from '../../format'
import { useApiQuery } from '../../query/api-query'
import type { ScopeOptions } from '../../shell/ScopeBar'
import { Muted } from '../inventory/inventory-ui'

// 成员页面共用的小件：状态标签、最近登录写法、数据范围选择（全部，或指定主体与店铺）及提交内容的整理。

export function MemberStatusTag({ status }: { status: string }) {
  return (
    <Tag bordered={false} color={status === 'ACTIVE' ? 'success' : 'default'}>
      {memberStatusLabel(status)}
    </Tag>
  )
}

/** 从未登录过写“尚未登录”，不留空。 */
export const lastLoginText = (value: string | null) => (value ? formatDateTime(value) : <Muted>尚未登录</Muted>)

export const roleOptionsOf = (roles: readonly { id: string; name: string }[] | undefined) => (roles ?? []).map(role => ({ value: role.id, label: role.name }))

type ScopeValues = Record<string, unknown> & { scopeMode?: 'ALL' | 'SPECIFIC'; legalEntityIds?: string[]; sellerAccountIds?: string[] }

/** 数据范围的表单字段：先选“全部”或“指定”，指定时分别选主体与店铺（选主体 = 名下现在和以后新增的店铺都可见）。 */
export function ScopeFields() {
  const options = useApiQuery<ScopeOptions>({ domain: 'reference', path: '/scope/options', scoped: false })
  const entities = (options.data?.entities ?? []).map(entity => ({ value: entity.id, label: entity.name }))
  const stores = (options.data?.stores ?? []).map(store => ({ value: store.id, label: store.name }))
  const atLeastOne = ({ getFieldValue }: { getFieldValue: (name: string) => unknown }) => ({
    validator: () =>
      ((getFieldValue('legalEntityIds') as string[] | undefined)?.length ?? 0) + ((getFieldValue('sellerAccountIds') as string[] | undefined)?.length ?? 0) > 0
        ? Promise.resolve()
        : Promise.reject(new Error(SCOPE_EMPTY_MESSAGE)),
  })
  return (
    <>
      <Form.Item label="数据范围" name="scopeMode" rules={[{ required: true, message: '请选择数据范围' }]}>
        <Radio.Group
          options={[
            { value: 'ALL', label: '全部主体与店铺' },
            { value: 'SPECIFIC', label: '指定主体与店铺' },
          ]}
        />
      </Form.Item>
      <Form.Item noStyle shouldUpdate={(before: ScopeValues, after: ScopeValues) => before.scopeMode !== after.scopeMode}>
        {({ getFieldValue }) =>
          getFieldValue('scopeMode') === 'SPECIFIC' ? (
            <>
              <Form.Item label="指定主体" name="legalEntityIds" rules={[atLeastOne]} extra="选了主体，名下现在和以后新增的店铺都可见。">
                <Select mode="multiple" allowClear aria-label="指定主体" placeholder="选择主体" loading={options.isPending} options={entities} optionFilterProp="label" />
              </Form.Item>
              <Form.Item label="指定店铺" name="sellerAccountIds">
                <Select mode="multiple" allowClear aria-label="指定店铺" placeholder="选择店铺" loading={options.isPending} options={stores} optionFilterProp="label" />
              </Form.Item>
            </>
          ) : null
        }
      </Form.Item>
    </>
  )
}

/** 表单值 → 接口的范围请求体。 */
export function scopeBody(values: ScopeValues): ScopeInput {
  const specific = values.scopeMode === 'SPECIFIC'
  return { all: !specific, legalEntityIds: specific ? (values.legalEntityIds ?? []) : [], sellerAccountIds: specific ? (values.sellerAccountIds ?? []) : [] }
}

/** 详情页“修改数据范围”表单的初始值：从现有授权回填。 */
export function scopeInitialOf(grants: readonly MemberGrantView[]): ScopeValues {
  const all = grants.length === 0 || grants.some(grant => grant.kind === 'ALL')
  return {
    scopeMode: all ? 'ALL' : 'SPECIFIC',
    legalEntityIds: grants.flatMap(grant => (grant.kind === 'ENTITY' && grant.refId ? [grant.refId] : [])),
    sellerAccountIds: grants.flatMap(grant => (grant.kind === 'STORE' && grant.refId ? [grant.refId] : [])),
  }
}
