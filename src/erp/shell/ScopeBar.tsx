import { Alert, Button, Segmented, Select, Space, Tag } from 'antd'
import { useRouter, useSearch } from '@tanstack/react-router'
import { useApiQuery } from '../query/api-query'
import { describeError } from '../query/errors'
import { DateRangeControl, type CompareMode } from '../components/filter/DateRangeControl'
import { nextSearch, type ScopePatch } from '../scope/actions'
import { todayInMarketplace } from '../scope/dates'

// 全局范围栏（P1-04，03 章 3.2）：法律主体、店铺、站点（固定美国站）、时间范围与对比期、币种口径。
// 地址栏是唯一的真实来源：这里的每次选择都改写地址栏，页面从地址栏取同一份范围。

export type ScopeOptions = {
  granted: boolean
  unrestricted: boolean
  entities: Array<{ id: string; name: string }>
  stores: Array<{ id: string; name: string; sellerId: string; legalEntityId: string }>
  marketplace: { id: string; label: string }
  compareModes: Array<{ id: 'none' | 'previous' | 'yoy' | 'custom'; label: string }>
  currencies: Array<{ id: 'USD' | 'ORIGINAL'; label: string }>
}

export function ScopeBar() {
  const router = useRouter()
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const options = useApiQuery<ScopeOptions>({ domain: 'reference', path: '/scope/options', scoped: false })
  const today = todayInMarketplace()

  const apply = (patch: ScopePatch) => {
    void router.navigate({ search: ((prev: Record<string, unknown>) => nextSearch(prev, patch, today)) as never })
  }

  const entityIds = (search.legalEntityIds as string[] | undefined) ?? []
  const storeIds = (search.storeIds as string[] | undefined) ?? []
  const from = search.from as string | undefined
  const to = search.to as string | undefined
  const compare = (search.compare as string | undefined) ?? 'none'
  const currency = (search.displayCurrency as 'USD' | 'ORIGINAL' | undefined) ?? 'USD'

  if (options.isError) {
    const info = describeError(options.error)
    return (
      <div className="erp-scope-bar" data-testid="scope-bar">
        <Alert
          type="error"
          showIcon
          message={`范围选项加载失败：${info.message}`}
          action={
            <Button size="small" onClick={() => void options.refetch()}>
              重试
            </Button>
          }
        />
      </div>
    )
  }
  const data = options.data
  if (data && !data.granted) {
    return (
      <div className="erp-scope-bar" data-testid="scope-bar">
        <Alert type="warning" showIcon message="你还没有被授予任何店铺的数据访问范围，请联系企业管理员在“成员”里分配。" />
      </div>
    )
  }

  const visibleStores = (data?.stores ?? []).filter(store => entityIds.length === 0 || entityIds.includes(store.legalEntityId))

  return (
    <div className="erp-scope-bar" data-testid="scope-bar" role="group" aria-label="全局范围">
      <Space size={8} wrap>
        <Select
          mode="multiple"
          allowClear
          showSearch
          optionFilterProp="label"
          maxTagCount="responsive"
          style={{ minWidth: 168, maxWidth: 260 }}
          placeholder="全部主体"
          loading={options.isLoading}
          value={entityIds}
          options={(data?.entities ?? []).map(item => ({ value: item.id, label: item.name }))}
          onChange={value => apply({ legalEntityIds: value, storeIds: storeIds.filter(id => value.length === 0 || visibleStoreEntity(data, id, value)) })}
          aria-label="法律主体"
        />
        <Select
          mode="multiple"
          allowClear
          showSearch
          optionFilterProp="label"
          maxTagCount="responsive"
          style={{ minWidth: 168, maxWidth: 260 }}
          placeholder="全部店铺"
          loading={options.isLoading}
          value={storeIds}
          options={visibleStores.map(item => ({ value: item.id, label: item.name }))}
          onChange={value => apply({ storeIds: value })}
          aria-label="店铺"
        />
        <Tag bordered={false} color="blue" title="站点固定为亚马逊美国站">
          {data?.marketplace.label ?? '美国站 Amazon.com'}
        </Tag>
        <DateRangeControl
          today={today}
          range={from && to ? { from, to } : null}
          compare={compare as CompareMode}
          compareRange={search.compareFrom && search.compareTo ? { from: search.compareFrom as string, to: search.compareTo as string } : null}
          compareModes={data?.compareModes}
          onRangeChange={range => apply({ range })}
          onCompareChange={mode => apply({ compare: mode })}
          onCompareRangeChange={range => apply({ compareRange: range })}
        />
        {/* 对比方式不是“自定义”时的对比区间说明由 DateRangeControl 显示 */}
        <Segmented
          size="middle"
          value={currency}
          options={(
            data?.currencies ?? [
              { id: 'USD', label: '美元' },
              { id: 'ORIGINAL', label: '原币' },
            ]
          ).map(item => ({ value: item.id, label: item.label }))}
          onChange={value => apply({ displayCurrency: value as 'USD' | 'ORIGINAL' })}
          aria-label="币种口径"
        />
      </Space>
    </div>
  )
}

/** 选择主体后，已选店铺里不属于这些主体的要一并去掉。 */
function visibleStoreEntity(data: ScopeOptions | undefined, storeId: string, entityIds: string[]) {
  const store = data?.stores.find(item => item.id === storeId)
  return store ? entityIds.includes(store.legalEntityId) : false
}
