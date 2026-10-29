import { Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  DAYPARTING_KIND_LABEL,
  DAYPARTING_LEVEL_LABEL,
  DAYPARTING_OUTCOME_LABEL,
  DAYPARTING_STATUS_LABEL,
  type DaypartingProfileOption,
  type DaypartingRunRow,
  type DaypartingStrategyRow,
} from '@nova/api-contracts'
import { formatDateTime } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { NONE } from './ads-campaigns-ui'
import { ConflictTag } from './ads-conflicts-panel'
import { StrategyEditor } from './ads-dayparting-editor'
import { SimulateButton } from './ads-dayparting-simulate'

// 分时策略列表与执行记录的列（P3-12）。没有的值写“尚无记录”，不当 0；执行记录在执行器接入前一律没有。

const targetsText = (row: DaypartingStrategyRow): string => {
  const names = row.targets.map(target => target.name ?? '已不存在的对象')
  return names.length <= 3 ? names.join('、') : `${names.slice(0, 3).join('、')} 等 ${names.length} 个`
}

export function strategyColumns(profiles: readonly DaypartingProfileOption[], canWrite: boolean, onDone: () => void, conflicts?: Record<string, number>): ColumnsType<DaypartingStrategyRow> {
  return [
    {
      title: '策略',
      key: 'name',
      width: 200,
      render: (_value, row) => (
        <div>
          <strong>{row.name}</strong>
          <ConflictTag counts={conflicts} id={row.id} />
          <div>
            <Tag bordered={false} color={row.status === 'ACTIVE' ? 'success' : 'default'}>
              {DAYPARTING_STATUS_LABEL[row.status]}
            </Tag>
            <Muted>第 {row.version} 版</Muted>
          </div>
        </div>
      ),
    },
    {
      title: '广告账户',
      key: 'account',
      width: 150,
      render: (_value, row) => (
        <div>
          <div>{row.accountName}</div>
          {row.storeName ? <Muted>{row.storeName}</Muted> : null}
        </div>
      ),
    },
    {
      title: '类型与对象',
      key: 'kind',
      width: 260,
      render: (_value, row) => (
        <div>
          <div>
            {DAYPARTING_KIND_LABEL[row.kind]} · {DAYPARTING_LEVEL_LABEL[row.level]}
          </div>
          <Tooltip title={row.targets.map(target => target.name ?? '已不存在的对象').join('、')}>
            <span>
              <Muted>{targetsText(row)}</Muted>
            </span>
          </Tooltip>
        </div>
      ),
    },
    { title: '取值概况', key: 'summary', width: 240, render: (_value, row) => row.summary },
    {
      title: '此刻应执行',
      key: 'due',
      width: 150,
      render: (_value, row) => (
        <Tooltip title={`按 ${row.timezone} 的当前星期与小时；执行器接入前不会真的执行`}>
          <span>{row.due.label}</span>
        </Tooltip>
      ),
    },
    {
      title: '更新',
      key: 'updated',
      width: 160,
      render: (_value, row) => (
        <div>
          <div>{formatDateTime(row.updatedAt)}</div>
          {row.updatedByName ? <Muted>{row.updatedByName}</Muted> : null}
        </div>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 170,
      fixed: 'right',
      render: (_value, row) => (
        <span>
          <SimulateButton strategy={row} />
          {canWrite ? <StrategyEditor strategy={row} profiles={profiles} onDone={onDone} /> : null}
        </span>
      ),
    },
  ]
}

export function runColumns(): ColumnsType<DaypartingRunRow> {
  return [
    { title: '时间', key: 'runAt', width: 170, render: (_value, row) => formatDateTime(row.runAt) },
    { title: '策略', key: 'strategy', dataIndex: 'strategyName', width: 180 },
    { title: '对象', key: 'entity', width: 200, render: (_value, row) => row.entityName ?? NONE },
    { title: '小时', key: 'hour', width: 70, align: 'right', render: (_value, row) => `${row.hour} 时` },
    { title: '应用的取值', key: 'multiplier', width: 110, align: 'right', render: (_value, row) => row.appliedMultiplier },
    {
      title: '结果',
      key: 'outcome',
      width: 150,
      render: (_value, row) => (
        <Tooltip title={row.message}>
          <Tag bordered={false} color={row.outcome === 'APPLIED' ? 'success' : row.outcome === 'FAILED' ? 'error' : 'default'}>
            {DAYPARTING_OUTCOME_LABEL[row.outcome]}
          </Tag>
        </Tooltip>
      ),
    },
  ]
}
