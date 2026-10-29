import { Badge, Tag } from 'antd'
import type { AlertListItem } from '@nova/api-contracts'
import { renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import type { SortSpec } from '../../components/table/cursor-datasource'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { AlertStatusTag, EntityCell, SeverityTag, impactText, ownerText } from './alerts-ui'

// 预警列表的列（P5-01；P6-15 迁到 MassiveGrid 骨架）：预警接口只支持按最近触发时间排序（游标分页），所以只有“最近触发”一列可排序。
// 未读的预警在标题前带一个蓝点（按人记录，我读过就消失）；同一规则同一对象反复命中并入同一条时，在“触发”列显示“触发 N 次”。

/** 白名单：列标识 → 服务端排序字段。 */
export const ALERT_SORTABLE = { lastTriggeredAt: 'lastTriggeredAt' } as const
export const ALERT_DEFAULT_SORT: SortSpec = { field: 'lastTriggeredAt', direction: 'desc' }

export const triggerText = (count: number) => `触发 ${count} 次`

export const alertColumns: ErpColDef<AlertListItem>[] = [
  renderColumn<AlertListItem>('严重度', 'severity', row => <SeverityTag severity={row.severity} />, { group: '预警', width: 90 }),
  renderColumn<AlertListItem>(
    '预警',
    'title',
    row => (
      <span>
        {row.read ? null : <Badge status="processing" aria-label="未读" style={{ marginRight: 6 }} />}
        <LiveLink component="AlertDetailPage" id={row.id}>
          <span style={row.read ? undefined : { fontWeight: 600 }}>{row.title}</span>
        </LiveLink>
      </span>
    ),
    { group: '预警', pin: 'left', width: 340 },
  ),
  renderColumn<AlertListItem>('业务域', 'domain', row => row.domainLabel, { group: '预警', width: 110 }),
  renderColumn<AlertListItem>('规则', 'rule', row => row.ruleName, { group: '预警', width: 170 }),
  renderColumn<AlertListItem>('对象', 'entity', row => <EntityCell entity={row.entity} />, { group: '对象', width: 210 }),
  renderColumn<AlertListItem>('店铺', 'store', row => row.storeName ?? '企业级', { group: '对象', width: 130 }),
  renderColumn<AlertListItem>('影响金额', 'impact', row => impactText(row.impact), { group: '处理', width: 160, ...RIGHT_ALIGNED }),
  renderColumn<AlertListItem>('负责人', 'owner', row => ownerText(row.owner), { group: '处理', width: 110 }),
  renderColumn<AlertListItem>('状态', 'status', row => <AlertStatusTag status={row.status} label={row.statusLabel} />, { group: '处理', width: 100 }),
  renderColumn<AlertListItem>(
    '触发',
    'triggerCount',
    row =>
      row.triggerCount > 1 ? (
        <Tag color="warning" bordered={false}>
          {triggerText(row.triggerCount)}
        </Tag>
      ) : (
        <Muted>{triggerText(row.triggerCount)}</Muted>
      ),
    { group: '时间', width: 110 },
  ),
  renderColumn<AlertListItem>('最近触发', 'lastTriggeredAt', row => timeText(row.lastTriggeredAt), { group: '时间', width: 170 }),
]
