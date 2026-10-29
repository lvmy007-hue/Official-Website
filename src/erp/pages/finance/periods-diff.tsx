import { useMemo, type ReactNode } from 'react'
import { Alert, Collapse } from 'antd'
import type { BasisDiff, CostDiffRow, DiffAmount, FxDiffRow, PeriodDiffReport, SkuDiff } from '@nova/api-contracts'
import { LocalGrid } from '../../components'
import { timeText } from '../orders/orders-ui'
import { amountColumns, costColumns, fxColumns, skuColumns } from './periods-columns'

// 差异报告（P2b-13）：重新开账期间看“上一份快照 vs 现在的实时数据”，再次关账之后看“本次锁定 vs 上一份快照”。
// 变化大小按金额从大到小，逐 SKU、逐汇率、逐成本版本最多列出前 50 条，其余只计数。没有的一边写“无”，不当 0。

function BasisPanel({ basis }: { basis: BasisDiff }) {
  const rows = useMemo(() => [...basis.items, basis.netProfit], [basis])
  return (
    <div>
      <LocalGrid<DiffAmount>
        gridId="finance.periods.diff-amounts"
        columns={amountColumns}
        rows={rows}
        getRowId={row => row.key}
        height={320}
        emptyState={{ kind: 'empty', domain: '差异项', prerequisite: '没有变化。' }}
      />
      <p style={{ margin: '8px 0' }}>
        商品：有变化 <span className="erp-num">{basis.skuChanged}</span>，新增 <span className="erp-num">{basis.skuAdded}</span>，移除 <span className="erp-num">{basis.skuRemoved}</span>
        {basis.skuTruncated ? '（快照只保存销售额最高的一部分商品，其余只在合计里）' : ''}
      </p>
      {basis.skus.length ? (
        <LocalGrid<SkuDiff>
          gridId="finance.periods.diff-skus"
          columns={skuColumns}
          rows={basis.skus}
          getRowId={row => row.sku}
          height={360}
          emptyState={{ kind: 'empty', domain: '商品差异', prerequisite: '没有变化。' }}
        />
      ) : null}
    </div>
  )
}

export function DiffReport({ diff }: { diff: PeriodDiffReport }) {
  const head =
    diff.against === 'LIVE' ? (
      <>
        第 {diff.baseRevision} 次关账（{timeText(diff.baseLockedAt)}）的快照 对比 现在的实时数据：重新开账后数据恢复更新，这里列出已经变了什么。
      </>
    ) : (
      <>
        第 {diff.compareRevision} 次锁定 对比 第 {diff.baseRevision} 次关账（{timeText(diff.baseLockedAt)}）的快照。
      </>
    )
  const sections: Array<{ key: string; label: string; children: ReactNode }> = diff.bases.map(basis => ({ key: basis.basis, label: `利润：${basis.label}`, children: <BasisPanel basis={basis} /> }))
  if (diff.fx.rows.length || diff.fx.changed + diff.fx.added + diff.fx.removed > 0) {
    sections.push({
      key: 'fx',
      label: `汇率（有变化 ${diff.fx.changed}，新增 ${diff.fx.added}，移除 ${diff.fx.removed}）`,
      children: (
        <LocalGrid<FxDiffRow>
          gridId="finance.periods.diff-fx"
          columns={fxColumns}
          rows={diff.fx.rows}
          getRowId={row => `${row.quote}|${row.date}|${row.source}`}
          height={320}
          emptyState={{ kind: 'empty', domain: '汇率差异', prerequisite: '没有变化。' }}
        />
      ),
    })
  }
  if (diff.costVersions.rows.length || diff.costVersions.changed + diff.costVersions.added + diff.costVersions.removed > 0) {
    sections.push({
      key: 'cost',
      label: `成本版本（有变化 ${diff.costVersions.changed}，新增 ${diff.costVersions.added}，移除 ${diff.costVersions.removed}）`,
      children: (
        <LocalGrid<CostDiffRow>
          gridId="finance.periods.diff-costs"
          columns={costColumns}
          rows={diff.costVersions.rows}
          getRowId={row => `${row.sku}#${row.versionNo}`}
          height={360}
          emptyState={{ kind: 'empty', domain: '成本差异', prerequisite: '没有变化。' }}
        />
      ),
    })
  }
  return (
    <div data-testid="period-diff">
      <p style={{ margin: '0 0 8px' }}>{head}</p>
      {diff.hasChanges ? (
        <Collapse size="small" defaultActiveKey={sections.map(section => section.key)} items={sections} />
      ) : (
        <Alert type="success" showIcon message="没有变化" description="金额变化都在舍入误差（0.005）以内，汇率与成本版本也没有变。" />
      )}
    </div>
  )
}
