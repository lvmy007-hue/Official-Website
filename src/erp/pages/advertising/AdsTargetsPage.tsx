import { useCallback } from 'react'
import { AD_TERM_ANOMALY_LABEL, anomalyAppliesTo, type AdTermTargetRow, type AdTermTargetsResponse } from '@nova/api-contracts'
import type { FilterField, SearchMode } from '../../components'
import { DuplicatesPanel } from './ads-duplicates-panel'
import { AdsLevelGrid } from './ads-level-grid'
import { TARGET_SORTABLE, TERM_DEFAULT_SORT, targetColumns } from './ads-term-level-columns'

// 投放（P6-23，16 章第 8 节）：广告层级统一骨架的第四个层级，数据沿用词级接口 GET /ads/terms?tab=targets（不另设 /ads/targets 列表路由）。
// 指标来自词级报表的投放层（美元）；趋势小窗用行里的 entityId 走 /ads/targets/:id/trend，还没有同步成投放对象的行置灰并写原因。
// 投放的批量写入随“广告写入接入”，本页没有批量栏；旧的词级中心（含否定词库、四象限、词根）仍在 /app/ad-terms。

const MODES: SearchMode[] = [{ id: 'contains', label: '词包含', key: 'q', placeholder: '搜索投放词' }]
const FIXED = { tab: 'targets' }
const columns = targetColumns()

function fieldsOf(): FilterField[] {
  return [
    { key: 'matchType', label: '匹配方式', kind: 'text', width: 140 },
    {
      key: 'anomaly',
      label: '异常分组',
      kind: 'select',
      width: 180,
      options: (Object.keys(AD_TERM_ANOMALY_LABEL) as Array<keyof typeof AD_TERM_ANOMALY_LABEL>)
        .filter(key => anomalyAppliesTo(key, 'targets'))
        .map(key => ({ value: key, label: AD_TERM_ANOMALY_LABEL[key] })),
    },
  ]
}

export default function AdsTargetsPage() {
  const trendPathOf = useCallback((row: AdTermTargetRow) => (row.entityId ? `/ads/targets/${encodeURIComponent(row.entityId)}/trend` : null), [])
  return (
    <>
      <AdsLevelGrid<AdTermTargetRow, AdTermTargetsResponse>
        level="targets"
        testId="ads-targets-page"
        title="投放"
        description="所有关键词与投放表达式的表现；点词进入词级分析，末列图标看趋势。指标是所选日期范围内的合计（美元账户）；词级报表还没有同步成投放对象的行，趋势置灰。"
        gridId="ads.targets"
        path="/ads/terms"
        fixedParams={FIXED}
        fieldsOf={fieldsOf}
        modes={MODES}
        columns={columns}
        sortableFields={TARGET_SORTABLE}
        defaultSort={TERM_DEFAULT_SORT}
        getRowId={row => row.key}
        summaryOf={response => response.summary}
        emptyDomain="投放"
        emptyNote="词级报表还没有同步；连接广告账户并同步“投放”报告后显示。"
        trendPathOf={trendPathOf}
        trendDisabledReason="这个投放词还没有同步成投放对象（没有对象编号），暂无趋势；同步广告结构后可看"
        notes={response => (response ? <div style={{ marginBottom: 8, color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>{response.basis}</div> : null)}
      />
      <DuplicatesPanel />
    </>
  )
}
