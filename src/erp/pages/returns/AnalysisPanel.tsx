import { useState } from 'react'
import { Segmented, Space, Tabs, Typography } from 'antd'
import { RETURN_TIME_BASES, RETURN_TIME_BASIS_LABEL } from '@nova/api-contracts'
import { AnalysisCohort } from './AnalysisCohort'
import { AnalysisCrossMonth } from './AnalysisCrossMonth'
import { AnalysisCycle } from './AnalysisCycle'
import { AnalysisMatrix } from './AnalysisMatrix'
import { AnalysisOverview } from './AnalysisOverview'
import { AnalysisReasons } from './AnalysisReasons'
import { useAnalysisParams } from './analysis-shared'

// 退货分析（07 章 7.2；P6-13，16 章第 6 节）：六个子页签——概览、退货原因、退货周期、跨月退货、队列退货率、库存属性×处置结果。
// 顶部的“按退货时间 / 按下单时间”对所有页签生效，写在地址栏里；退货率（M-310）、队列退货率（M-703）、退款率（M-126）是三个不同的指标。
// 子页签第一次打开才取数。与评论主题的交叉分析要等评价与反馈上线后接入。

export function AnalysisPanel({ onOpenReasonMap }: { onOpenReasonMap: () => void }) {
  const params = useAnalysisParams()
  const [active, setActive] = useState('overview')
  return (
    <div>
      <Space size={8} wrap style={{ marginBottom: 8 }}>
        <Typography.Text>时间口径</Typography.Text>
        <Segmented
          aria-label="时间口径"
          value={params.timeBasis}
          onChange={value => params.setTimeBasis(value as (typeof RETURN_TIME_BASES)[number])}
          options={RETURN_TIME_BASES.map(value => ({ value, label: RETURN_TIME_BASIS_LABEL[value] }))}
        />
        <Typography.Text type="secondary">按下单时间只统计能确定下单时间的退货，缺下单时间的会单独写明条数。</Typography.Text>
      </Space>
      <Tabs
        size="small"
        activeKey={active}
        onChange={setActive}
        items={[
          { key: 'overview', label: '概览', children: <AnalysisOverview params={params} /> },
          { key: 'reasons', label: '退货原因', children: <AnalysisReasons params={params} onOpenReasonMap={onOpenReasonMap} /> },
          { key: 'cycle', label: '退货周期', children: <AnalysisCycle params={params} /> },
          { key: 'cross-month', label: '跨月退货', children: <AnalysisCrossMonth params={params} /> },
          { key: 'cohort', label: '队列退货率', children: <AnalysisCohort params={params} /> },
          { key: 'matrix', label: '库存属性×处置结果', children: <AnalysisMatrix params={params} /> },
        ]}
      />
    </div>
  )
}
