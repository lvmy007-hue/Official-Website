import { useState } from 'react'
import { Alert, Card, Tag } from 'antd'
import { ADS_CONFLICT_KINDS, type AdsConflict, type AdsConflictsResponse } from '@nova/api-contracts'
import { renderColumn, type ErpColDef } from '../../components'
import { Muted } from '../inventory/inventory-ui'
import { ToolGrid } from './ads-tools-grid'

// 冲突面板（P6-24）：分时策略之间、自动规则与分时策略、自动规则之间，改同一个活动或广告组的同一个字段时列出来，写明谁最终生效。
// 判断只看已启用的分时策略与自动执行的规则（建议模式不写亚马逊，不参与）；规则没有时间维度，不判断时间重叠。

const columns: ErpColDef<AdsConflict>[] = [
  renderColumn<AdsConflict>('对象', 'object', row => row.objectName ?? row.objectId, { pin: 'left', width: 220, sortable: false }),
  renderColumn<AdsConflict>('类型', 'kind', row => <Tag bordered={false}>{row.kindLabel}</Tag>, { width: 190, sortable: false }),
  renderColumn<AdsConflict>('字段', 'field', row => row.fieldLabel, { width: 100, sortable: false }),
  renderColumn<AdsConflict>('重叠', 'overlap', row => (row.overlapHours === null ? <Muted>不判断时间</Muted> : `${row.overlapHours} 个小时格`), { width: 130, sortable: false }),
  renderColumn<AdsConflict>(
    '涉及与生效',
    'parties',
    row => (
      <span>
        {row.parties.map(party => (
          <Tag key={party.id} bordered={false} color={party.effective ? 'success' : 'default'}>
            {party.name}
            {party.effective ? '（生效）' : '（被覆盖）'}
          </Tag>
        ))}
      </span>
    ),
    { width: 420, sortable: false },
  ),
  renderColumn<AdsConflict>('说明', 'reason', row => row.reason, { width: 360, sortable: false }),
]

/** 列表里策略或规则名称旁的冲突标记；没有冲突不显示。 */
export function ConflictTag({ counts, id }: { counts?: Record<string, number>; id: string }) {
  const n = counts?.[id] ?? 0
  return n > 0 ? (
    <Tag color="error" bordered={false} data-testid={`conflict-tag-${id}`}>
      冲突 {n}
    </Tag>
  ) : null
}

/** 冲突面板。onCounts 把“每个策略或规则牵涉几处冲突”交给页面，列表里在名称旁标记。 */
export function ConflictsPanel({ onCounts }: { onCounts?: (counts: Record<string, number>) => void }) {
  const [meta, setMeta] = useState<AdsConflictsResponse | null>(null)
  return (
    <Card size="small" title={`冲突${meta ? `（${meta.total} 处）` : ''}`} style={{ marginBottom: 12 }} data-testid="ads-conflicts-panel">
      <Alert type="info" showIcon style={{ marginBottom: 8 }} message={meta?.ruleNote ?? '规则没有时间维度，不判断时间重叠，只判断是否改同一个对象的同一个字段。'} />
      {meta?.truncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="活动数量超过读取上限，只判断了前一部分" /> : null}
      <ToolGrid<AdsConflict, AdsConflictsResponse>
        gridId="ads.conflicts"
        path="/ads/conflicts"
        columns={columns}
        getRowId={row => row.key}
        emptyDomain="冲突"
        emptyNote={meta?.note ?? '没有发现冲突：已启用的分时策略与自动执行的规则没有改同一个对象的同一个字段。'}
        onFirstPage={response => {
          setMeta(response)
          onCounts?.(response.counts)
        }}
      />
      <Muted>判断范围：{ADS_CONFLICT_KINDS.length} 类（分时策略之间、规则与分时策略、规则之间）。</Muted>
    </Card>
  )
}
