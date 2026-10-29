import { useMemo } from 'react'
import { Alert } from 'antd'
import type { CheckItem, PeriodDetailResponse } from '@nova/api-contracts'
import { LocalGrid } from '../../components'
import { Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { checklistColumns } from './periods-columns'
import { AcknowledgeAction } from './periods-actions'

// 完整性检查清单（P2b-13，07 章 7.12）：六项，每项写明通过与否和依据；只有“广告分摊完成”“对账异常”可以确认放行，其余是数据本身有缺口，必须补齐。

export function ChecklistTab({ data }: { data: PeriodDetailResponse }) {
  const { period, checklist, actions } = data
  const columns = useMemo(
    () =>
      checklistColumns(item => {
        if (item.acknowledgement) {
          return (
            <span className="erp-cell-stack" style={{ fontSize: 12 }}>
              <span>
                {item.acknowledgement.by} · {timeText(item.acknowledgement.at)}
              </span>
              <span>原因：{item.acknowledgement.note}</span>
            </span>
          )
        }
        if (!item.acknowledgeable) return <Muted>不能放行，须补齐</Muted>
        if (item.baseState === 'PASS') return <Muted>无需放行</Muted>
        return period.status === 'CLOSED' ? <Muted>已关账</Muted> : <AcknowledgeAction period={period} item={item} actions={actions} />
      }),
    [period, actions],
  )
  if (!checklist) {
    return <Alert type="info" showIcon message="尚未检查" description="点右上角“运行完整性检查”。通过后期间进入“关账中”，等待审批；没通过的项会写明缺什么。" />
  }
  return (
    <div data-testid="period-checklist">
      <p style={{ margin: '0 0 8px' }}>
        检查时间 {timeText(checklist.checkedAt)}：{checklist.passed ? '全部通过' : '有项目未通过，期间保持开放'}
      </p>
      <LocalGrid<CheckItem>
        gridId="finance.periods.checklist"
        columns={columns}
        rows={checklist.items}
        getRowId={item => item.key}
        height={420}
        emptyState={{ kind: 'empty', domain: '检查项', prerequisite: '尚无检查结果。' }}
      />
    </div>
  )
}
