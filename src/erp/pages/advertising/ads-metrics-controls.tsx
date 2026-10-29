import { Radio, Select, Space } from 'antd'
import {
  ADS_METRICS_DATASET_KEYS,
  ADS_METRICS_DATASETS,
  ADS_METRICS_DIMENSION_LABEL,
  ADS_METRICS_INFO,
  ADS_METRICS_LIMITS,
  ADS_REPORT_AD_PRODUCT_LABEL,
  ADS_REPORT_AD_PRODUCTS,
  GRANULARITY_LABEL,
  type AdsMetricsDimension,
  type AdsMetricsKey,
  type AdsMetricsProfileOption,
  type DashGranularity,
} from '@nova/api-contracts'
import { withDataset, type MetricsState } from './ads-metrics-state'

// 广告指标页的筛选条（08 章 8.13）：数据集、维度、指标、时间粒度、广告产品与广告档案。能选什么由数据集决定。

const PAGE_SIZES = [50, 100, 200]

export function MetricsControls({ state, profiles, onChange }: { state: MetricsState; profiles: readonly AdsMetricsProfileOption[]; onChange: (next: MetricsState) => void }) {
  const spec = ADS_METRICS_DATASETS[state.dataset]
  const patch = (value: Partial<MetricsState>) => onChange({ ...state, ...value })
  const sortOptions = [{ value: 'key', label: '名称' }, ...state.metrics.map(key => ({ value: key, label: ADS_METRICS_INFO[key].label }))]
  return (
    <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 8 }}>
      <Space wrap>
        <Select
          style={{ width: 190 }}
          aria-label="数据集"
          value={state.dataset}
          options={ADS_METRICS_DATASET_KEYS.map(key => ({ value: key, label: ADS_METRICS_DATASETS[key].label }))}
          onChange={value => onChange(withDataset(state, value))}
        />
        <Select
          mode="multiple"
          style={{ minWidth: 260 }}
          aria-label="维度"
          placeholder="不分组（只看合计）"
          value={state.dims}
          maxCount={ADS_METRICS_LIMITS.maxDimensions}
          options={spec.dimensions.map(key => ({ value: key, label: ADS_METRICS_DIMENSION_LABEL[key] }))}
          onChange={(value: AdsMetricsDimension[]) => patch({ dims: value })}
        />
        <Select
          mode="multiple"
          style={{ minWidth: 320 }}
          aria-label="指标"
          placeholder="至少选一个指标"
          value={state.metrics}
          maxCount={ADS_METRICS_LIMITS.maxMetrics}
          options={spec.metrics.map(key => ({ value: key, label: ADS_METRICS_INFO[key].label, title: ADS_METRICS_INFO[key].formula }))}
          onChange={(value: AdsMetricsKey[]) => patch({ metrics: value })}
        />
        {state.dims.includes('date') ? (
          <Radio.Group
            aria-label="时间粒度"
            optionType="button"
            value={state.grain}
            onChange={event => patch({ grain: event.target.value as DashGranularity })}
            options={(['day', 'week', 'month'] as const).map(value => ({ value, label: GRANULARITY_LABEL[value] }))}
          />
        ) : null}
      </Space>
      <Space wrap>
        {spec.hasAdProduct ? (
          <Select
            allowClear
            style={{ width: 140 }}
            aria-label="广告产品"
            placeholder="广告产品"
            value={state.adProduct}
            options={ADS_REPORT_AD_PRODUCTS.map(value => ({ value, label: ADS_REPORT_AD_PRODUCT_LABEL[value] }))}
            onChange={value => patch({ adProduct: value })}
          />
        ) : null}
        <Select
          allowClear
          style={{ width: 220 }}
          aria-label="广告档案"
          placeholder="广告档案"
          value={state.adsProfileId}
          options={profiles.map(profile => ({ value: profile.id, label: profile.storeName ? `${profile.name} · ${profile.storeName}` : profile.name }))}
          onChange={value => patch({ adsProfileId: value })}
        />
        <Select style={{ width: 130 }} aria-label="排序" placeholder="默认排序" allowClear value={state.sortField} options={sortOptions} onChange={value => patch({ sortField: value })} />
        <Radio.Group
          aria-label="排序方向"
          optionType="button"
          value={state.sortDir}
          onChange={event => patch({ sortDir: event.target.value })}
          options={[
            { value: 'desc', label: '从高到低' },
            { value: 'asc', label: '从低到高' },
          ]}
        />
        <Select
          aria-label="每页条数"
          style={{ width: 110 }}
          value={String(state.pageSize)}
          options={PAGE_SIZES.map(size => ({ value: String(size), label: `${size} 条/页` }))}
          onChange={value => patch({ pageSize: Number(value) })}
        />
      </Space>
    </Space>
  )
}
