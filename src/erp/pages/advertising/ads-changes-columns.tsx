import { Button, Space, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ADS_CHANGE_ENTITY_LABEL, ADS_CHANGE_SOURCE_LABEL, type AdsChangeRow, type AdsChangeSource } from '@nova/api-contracts'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'

// 广告变更记录列表的列（08 章 8.11）：一行是一个字段的一次变化。外部变更没有操作人，只知道发生在“上一次快照之后、检测到之前”，页面如实写出来，不假装知道是谁改的。

const SOURCE_COLOR: Record<AdsChangeSource, string> = { MANUAL: 'blue', AUTO_RULE: 'purple', DAYPARTING: 'cyan', EXTERNAL: 'orange' }

export const SourceTag = ({ source }: { source: AdsChangeSource }) => (
  <Tag color={SOURCE_COLOR[source]} bordered={false}>
    {ADS_CHANGE_SOURCE_LABEL[source]}
  </Tag>
)

/** 谁改的：手动是操作人，规则与分时策略是来源名，外部变更不知道。 */
export function actorText(row: Pick<AdsChangeRow, 'source' | 'actorName'>) {
  if (row.source === 'MANUAL') return row.actorName ?? '系统'
  if (row.source === 'EXTERNAL') return '未知（外部）'
  return ADS_CHANGE_SOURCE_LABEL[row.source]
}

/** 改前改后的值：空值写“空”，不写 0 或留白。 */
export const valueCell = (value: string | null) => (value === null ? <Muted>空</Muted> : <span className="erp-num">{value}</span>)

export function changeColumns(onCompare: (row: AdsChangeRow) => void): ColumnsType<AdsChangeRow> {
  return [
    {
      title: '时间',
      key: 'occurredAt',
      width: 190,
      render: (_value, row) =>
        row.sinceAt ? (
          <Tooltip title={`外部变更只能确定发生在上一次快照（${formatDateTime(row.sinceAt)}）之后、检测到之前`}>
            <div>
              <span className="erp-num">{formatDateTime(row.occurredAt)}</span>
              <div>
                <Muted>检测到；发生在 {formatDateTime(row.sinceAt)} 之后</Muted>
              </div>
            </div>
          </Tooltip>
        ) : (
          <span className="erp-num">{formatDateTime(row.occurredAt)}</span>
        ),
    },
    { title: '来源', key: 'source', width: 100, render: (_value, row) => <SourceTag source={row.source} /> },
    {
      title: '对象',
      key: 'entity',
      width: 280,
      render: (_value, row) => (
        <div>
          <Muted>{ADS_CHANGE_ENTITY_LABEL[row.entityType]}</Muted> {row.path ? <AppLink to={row.path}>{row.entityLabel ?? row.entityId}</AppLink> : (row.entityLabel ?? row.entityId)}
          <div className="erp-num">
            {row.accountName}
            {row.storeName ? ` · ${row.storeName}` : ' · 未绑定店铺'}
          </div>
        </div>
      ),
    },
    { title: '变更', key: 'field', width: 110, dataIndex: 'fieldLabel' },
    { title: '改前', key: 'before', width: 150, render: (_value, row) => valueCell(row.before) },
    { title: '改后', key: 'after', width: 190, render: (_value, row) => valueCell(row.after) },
    { title: '操作人', key: 'actor', width: 120, render: (_value, row) => actorText(row) },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      fixed: 'right',
      render: (_value, row) => (
        <Space size={4}>
          <Button type="link" size="small" aria-label={`查看前后对照 ${row.fieldLabel} ${row.entityLabel ?? row.entityId}`} onClick={() => onCompare(row)}>
            前后对照
          </Button>
        </Space>
      ),
    },
  ]
}
