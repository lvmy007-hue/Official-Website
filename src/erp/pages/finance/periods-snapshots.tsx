import { Alert } from 'antd'
import type { PeriodDetailResponse, PeriodSnapshotSummary } from '@nova/api-contracts'
import { LocalGrid } from '../../components'
import { snapshotColumns } from './periods-columns'
import { DiffReport } from './periods-diff'

// 快照与差异（P2b-13）：每次锁定保存一份快照（利润三种口径的合计与商品汇总、期间内汇率、生效中的成本版本），重新开账再锁定会多一份；快照不会被改写。
// 这里只列最近 10 份摘要；差异报告在重新开账期间显示“快照 vs 现在”，再次关账后显示“本次 vs 上一份”。

export function SnapshotsTab({ data }: { data: PeriodDetailResponse }) {
  return (
    <div data-testid="period-snapshots">
      <LocalGrid<PeriodSnapshotSummary>
        gridId="finance.periods.snapshots"
        columns={snapshotColumns}
        rows={data.snapshots}
        getRowId={row => String(row.revision)}
        height={320}
        emptyState={{ kind: 'empty', domain: '快照', prerequisite: '尚未锁定过；锁定关账时保存第一份快照。' }}
      />
      <h4 style={{ margin: '16px 0 8px' }}>差异报告</h4>
      {data.diff ? (
        <DiffReport diff={data.diff} />
      ) : (
        <Alert type="info" showIcon message="暂无差异报告" description="重新开账后会显示“上一份快照与现在实时数据”的差异；再次锁定之后显示本次与上一份快照的差异。第一次关账没有可比较的对象。" />
      )}
    </div>
  )
}
