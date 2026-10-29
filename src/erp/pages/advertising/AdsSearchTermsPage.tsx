import { Alert } from 'antd'
import { AD_TERM_ANOMALY_LABEL, ADS_TERM_STATUS_LABEL, anomalyAppliesTo, type AdTermSearchResponse, type AdTermSearchRow } from '@nova/api-contracts'
import type { FilterField, SearchMode } from '../../components'
import { AdsLevelGrid } from './ads-level-grid'
import { SEARCH_TERM_SORTABLE, TERM_DEFAULT_SORT, searchTermColumns } from './ads-term-level-columns'
import { TERM_STATUSES } from './ad-terms-state'

// 搜索词（P6-23，16 章第 8 节）：广告层级统一骨架的第五个层级，数据沿用词级接口 GET /ads/terms?tab=search-terms（不另设 /ads/search-terms 列表路由）。
// 搜索词是跨活动、跨店铺按词汇总的，没有“对象编号”，所以末列分析置灰并指向词级分析页（点词进入，看趋势与关联活动）。
// 加词、否定的批量写入随“广告写入接入”，本页没有批量栏；旧的词级中心仍在 /app/ad-terms。

const MODES: SearchMode[] = [{ id: 'contains', label: '词包含', key: 'q', placeholder: '搜索词' }]
const FIXED = { tab: 'search-terms' }
const columns = searchTermColumns()

function fieldsOf(): FilterField[] {
  return [
    { key: 'status', label: '投放状态', kind: 'select', width: 140, options: TERM_STATUSES.map(value => ({ value, label: ADS_TERM_STATUS_LABEL[value] })) },
    {
      key: 'anomaly',
      label: '异常分组',
      kind: 'select',
      width: 180,
      options: (Object.keys(AD_TERM_ANOMALY_LABEL) as Array<keyof typeof AD_TERM_ANOMALY_LABEL>)
        .filter(key => anomalyAppliesTo(key, 'search-terms'))
        .map(key => ({ value: key, label: AD_TERM_ANOMALY_LABEL[key] })),
    },
  ]
}

export default function AdsSearchTermsPage() {
  return (
    <AdsLevelGrid<AdTermSearchRow, AdTermSearchResponse>
      level="search-terms"
      testId="ads-search-terms-page"
      title="搜索词"
      description="按搜索词汇总全部活动与店铺的表现；点词进入词级分析。指标是所选日期范围内的合计（美元账户）；亚马逊合并成“其他”的搜索词不在列表里。"
      gridId="ads.search-terms"
      path="/ads/terms"
      fixedParams={FIXED}
      fieldsOf={fieldsOf}
      modes={MODES}
      columns={columns}
      sortableFields={SEARCH_TERM_SORTABLE}
      defaultSort={TERM_DEFAULT_SORT}
      getRowId={row => row.key}
      summaryOf={response => response.summary}
      emptyDomain="搜索词"
      emptyNote="词级报表还没有同步；连接广告账户并同步“搜索词”报告后显示。"
      trendDisabledReason="搜索词是跨活动、跨店铺的汇总，没有对象级趋势接口；点搜索词进入词级分析页查看趋势"
      notes={response =>
        response ? (
          <>
            <div style={{ marginBottom: 8, color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>{response.basis}</div>
            {response.targetingNote ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={response.targetingNote} /> : null}
            {response.undisclosedSpend !== null ? (
              <Alert type="info" showIcon style={{ marginBottom: 8 }} message={`被亚马逊合并成“其他”的搜索词花费 ${response.undisclosedSpend.toFixed(2)} 美元，不在下面的列表里`} />
            ) : null}
          </>
        ) : null
      }
    />
  )
}
