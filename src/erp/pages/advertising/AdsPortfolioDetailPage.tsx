import { Button, Tooltip } from 'antd'
import { useParams } from '@tanstack/react-router'
import { ADS_PORTFOLIO_KIND_LABEL, type AdsPortfolioDetailResponse } from '@nova/api-contracts'
import { DataState, DetailLayout, stateFromError } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { moneyCell, NONE, percentCell } from './ads-campaigns-ui'
import { IdentityRow, stateTag } from './ads-entity-identity'
import { PaceTag } from './ads-portfolios-columns'
import { AllocationTab, PaceTab, RulesTab } from './ads-portfolio-tabs'

// 广告组合详情（P3-11，08 章 8.8）：身份区（预算上限、已用金额、理想累计、节奏比、周期进度、范围内花费）→ 3 个页签（预算节奏、活动预算分配、预算规则）。
// 修改预算上限、预算规则写亚马逊，随“广告写入接入”（P3-17），这里禁用并说明原因。预算规则资源是测试版，功能开关默认关闭。

export default function AdsPortfolioDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const query = useApiQuery<AdsPortfolioDetailResponse>({ domain: 'analytics', path: `/ads/portfolios/${encodeURIComponent(id)}` })
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'ads.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />
  const detail = query.data
  const { row } = detail
  const { pace, budget } = row
  return (
    <div data-testid="ads-portfolio-detail">
      <DetailLayout
        title={row.name}
        subtitle={`广告组合 · ${row.accountName}${row.storeName ? ` · ${row.storeName}` : ''}`}
        statuses={[stateTag(row.status)]}
        metrics={[
          { label: '预算上限', value: moneyCell(budget.cap, row.currency) },
          { label: '已用金额', value: moneyCell(row.spent, row.currency) },
          { label: '理想累计（至昨天）', value: pace.state === 'OK' ? moneyCell(pace.idealSpent, row.currency) : NONE },
          { label: '节奏比', value: pace.state === 'OK' ? percentCell(pace.ratio) : NONE },
          { label: '周期进度', value: pace.state === 'OK' ? `${pace.elapsedDays} / ${pace.totalDays ?? '-'} 天` : NONE },
          { label: '范围内花费', value: row.totals === null ? NONE : moneyCell(row.totals.spend) },
        ]}
        freshness={{ lastSuccessAt: row.syncedAt, sources: ['广告组合接口', '活动管理接口', '广告日汇总'], qualityIssues: 0 }}
        identityExtra={
          <IdentityRow>
            <span>
              节奏：
              <PaceTag pace={pace} />
            </span>
            <span>
              预算周期：{ADS_PORTFOLIO_KIND_LABEL[budget.kind]}
              {budget.from && budget.to ? `（${budget.from} 至 ${budget.to}）` : ''}
            </span>
            <span>
              活动 {row.campaigns.enabled} / {row.campaigns.total}（启用中 / 全部）
            </span>
            {row.spentSource === 'PORTFOLIO' ? <span>已用金额来自亚马逊同步（没有逐日花费汇总）</span> : null}
          </IdentityRow>
        }
        primaryActions={
          <Tooltip title={detail.write.note}>
            <span>
              <Button disabled>修改预算上限</Button>
            </span>
          </Tooltip>
        }
        tabs={[
          { key: 'pace', label: '预算节奏', children: <PaceTab detail={detail} /> },
          { key: 'allocation', label: '活动预算分配', children: <AllocationTab detail={detail} /> },
          { key: 'rules', label: '预算规则（测试版）', children: <RulesTab detail={detail} /> },
        ]}
      />
    </div>
  )
}
