import { Alert, Descriptions } from 'antd'
import { useParams } from '@tanstack/react-router'
import { ADS_RULE_FREQUENCY_LABEL, ADS_RULE_LEVEL_LABEL, ADS_RULE_STATUS_LABEL, type AdsRuleDetailResponse } from '@nova/api-contracts'
import { DataState, DetailLayout, stateFromError } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { formatDateTime } from '../../format'
import { NONE } from './ads-campaigns-ui'
import { RuleEditor } from './ads-rules-editor'
import { DryRunPanel } from './ads-rules-dryrun'
import { QualityBlock } from './ads-rules-quality'
import { RunsPanel } from './ads-rules-runs'

// 自动规则详情（P3-13，08 章 8.10）：规则内容与质量（命中率、采纳率、执行后效果）、试运行、运行记录。
// 自动执行模式的执行器随“广告写入接入”（P3-17）提供，页面顶部有说明；在那之前命中只生成待办。

export default function AdsRuleDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const query = useApiQuery<AdsRuleDetailResponse>({ domain: 'analytics', path: `/ads/rules/${encodeURIComponent(id)}` })
  const refetch = () => void query.refetch()
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'ads.read', onRetry: refetch })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />
  const { rule, quality, auto, execution } = query.data
  return (
    <div data-testid="ads-rule-detail">
      <DetailLayout
        title={rule.name}
        subtitle={`自动规则 · ${rule.accountName}${rule.storeName ? ` · ${rule.storeName}` : ''}`}
        statuses={[
          { text: ADS_RULE_STATUS_LABEL[rule.status], color: rule.status === 'ACTIVE' ? 'success' : 'default' },
          { text: rule.mode === 'AUTO' ? '自动执行模式' : '建议模式', color: rule.mode === 'AUTO' ? 'warning' : 'processing' },
        ]}
        metrics={[
          { label: '对象层级', value: ADS_RULE_LEVEL_LABEL[rule.spec.level] },
          { label: '执行频率', value: ADS_RULE_FREQUENCY_LABEL[rule.frequency] },
          { label: '最近评估', value: rule.lastRunAt ? formatDateTime(rule.lastRunAt) : '尚未评估' },
          { label: '最近评估命中', value: rule.lastEvaluated === null ? NONE : `${rule.lastMatched ?? 0} / ${rule.lastEvaluated}` },
        ]}
        freshness={{ lastSuccessAt: rule.lastRunAt, sources: ['广告日汇总', '广告指标', '搜索词报表'], qualityIssues: 0 }}
        primaryActions={query.data.canWrite ? <RuleEditor rule={rule} profiles={[{ id: rule.adsProfileId, name: rule.accountName, storeName: rule.storeName }]} auto={auto} onDone={refetch} /> : null}
        identityExtra={<Alert type="info" showIcon message={execution.note} data-testid="rule-execution-note" />}
        tabs={[
          {
            key: 'overview',
            label: '内容与质量',
            children: (
              <div>
                <Descriptions size="small" column={1} bordered style={{ marginBottom: 12 }}>
                  <Descriptions.Item label="条件">{rule.summary.conditions}</Descriptions.Item>
                  {rule.summary.filters ? <Descriptions.Item label="对象过滤">{rule.summary.filters}</Descriptions.Item> : null}
                  <Descriptions.Item label="范围">{rule.summary.scope}</Descriptions.Item>
                  <Descriptions.Item label="动作">{rule.summary.action}</Descriptions.Item>
                  <Descriptions.Item label="护栏">{rule.summary.guardrails}</Descriptions.Item>
                  <Descriptions.Item label="版本">
                    第 {rule.version} 版{rule.updatedByName ? `，${rule.updatedByName} 于 ${formatDateTime(rule.updatedAt)} 更新` : ''}
                  </Descriptions.Item>
                </Descriptions>
                <QualityBlock quality={quality} />
              </div>
            ),
          },
          { key: 'dryrun', label: '试运行', children: <DryRunPanel rule={rule} /> },
          { key: 'runs', label: '运行记录', children: <RunsPanel ruleId={rule.id} /> },
        ]}
      />
    </div>
  )
}
