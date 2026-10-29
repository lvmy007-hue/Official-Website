import { Alert, Typography } from 'antd'
import { RETURN_COHORT_OPEN_DAYS, type ReturnCohortResponse } from '@nova/api-contracts'
import { useApiQuery } from '../../query/api-query'
import { cohortColumns } from './analysis-columns'
import { AnalysisHead, BasisNote, TruncatedNote, UnknownNotice, type AnalysisParams } from './analysis-shared'
import { LocalGrid } from './returns-local-grid'

// 退货分析·队列退货率（P6-13，M-703）：按下单月看“这一批订单最终退了多少”。分子分母都是同一批订单（下单月相同），
// 并排给出按退货日统计的退货率（M-310）作对照——两者用途不同、天然不等。近月的退货窗口还没结束，队列退货率会继续上升。

export function AnalysisCohort({ params }: { params: AnalysisParams }) {
  const query = useApiQuery<ReturnCohortResponse>({ domain: 'analytics', path: '/returns/analysis/cohort', params: { timeBasis: params.timeBasis } })
  const data = query.data
  const open = data?.months.some(month => month.windowOpen) ?? false
  return (
    <div>
      <AnalysisHead data={data} />
      <Alert
        type="info"
        showIcon
        style={{ margin: '8px 0' }}
        message="队列退货率与退货率不是同一个数"
        description="队列退货率看的是同一批订单最终的退货水平；退货率按退货发生日统计，反映当期的退货压力。两者并排显示，不要互相替代。"
      />
      {open ? (
        <Alert
          type="warning"
          showIcon
          style={{ margin: '8px 0' }}
          message="带“窗口未结束”的月份，队列退货率还会上升"
          description={`下单后 ${RETURN_COHORT_OPEN_DAYS} 天内退货仍在陆续发生，近月的数字偏低是正常的。`}
        />
      ) : null}
      <UnknownNotice data={data} what="缺下单时间、不能归入下单月的退货" />
      <TruncatedNote show={data?.truncated} />
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        按下单月
      </Typography.Title>
      <LocalGrid
        gridId="returns.analysis.cohort"
        columns={cohortColumns}
        rows={data?.months}
        getRowId={row => row.month}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '队列退货率', prerequisite: data?.note ?? '所选日期范围内没有能确定下单月的退货。' }}
        height={460}
      />
      <BasisNote text={data?.basis} />
    </div>
  )
}
