import { useCallback, useMemo, useState } from 'react'
import { Badge, Card, Space, Tabs } from 'antd'
import {
  ALERT_DOMAINS,
  ALERT_READ_STATES,
  ALERT_READ_STATE_LABEL,
  ALERT_RULE_DOMAIN_LABEL,
  ALERT_SEVERITIES,
  ALERT_SEVERITY_LABEL,
  ALERT_VIEWS,
  ALERT_VIEW_LABEL,
  type AlertListItem,
  type AlertListResponse,
  type AlertView,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FilterBar, MassiveGrid, PageHeader, useUrlFilters, type CursorFetcher, type FilterField, type SearchMode, type ViewFilterBinding } from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { AppLink } from '../../nav/AppLink'
import { buildPath } from '../../query/api-query'
import { useSession } from '../../session/session'
import { AlertBulkActions } from './alerts-bulk'
import { ALERT_DEFAULT_SORT, ALERT_SORTABLE, alertColumns } from './alerts-columns'

// 风险预警中心（P5-01，09 章 9.1；P6-15 迁到 MassiveGrid 骨架）：规则命中后生成的预警，按业务域分组、按严重度、处理状态与我的已读状态筛选；点进详情看证据、规则与处理记录。
// 两套状态：处理状态（待处理、已处理、已忽略、已恢复，页签，默认只看待处理）和已读状态（按人记录，我读过的预警标题不再加粗、没有蓝点）；两者互不影响。
// 预警由后台任务每 15 分钟按规则评估生成；同一规则同一对象反复命中时并入上一条（显示“触发 N 次”）；命中条件消失后自动标记为“已恢复”。
// 勾选后可批量标为已读、已处理。受你的数据范围限制（只看得到范围内店铺的预警）；页面没有全局范围栏。

const FIELDS: FilterField[] = [
  { key: 'domain', label: '业务域', kind: 'select', options: ALERT_DOMAINS.map(value => ({ value, label: ALERT_RULE_DOMAIN_LABEL[value] })) },
  { key: 'severity', label: '严重度', kind: 'select', options: ALERT_SEVERITIES.map(value => ({ value, label: ALERT_SEVERITY_LABEL[value] })) },
  { key: 'readState', label: '已读状态', kind: 'select', options: ALERT_READ_STATES.map(value => ({ value, label: ALERT_READ_STATE_LABEL[value] })) },
]
const MODES: SearchMode[] = [{ id: 'keyword', label: '预警', key: 'q', placeholder: '搜索预警标题、对象或规则' }]

type Meta = Pick<AlertListResponse, 'counts' | 'unreadCount' | 'note'>

export default function AlertsPage() {
  const { canPermission } = useSession()
  const url = useUrlFilters(FIELDS, MODES)
  const { values, replaceAll } = url
  const [handleState, setHandleState] = useState<AlertView>('open')
  const [meta, setMeta] = useState<Meta | null>(null)
  // 批量动作成功后刷新列表：表格不走缓存，换一个重置键让它重新取
  const [version, setVersion] = useState(0)
  const refresh = useCallback(() => setVersion(current => current + 1), [])

  const fetchPage = useCallback<CursorFetcher<AlertListItem>>(
    async ({ cursor, limit, sort, signal }) => {
      const path = buildPath('/alerts', { ...values, handleState, sort: sort ? `${sort.field}:${sort.direction}` : undefined, pageSize: limit, cursor: cursor ?? undefined })
      const response = await apiFetch<AlertListResponse>(path, { signal })
      // 各页签的条数、未读数与提示以第一块为准（后续块的游标只管翻页）
      if (cursor === null) setMeta({ counts: response.counts, unreadCount: response.unreadCount, note: response.note })
      return { items: response.items, nextCursor: response.pageInfo.hasMore ? response.pageInfo.nextCursor : null, approxTotal: response.pageInfo.approxTotal }
    },
    [values, handleState],
  )
  const viewFilters = useMemo<ViewFilterBinding>(() => ({ value: values, dimension: null, apply: (filters, dimension) => replaceAll(filters) + (dimension === null ? 0 : 1) }), [values, replaceAll])
  const filtered = appliedCount(FIELDS, MODES, values) > 0

  return (
    <div data-testid="alerts-page">
      <PageHeader
        title="风险预警中心"
        description="按规则识别出的风险：库存、商品、售后、财务、广告、系统六个业务域。后台每 15 分钟评估一次；同一对象反复命中会并入同一条，命中条件消失后自动标记为已恢复。"
        actions={
          <Space size={12}>
            {canPermission('alerts.read') ? <AppLink to="/app/alerts/templates">规则模板</AppLink> : null}
            {canPermission('alerts.manage') ? <AppLink to="/app/alerts/rules">预警规则配置</AppLink> : null}
          </Space>
        }
      />
      <Card size="small">
        <Tabs
          activeKey={handleState}
          onChange={key => setHandleState(key as AlertView)}
          tabBarExtraContent={
            meta ? (
              <Badge
                count={meta.unreadCount}
                overflowCount={999}
                showZero
                style={meta.unreadCount > 0 ? undefined : { backgroundColor: 'var(--ant-color-fill-secondary)', color: 'var(--ant-color-text-secondary)' }}
                title="我的未读预警（只算待处理的）"
              />
            ) : null
          }
          items={ALERT_VIEWS.map(key => ({ key, label: `${ALERT_VIEW_LABEL[key]}${meta ? `（${meta.counts[key]}）` : ''}` }))}
        />
        <FilterBar fields={FIELDS} modes={MODES} values={values} onChange={url.set} onReset={url.reset} />
        <MassiveGrid<AlertListItem>
          gridId="alerts.list"
          serverViews
          viewFilters={viewFilters}
          columns={alertColumns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          sortableFields={ALERT_SORTABLE}
          defaultSort={ALERT_DEFAULT_SORT}
          resetKey={JSON.stringify([handleState, url.signature, version])}
          appliedFilterCount={appliedCount(FIELDS, MODES, values)}
          onClearFilters={url.reset}
          renderBulkActions={rows => <AlertBulkActions rows={rows} onDone={refresh} />}
          emptyState={{
            kind: 'empty',
            domain: '预警',
            prerequisite: filtered ? '没有符合条件的预警；可以放宽筛选条件。' : (meta?.note ?? '没有符合条件的预警'),
          }}
          height={560}
        />
      </Card>
    </div>
  )
}
