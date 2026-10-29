import { useCallback, useMemo, useState } from 'react'
import { Card } from 'antd'
import { ALERT_TEMPLATE_GROUPS, ALERT_TEMPLATE_GROUP_LABEL, type AlertTemplateItem, type AlertTemplatesResponse } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FilterBar, PageHeader, PagedGrid, useUrlFilters, type FilterField, type PageFetcher, type SearchMode, type ViewFilterBinding } from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { AppLink } from '../../nav/AppLink'
import { templateColumns } from './alert-templates-columns'

// 预警规则模板（P6-15，16 章第 9 节）：由系统预置规则生成，按库存、广告、销售、流量、店铺分组；一句话写清条件与适用维度。
// “从模板新建”跳到规则配置并带入模板的评估逻辑、严重度、冷却与默认阈值；模板本身是静态目录，企业里已有的同逻辑规则数从规则表统计。
// 页面一次取回全部模板，搜索与分组筛选、分页都在本页完成（目录只有几十条，没有排序列）。

const FIELDS: FilterField[] = [{ key: 'group', label: '分组', kind: 'select', options: ALERT_TEMPLATE_GROUPS.map(value => ({ value, label: ALERT_TEMPLATE_GROUP_LABEL[value] })) }]
const MODES: SearchMode[] = [{ id: 'keyword', label: '模板', key: 'q', placeholder: '搜索模板名称、条件或适用维度' }]

const matches = (item: AlertTemplateItem, q: string) => [item.name, item.condition, item.dimension, item.description].some(text => text.toLowerCase().includes(q))

export default function AlertTemplatesPage() {
  const url = useUrlFilters(FIELDS, MODES)
  const { values, replaceAll } = url
  const [canCreate, setCanCreate] = useState(false)
  const columns = useMemo(() => templateColumns(canCreate), [canCreate])

  const fetchPage = useCallback<PageFetcher<AlertTemplateItem>>(
    async ({ page, pageSize, signal }) => {
      const response = await apiFetch<AlertTemplatesResponse>('/alerts/templates', { signal })
      setCanCreate(response.can.create)
      const q = (values.q ?? '').trim().toLowerCase()
      const rows = response.items.filter(item => (!values.group || item.group === values.group) && (!q || matches(item, q)))
      return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length }
    },
    [values.group, values.q],
  )
  const viewFilters = useMemo<ViewFilterBinding>(() => ({ value: values, dimension: null, apply: (filters, dimension) => replaceAll(filters) + (dimension === null ? 0 : 1) }), [values, replaceAll])
  const narrowed = appliedCount(FIELDS, MODES, values) > 0

  return (
    <div data-testid="alert-templates-page">
      <PageHeader
        title="预警规则模板"
        description="系统预置的预警规则，按库存、广告、销售、流量、店铺分组，每条一句话写清条件和适用维度。点“从模板新建”会打开规则配置，带入模板的评估逻辑、严重度、冷却和默认阈值。"
        actions={<AppLink to="/app/alerts">返回预警中心</AppLink>}
      />
      <Card size="small" styles={{ body: { paddingTop: 12 } }}>
        <FilterBar fields={FIELDS} modes={MODES} values={values} onChange={url.set} onReset={url.reset} />
        <PagedGrid<AlertTemplateItem>
          gridId="alerts.templates"
          serverViews
          viewFilters={viewFilters}
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.code}
          resetKey={JSON.stringify([url.signature])}
          appliedFilterCount={appliedCount(FIELDS, MODES, values)}
          onClearFilters={url.reset}
          emptyState={{ kind: 'empty', domain: '规则模板', prerequisite: narrowed ? '没有符合条件的模板；可以放宽搜索与筛选，或点“重置”。' : '尚无规则模板。' }}
          height={520}
        />
      </Card>
    </div>
  )
}
