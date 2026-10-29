import { Alert, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ADS_METRICS_DATASETS, adsReportGranularityText, type AdsReportProfileOption, type AdsReportTemplate, type AdsReportTemplatesResponse } from '@nova/api-contracts'
import { DataState, stateFromError, SimpleGrid } from '../../components'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
// 模板库页签（08 章 8.12）：8 个模板各取哪些维度与指标、导入后落在哪个分析数据集；下面是各广告档案能不能用、历史可用起点。
// 模板里的字段名按亚马逊新报告接口的描述整理，尚未对真实账户核对；字段对不上时任务会失败并说明原因，不会写入错误数据。

const templateColumns: ColumnsType<AdsReportTemplate> = [
  {
    title: '模板',
    key: 'label',
    width: 200,
    render: (_value, template) => (
      <div>
        <strong>{template.label}</strong>
        <div>
          <Muted>{template.description}</Muted>
        </div>
      </div>
    ),
  },
  { title: '粒度', key: 'granularity', width: 80, render: (_value, template) => adsReportGranularityText(template.granularity) },
  { title: '维度', key: 'dimensions', width: 260, render: (_value, template) => template.dimensions.join('、') },
  { title: '指标', key: 'metrics', width: 240, render: (_value, template) => template.metrics.join('、') },
  { title: '导入后的数据集', key: 'dataset', width: 150, render: (_value, template) => ADS_METRICS_DATASETS[template.dataset].label },
  { title: '要求广告账户', key: 'needsAccount', width: 110, render: (_value, template) => (template.needsAccount ? '是' : '否') },
]

const profileColumns: ColumnsType<AdsReportProfileOption> = [
  { title: '广告档案', key: 'name', render: (_value, profile) => `${profile.name}${profile.storeName ? ` · ${profile.storeName}` : ''}` },
  {
    title: '新报告接口',
    key: 'ready',
    width: 320,
    render: (_value, profile) =>
      profile.ready ? (
        <Tag color="success" bordered={false}>
          可用
        </Tag>
      ) : (
        <span>
          <Tag bordered={false}>不可用</Tag>
          {profile.notReadyReason}
        </span>
      ),
  },
  { title: '历史可用起点', key: 'historyFrom', width: 160, render: (_value, profile) => (profile.historyFrom ? <span className="erp-num">{profile.historyFrom}</span> : <Muted>尚未取得数据</Muted>) },
]

export function TemplateLibrary({ data, loading, error, onRetry }: { data: AdsReportTemplatesResponse | undefined; loading: boolean; error: unknown; onRetry: () => void }) {
  if (error) return <DataState {...stateFromError(describeError(error), { onRetry })} />
  if (!data) return loading ? <DataState kind="skeleton" rows={5} /> : null
  return (
    <div data-testid="ads-reports-library">
      {data.note ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={data.note} /> : null}
      <SimpleGrid<AdsReportTemplate>
        gridId="advertising.ads-reports-library"
        columns={templateColumns}
        rows={data.templates}
        rowKey={template => template.key}
        emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
      />
      <SimpleGrid<AdsReportProfileOption>
        gridId="advertising.ads-reports-library-2"
        columns={profileColumns}
        rows={data.profiles}
        rowKey={profile => profile.id}
        emptyState={{ kind: 'empty', domain: '明细', prerequisite: '还没有广告档案' }}
      />
    </div>
  )
}
