import { useMemo } from 'react'
import { buildRuleCatalog, ruleMetricsOf, type MetricDefinition } from '@nova/api-contracts'
import { useApiQuery } from '../../query/api-query'

// 可用于规则的指标（P6-07）：取自口径字典里标记为“可用于规则”的条目（metrics.md 10.8），页面不自己列指标。
// 字典是公共的、不随企业变化，所以不带范围参数；一次取全（登记的指标远少于 100 个）。

export function useRuleMetrics() {
  const query = useApiQuery<{ items: MetricDefinition[] }>({ domain: 'config', path: '/metrics/definitions', scoped: false, params: { ruleUsable: 'true', pageSize: 100 } })
  const metrics = useMemo(() => ruleMetricsOf(query.data?.items ?? []), [query.data])
  const catalog = useMemo(() => buildRuleCatalog(metrics), [metrics])
  return { metrics, catalog, isLoading: query.isLoading, isError: query.isError, refetch: query.refetch }
}
