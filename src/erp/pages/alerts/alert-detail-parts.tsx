import { Alert, Card, Descriptions, Timeline, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { AlertDetailResponse, AlertHistoryItem } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { MiniTrend } from '../../components/metric/MiniTrend'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { AlertStatusTag, SeverityTag } from './alerts-ui'

// 预警详情的页签内容（P5-01）：证据与规则（含触发时的阈值与规则版本）、历史触发、处理记录。

export function EvidenceTab({ detail, canManage }: { detail: AlertDetailResponse; canManage: boolean }) {
  const { rule, evidence, ruleTrend } = detail
  const total = ruleTrend.reduce((sum, item) => sum + item.count, 0)
  return (
    <div>
      <Card size="small" title="触发依据" style={{ marginBottom: 12 }}>
        {evidence.length ? (
          <Descriptions size="small" column={{ xs: 1, md: 2 }} data-testid="alert-evidence">
            {evidence.map(row => (
              <Descriptions.Item key={row.label} label={row.label}>
                {row.value}
              </Descriptions.Item>
            ))}
          </Descriptions>
        ) : (
          <Muted>这条预警没有留存可展示的依据</Muted>
        )}
      </Card>
      <Card size="small" title="规则与触发时的阈值" style={{ marginBottom: 12 }}>
        <div>
          {canManage ? <AppLink to="/app/alerts/rules">{rule.name}</AppLink> : <Typography.Text strong>{rule.name}</Typography.Text>}
          {rule.enabled ? null : <Muted>（规则当前已关闭）</Muted>}
        </div>
        {rule.description ? <Muted>{rule.description}</Muted> : null}
        {rule.versionNo !== rule.currentVersion ? (
          <Alert
            type="info"
            showIcon
            style={{ margin: '8px 0' }}
            message={`这条预警触发时规则是第 ${rule.versionNo} 版，现在是第 ${rule.currentVersion} 版；下面是触发时的阈值，不是现在的。`}
            data-testid="alert-version-note"
          />
        ) : null}
        {rule.thresholds.length ? (
          <Descriptions size="small" column={{ xs: 1, md: 2 }} style={{ marginTop: 8 }} data-testid="alert-thresholds">
            {rule.thresholds.map(item => (
              <Descriptions.Item key={item.label} label={item.label}>
                {item.value}
              </Descriptions.Item>
            ))}
          </Descriptions>
        ) : (
          <div style={{ marginTop: 8 }}>
            <Muted>这条规则没有可调的阈值</Muted>
          </div>
        )}
        <div style={{ marginTop: 8 }}>
          冷却期 <span className="erp-num">{rule.cooldownMinutes}</span> 分钟：处理或忽略后，同一对象在冷却期内再次命中不重复提醒。
        </div>
      </Card>
      <Card size="small" title="这条规则最近 30 天的新增预警">
        <MiniTrend points={ruleTrend.map(item => item.count)} label="规则每日新增预警" width={320} height={40} />
        <div>
          共 <span className="erp-num">{total}</span> 条（你的数据范围内，含所有对象）：集中在个别对象还是在持续扩散，可对照这条曲线判断。
        </div>
      </Card>
    </div>
  )
}

const historyColumns: ColumnsType<AlertHistoryItem> = [
  {
    title: '首次触发',
    dataIndex: 'firstTriggeredAt',
    width: 170,
    render: (value: string, row) => (
      <span>
        {timeText(value)}
        {row.current ? '（本条）' : ''}
      </span>
    ),
  },
  { title: '严重度', key: 'severity', width: 90, render: (_value, row) => <SeverityTag severity={row.severity} /> },
  { title: '状态', key: 'status', width: 100, render: (_value, row) => <AlertStatusTag status={row.status} label={row.statusLabel} /> },
  { title: '触发次数', dataIndex: 'triggerCount', width: 90, align: 'right' },
  { title: '最近触发', dataIndex: 'lastTriggeredAt', width: 170, render: (value: string) => timeText(value) },
  { title: '结束时间', dataIndex: 'resolvedAt', width: 170, render: (value: string | null) => timeText(value) },
  { title: '处理结论', dataIndex: 'conclusionLabel', width: 120, render: (value: string | null) => value ?? <Muted>尚无</Muted> },
]

export function HistoryTab({ items }: { items: AlertHistoryItem[] }) {
  return (
    <SimpleGrid<AlertHistoryItem>
      gridId="alerts.alert-detail-parts"
      columns={historyColumns}
      rows={items}
      rowKey={row => row.id}
      emptyState={{ kind: 'empty', domain: '历史触发', prerequisite: '尚无记录：同一规则对同一对象没有更早的触发' }}
    />
  )
}

export function TimelineTab({ items }: { items: AlertDetailResponse['timeline'] }) {
  return (
    <Timeline
      data-testid="alert-timeline"
      items={items.map(item => ({
        key: item.id,
        children: (
          <div>
            <div>{item.title}</div>
            <Muted>
              {item.actor} · {formatDateTime(item.at)}
            </Muted>
          </div>
        ),
      }))}
    />
  )
}
