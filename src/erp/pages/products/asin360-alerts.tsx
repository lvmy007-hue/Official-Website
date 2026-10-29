import { useCallback, useMemo } from 'react'
import { Space, Tag } from 'antd'
import { ALERT_SEVERITY_LABEL, type Asin360AlertsResponse, type AlertListItem } from '@nova/api-contracts'
import { PagedGrid, renderColumn, RIGHT_ALIGNED, type ErpColDef, type PageFetcher } from '../../components'
import { formatDateTime, formatNumber } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { QueryBody, useProductQuery } from './asin360-hooks'

// 预警日志（P6-21，16 章 3.1 第 12 项）：只显示和本商品有关的预警（含已处理、已恢复的历史），按最近触发时间新到旧。
// 一次最多取 200 条，表格在本地分页；点标题进预警详情处理，这里不做处理动作。

const SEVERITY_COLOR: Record<AlertListItem['severity'], string> = { CRITICAL: 'error', WARNING: 'warning', INFO: 'default' }

function AlertsGrid({ data }: { data: Asin360AlertsResponse }) {
  const columns = useMemo<ErpColDef<AlertListItem>[]>(
    () => [
      renderColumn<AlertListItem>('严重度', 'severity', row => <Tag color={SEVERITY_COLOR[row.severity]}>{ALERT_SEVERITY_LABEL[row.severity]}</Tag>, { group: '预警', width: 100, sortable: false }),
      renderColumn<AlertListItem>('预警', 'title', row => <AppLink to={`/app/alerts/${encodeURIComponent(row.id)}`}>{row.title}</AppLink>, { group: '预警', pin: 'left', width: 320, sortable: false }),
      renderColumn<AlertListItem>('规则', 'ruleName', row => row.ruleName, { group: '预警', width: 200, sortable: false }),
      renderColumn<AlertListItem>('状态', 'statusLabel', row => row.statusLabel, { group: '处理', width: 110, sortable: false }),
      renderColumn<AlertListItem>('负责人', 'owner', row => row.owner?.name ?? <Muted>尚未分派</Muted>, { group: '处理', width: 120, sortable: false }),
      renderColumn<AlertListItem>('触发次数', 'triggerCount', row => <span className="erp-num">{formatNumber(row.triggerCount)}</span>, {
        group: '时间',
        width: 100,
        sortable: false,
        ...RIGHT_ALIGNED,
      }),
      renderColumn<AlertListItem>('最近触发', 'lastTriggeredAt', row => <span className="erp-num">{formatDateTime(row.lastTriggeredAt)}</span>, { group: '时间', width: 170, sortable: false }),
    ],
    [],
  )
  const fetchPage = useCallback<PageFetcher<AlertListItem>>(async ({ page, pageSize }) => ({ items: data.items.slice((page - 1) * pageSize, page * pageSize), total: data.items.length }), [data.items])
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }} data-testid="asin360-alerts">
      {data.truncated ? <Muted>只显示最近 {data.items.length} 条预警；更早的在“风险预警”里按对象筛选。</Muted> : null}
      <PagedGrid<AlertListItem>
        gridId="asin360.alerts"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => row.id}
        resetKey={`${data.items.length}:${data.items[0]?.id ?? ''}`}
        emptyState={{ kind: 'empty', domain: '这个商品的预警', prerequisite: data.note ?? '系统每 15 分钟按预警规则评估一次，数据同步后才会出现' }}
        height={360}
      />
    </Space>
  )
}

export function AlertsSection({ id }: { id: string }) {
  const query = useProductQuery<Asin360AlertsResponse>(id, 'alerts')
  return <QueryBody query={query}>{data => <AlertsGrid data={data} />}</QueryBody>
}
