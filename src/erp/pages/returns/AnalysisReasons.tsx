import { useMemo } from 'react'
import { Alert, Button, Typography } from 'antd'
import { ChartPanel } from '../../components'
import { categoryColumns, dispositionColumns, reasonColumns } from './analysis-columns'
import { AnalysisHead, BasisNote, TruncatedNote, UnknownNotice, type AnalysisParams } from './analysis-shared'
import { useSummary } from './AnalysisOverview'
import { LocalGrid } from './returns-local-grid'
import { buildCategoryOption } from './returns-options'

// 退货分析·退货原因（P6-13，16 章第 6 节）：原因三层——亚马逊原因代码、中文释义、大类——的件数与占比，另按处置结果汇总。
// 映射表里还没补全的代码在汇总里显示为“未分类”，页面顶部提醒并给出去补全的入口；没有原因的退货单独列为“未提供原因”。

export function AnalysisReasons({ params, onOpenReasonMap }: { params: AnalysisParams; onOpenReasonMap: () => void }) {
  const query = useSummary(params)
  const data = query.data
  const option = useMemo(() => buildCategoryOption(data?.byCategory ?? []), [data?.byCategory])
  const emptyText = data?.note ?? '所选日期范围内尚无退货记录。'
  const pending = data?.unclassified

  return (
    <div>
      <AnalysisHead data={data} />
      {pending && pending.codes.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ margin: '8px 0' }}
          message={`有 ${pending.codes.length} 个原因代码（${pending.units} 件）还没有补全中文释义与大类`}
          description={`${pending.codes.slice(0, 8).join('、')}${pending.codes.length > 8 ? ' 等' : ''}；补全前它们在汇总里归为“未分类”。`}
          action={
            <Button size="small" onClick={onOpenReasonMap}>
              去补全
            </Button>
          }
        />
      ) : null}
      <UnknownNotice data={data} what="缺下单时间、不能按下单时间统计的退货" />
      <TruncatedNote show={data?.truncated} />
      <ChartPanel
        title="按原因大类的退货件数"
        ariaLabel="按原因大类的退货件数图"
        option={option}
        loading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        height={Math.max(180, (data?.byCategory.length ?? 0) * 28 + 48)}
        emptyState={data?.state === 'NO_DATA' ? { kind: 'empty', domain: '退货', prerequisite: emptyText } : undefined}
      />
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        按退货原因（代码 → 中文释义 → 大类）
      </Typography.Title>
      <LocalGrid
        gridId="returns.analysis.reasons"
        columns={reasonColumns}
        rows={data?.byReason}
        getRowId={row => row.code}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '退货原因', prerequisite: emptyText }}
        height={420}
      />
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        按大类
      </Typography.Title>
      <LocalGrid
        gridId="returns.analysis.categories"
        columns={categoryColumns}
        rows={data?.byCategory}
        getRowId={row => row.category}
        emptyState={{ kind: 'empty', domain: '原因大类', prerequisite: emptyText }}
      />
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        按处置结果
      </Typography.Title>
      <LocalGrid
        gridId="returns.analysis.dispositions"
        columns={dispositionColumns}
        rows={data?.byDisposition}
        getRowId={row => row.group}
        emptyState={{ kind: 'empty', domain: '处置结果', prerequisite: emptyText }}
      />
      <BasisNote text={data?.basis} />
    </div>
  )
}
