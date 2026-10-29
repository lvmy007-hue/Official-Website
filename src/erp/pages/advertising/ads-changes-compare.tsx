import { Alert, Descriptions, Drawer, List, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ADS_CHANGE_ENTITY_LABEL, type AdsChangeCompareField, type AdsChangeCompareResponse, type AdsChangeRow } from '@nova/api-contracts'
import { DataState, stateFromError, SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { actorText, SourceTag, valueCell } from './ads-changes-columns'

// 前后对照（08 章 8.11“可一键打开前后对照”）：同一对象同一时刻的这一批改动“改前 → 改后”；有实体快照时没改的字段也列出来（显示快照里的值）。
// 没有快照只列被改的字段并说明；同一对象前后的其他变更列在下面。

const fieldColumns: ColumnsType<AdsChangeCompareField> = [
  { title: '字段', key: 'label', width: 130, render: (_value, field) => (field.changed ? <strong>{field.label}</strong> : field.label) },
  { title: '改前', key: 'before', render: (_value, field) => valueCell(field.before) },
  {
    title: '改后',
    key: 'after',
    render: (_value, field) => (
      <Space>
        {valueCell(field.after)}
        {field.changed ? (
          <Tag color="warning" bordered={false}>
            已改动
          </Tag>
        ) : null}
      </Space>
    ),
  },
]

const relatedText = (row: AdsChangeRow) => `${formatDateTime(row.occurredAt)} · ${row.fieldLabel}：${row.before ?? '空'} → ${row.after ?? '空'}（${actorText(row)}）`

export function ChangeCompareDrawer({ row, onClose }: { row: AdsChangeRow | null; onClose: () => void }) {
  const query = useApiQuery<AdsChangeCompareResponse>({ domain: 'list', path: `/ads/changes/${encodeURIComponent(row?.id ?? '')}/compare`, scoped: false, enabled: Boolean(row), staleMs: 0 })
  const data = query.data
  const change = data?.change ?? row
  return (
    <Drawer open={Boolean(row)} onClose={onClose} width={640} title="前后对照" destroyOnClose data-testid="ads-change-compare">
      {query.error ? <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} /> : null}
      {!data && !query.error ? <DataState kind="skeleton" rows={6} /> : null}
      {change && data ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="对象">
              {ADS_CHANGE_ENTITY_LABEL[change.entityType]} · {change.entityLabel ?? change.entityId}
            </Descriptions.Item>
            <Descriptions.Item label="来源">
              <SourceTag source={change.source} />
            </Descriptions.Item>
            <Descriptions.Item label="时间">{formatDateTime(change.occurredAt)}</Descriptions.Item>
            <Descriptions.Item label="操作人">{actorText(change)}</Descriptions.Item>
            {change.sinceAt ? (
              <Descriptions.Item label="发生区间" span={2}>
                {formatDateTime(change.sinceAt)} 之后、{formatDateTime(change.occurredAt)} 之前（只能确定在这段时间内）
              </Descriptions.Item>
            ) : null}
            <Descriptions.Item label="广告账户" span={2}>
              {change.accountName}
              {change.storeName ? ` · ${change.storeName}` : ' · 未绑定店铺'}
            </Descriptions.Item>
          </Descriptions>
          <Alert type="info" showIcon message={data.basisNote} data-testid="ads-change-basis" />
          <div data-testid="ads-change-fields">
            <SimpleGrid<AdsChangeCompareField>
              gridId="advertising.ads-changes-compare"
              columns={fieldColumns}
              rows={data.fields}
              rowKey={field => field.key}
              emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
            />
          </div>
          <div>
            <Typography.Title level={5}>同一对象的其他变更</Typography.Title>
            {data.related.length === 0 ? (
              <Typography.Text type="secondary">这个对象没有其他变更记录</Typography.Text>
            ) : (
              <List size="small" dataSource={data.related} renderItem={item => <List.Item>{relatedText(item)}</List.Item>} />
            )}
          </div>
        </Space>
      ) : null}
    </Drawer>
  )
}
