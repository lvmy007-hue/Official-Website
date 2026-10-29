import { useCallback, useMemo, useState } from 'react'
import { useRouter, useSearch } from '@tanstack/react-router'
import { Alert, Card, Typography } from 'antd'
import { ALERT_RULE_DOMAIN_LABEL, buildAlertTemplates, type AlertRuleView, type AlertRulesResponse } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FilterBar, PageHeader, PagedGrid, useUrlFilters, type FilterField, type PageFetcher, type SearchMode, type ViewFilterBinding } from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { Muted } from '../inventory/inventory-ui'
import { ruleColumns } from './alert-rules-columns'
import { RuleCreateAction } from './alert-rule-fields'
import type { ScopeNames } from './alert-rules-ui'

// 预警规则配置（P5-01，09 章 9.1；P6-16 迁到 PagedGrid 骨架并加条件构造器、通知频率、静默汇总、多级升级）：阈值或指标条件、作用范围、通知对象、静默时段、规则版本、规则质量统计。
// 质量统计只算你数据范围内最近 90 天首次触发的预警：误报率 = 标为“误报”的 ÷ 被人处理的；平均处理时长 = 从首次触发到被人处理完成。
// 09 章列出但依赖项还没交付的预警类型显示在页面底部的“尚未接入”，不生成规则行（没有评估逻辑的规则不会产生预警，也不会被显示成“没有风险”）。
// 规则接口一次返回全部规则（企业级设置，上限 500 条），业务域与关键词筛选、分页都在本页完成。

const FIELDS: FilterField[] = [
  { key: 'domain', label: '业务域', kind: 'select', options: Object.entries(ALERT_RULE_DOMAIN_LABEL).map(([value, label]) => ({ value, label })) },
  {
    key: 'enabled',
    label: '状态',
    kind: 'select',
    options: [
      { value: 'on', label: '启用' },
      { value: 'off', label: '已关闭' },
    ],
  },
]
const MODES: SearchMode[] = [{ id: 'keyword', label: '规则', key: 'q', placeholder: '搜索规则名称或条件' }]

const matches = (rule: AlertRuleView, q: string) => [rule.name, rule.description, rule.conditionText ?? ''].some(text => text.toLowerCase().includes(q))

export default function AlertRulesPage() {
  const url = useUrlFilters(FIELDS, MODES)
  const { values, replaceAll } = url
  const [data, setData] = useState<AlertRulesResponse | null>(null)
  // 保存或新建成功后刷新：表格不走缓存，换一个重置键让它重新取
  const [version, setVersion] = useState(0)
  const refresh = useCallback(() => setVersion(current => current + 1), [])
  // 从规则模板页跳过来：地址栏带 template=模板代码，打开“从模板新建”（关闭或创建后清掉参数，刷新页面不再弹）
  const router = useRouter()
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const template = useMemo(() => (typeof search.template === 'string' ? buildAlertTemplates().find(item => item.code === search.template) : undefined), [search.template])
  const clearTemplate = useCallback(() => void router.navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, template: undefined })) as never, replace: true }), [router])
  const names = useMemo<ScopeNames>(() => ({ members: new Map((data?.members ?? []).map(member => [member.id, member.name])) }), [data])
  const columns = useMemo(() => (data ? ruleColumns(data, names, refresh) : []), [data, names, refresh])

  const fetchPage = useCallback<PageFetcher<AlertRuleView>>(
    async ({ page, pageSize, signal }) => {
      const response = await apiFetch<AlertRulesResponse>('/alerts/rules', { signal })
      setData(response)
      const q = (values.q ?? '').trim().toLowerCase()
      const rows = response.items.filter(rule => (!values.domain || rule.domain === values.domain) && (!values.enabled || rule.enabled === (values.enabled === 'on')) && (!q || matches(rule, q)))
      return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length }
    },
    [values.domain, values.enabled, values.q],
  )
  const viewFilters = useMemo<ViewFilterBinding>(() => ({ value: values, dimension: null, apply: (filters, dimension) => replaceAll(filters) + (dimension === null ? 0 : 1) }), [values, replaceAll])
  const narrowed = appliedCount(FIELDS, MODES, values) > 0

  return (
    <div data-testid="alert-rules-page">
      <PageHeader
        title="预警规则配置"
        description={`调整阈值或指标条件、通知频率与多级升级、作用范围、通知对象与静默时段（企业时区：${data?.timezone ?? '读取中'}）。每次保存生成新版本；质量统计只算你数据范围内最近 90 天的预警。`}
        actions={data ? <RuleCreateAction data={data} onChanged={refresh} template={template} onClose={clearTemplate} /> : undefined}
      />
      {data?.note ? <Alert type="info" showIcon style={{ marginBottom: 12 }} message={data.note} /> : null}
      <Card size="small" styles={{ body: { paddingTop: 12 } }}>
        <FilterBar fields={FIELDS} modes={MODES} values={values} onChange={url.set} onReset={url.reset} />
        <PagedGrid<AlertRuleView>
          gridId="alerts.rules"
          serverViews
          viewFilters={viewFilters}
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          resetKey={JSON.stringify([url.signature, version])}
          appliedFilterCount={appliedCount(FIELDS, MODES, values)}
          onClearFilters={url.reset}
          emptyState={{ kind: 'empty', domain: '预警规则', prerequisite: narrowed ? '没有符合条件的规则；可以放宽搜索与筛选，或点“重置”。' : (data?.note ?? '尚无记录') }}
          height={560}
        />
      </Card>
      {data && data.unconnected.length > 0 ? (
        <Card size="small" title="尚未接入的预警类型" data-testid="unconnected-alerts" style={{ marginTop: 12 }}>
          {data.unconnected.map(item => (
            <div key={item.key} style={{ marginBottom: 8 }}>
              <Typography.Text strong>{item.name}</Typography.Text>（{ALERT_RULE_DOMAIN_LABEL[item.domain]}）
              <div>
                <Muted>尚未接入：{item.reason}</Muted>
              </div>
            </div>
          ))}
        </Card>
      ) : null}
    </div>
  )
}
