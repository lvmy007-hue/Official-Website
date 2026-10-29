import { useCallback, useMemo, useState } from 'react'
import { Alert, Card, Space, Typography } from 'antd'
import { LABEL_FONT_NOTE, LABEL_SIGN_WARNING, LABEL_TEMPLATE_LIMIT, type LabelTemplateListResponse, type LabelTemplateRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FilterBar, PageHeader, PagedGrid, useUrlFilters, type FilterField, type PageFetcher, type SearchMode, type ViewFilterBinding } from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { buildPath } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { CreateLabelTemplateAction, LabelTemplateRowActions } from './label-templates-actions'
import { LABEL_TEMPLATE_DEFAULT_SORT, LABEL_TEMPLATE_SORTABLE, labelTemplateColumns } from './label-templates-columns'

// 标签模板（P6-12，16 章第 5.1 节）：自定义箱标签的设置——纸张规格、追加的文字内容、标签顺序、箱号规则。
// 自定义箱标签在亚马逊箱标签的基础上追加文字（亚马逊标签本身不改动）；在入仓计划的“标签”页签按货件生成，文件在导出中心下载。
// 全企业最多 50 个模板、只有一个默认；增删改写审计，修改带版本号（别人先改过会提示刷新）。

const FIELDS: FilterField[] = []
const MODES: SearchMode[] = [{ id: 'keyword', label: '模板', key: 'q', placeholder: '搜索模板名称' }]

type Meta = Pick<LabelTemplateListResponse, 'summary' | 'canManage' | 'manageBlockedReason'>

export default function LabelTemplatesPage() {
  const { apiParams } = useScope()
  const url = useUrlFilters(FIELDS, MODES)
  const { values, replaceAll } = url
  const [meta, setMeta] = useState<Meta | null>(null)
  // 写操作成功后刷新列表：表格不走缓存，换一个重置键让它重新取（回到第 1 页）
  const [version, setVersion] = useState(0)
  const refresh = useCallback(() => setVersion(current => current + 1), [])

  const columns = useMemo(() => labelTemplateColumns(row => <LabelTemplateRowActions row={row} onDone={refresh} />), [refresh])

  const fetchPage = useCallback<PageFetcher<LabelTemplateRow>>(
    async ({ page, pageSize, sort, signal }) => {
      const path = buildPath('/label-templates', { ...apiParams, q: values.q, sort: sort ? `${sort.field}:${sort.direction}` : undefined, page, pageSize })
      const response = await apiFetch<LabelTemplateListResponse>(path, { signal })
      setMeta({ summary: response.summary, canManage: response.canManage, manageBlockedReason: response.manageBlockedReason })
      return { items: response.items, total: response.total }
    },
    [apiParams, values.q],
  )
  const viewFilters = useMemo<ViewFilterBinding>(() => ({ value: values, dimension: null, apply: (filters, dimension) => replaceAll(filters) + (dimension === null ? 0 : 1) }), [values, replaceAll])
  const narrowed = appliedCount(FIELDS, MODES, values) > 0

  return (
    <div>
      <PageHeader
        title="标签模板"
        description="自定义箱标签的设置：纸张规格、追加的文字、标签顺序和箱号规则。在入仓计划的“标签”页签选模板生成，文件在导出中心下载。"
        actions={<CreateLabelTemplateAction onDone={refresh} />}
      />
      {meta?.manageBlockedReason ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="你可以查看标签模板，但不能修改" description={meta.manageBlockedReason} /> : null}
      <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={LABEL_SIGN_WARNING} description={LABEL_FONT_NOTE} />
      {meta ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          <Space size={16}>
            <span>
              共 {meta.summary.total} 个模板（上限 {LABEL_TEMPLATE_LIMIT} 个）
            </span>
            <span>{meta.summary.defaultName ? `默认模板：${meta.summary.defaultName}` : '没有默认模板，不选模板时用系统内置的默认设置'}</span>
          </Space>
        </Typography.Paragraph>
      ) : null}
      <Card size="small" styles={{ body: { paddingTop: 12 } }}>
        <FilterBar fields={FIELDS} modes={MODES} values={values} onChange={url.set} onReset={url.reset} />
        <PagedGrid<LabelTemplateRow>
          gridId="settings.label-templates"
          serverViews
          viewFilters={viewFilters}
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          sortableFields={LABEL_TEMPLATE_SORTABLE}
          defaultSort={LABEL_TEMPLATE_DEFAULT_SORT}
          resetKey={JSON.stringify([apiParams, url.signature, version])}
          appliedFilterCount={appliedCount(FIELDS, MODES, values)}
          onClearFilters={url.reset}
          emptyState={{
            kind: 'empty',
            domain: '标签模板',
            prerequisite: narrowed ? '没有符合当前搜索的模板；可以放宽条件，或点“重置”。' : '还没有标签模板。点右上角“新增标签模板”；没有模板时生成自定义箱标签用系统内置的默认设置。',
          }}
          height={520}
        />
      </Card>
    </div>
  )
}
