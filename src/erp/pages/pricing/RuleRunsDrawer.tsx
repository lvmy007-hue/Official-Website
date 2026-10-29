import { useState } from 'react'
import { Button, Drawer, Space, Tag, Typography } from 'antd'
import { PRICING_PRICE_WRITE, type PricingRuleView, type RuleRunListResponse, type RuleRunView } from '@nova/api-contracts'
import { ActionGuard, SimpleGrid } from '../../components'
import { formatDateTime, formatMoney } from '../../format'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { moneyCell } from '../advertising/ads-campaigns-ui'
import { Muted } from '../inventory/inventory-ui'
import { CompareView } from './pricing-compare-ui'
import { OUTCOME_COLOR } from './pricing-state'

// 规则的执行记录（P4-11）：待确认的建议可以“确认调价”（进入改价流程，价格必须与建议一致）或“忽略”；
// 已执行的记录在观察期满后显示调价前后对照。忽略过的建议 7 天内同一个价格不会再被建议。

const PAGE = 20

export function RuleRunsDrawer({ rule, onClose, onConfirm }: { rule: PricingRuleView | null; onClose: () => void; onConfirm: (run: RuleRunView) => void }) {
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const query = useApiQuery<RuleRunListResponse>({
    domain: 'list',
    path: `/pricing/rules/${encodeURIComponent(rule?.id ?? 'none')}/runs`,
    scoped: false,
    enabled: Boolean(rule),
    params: { pageSize: PAGE, cursor: stack[stack.length - 1] },
  })
  const dismiss = useApiMutation<string>({ method: 'POST', path: id => `/pricing/rule-runs/${encodeURIComponent(id)}/dismiss`, body: () => ({}), invalidate: ['list'], silent: true })
  const data = query.data
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null

  return (
    <Drawer open={Boolean(rule)} onClose={onClose} width={960} destroyOnClose title={rule ? `执行记录：${rule.name}` : '执行记录'} data-testid="pricing-rule-runs">
      <SimpleGrid<RuleRunView>
        gridId="pricing.rule-runs-drawer"
        rows={data?.items}
        rowKey={row => row.id}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '执行记录', prerequisite: '规则启用后，每次评估命中的商品会记在这里。' }}
        columns={[
          { title: '时间', key: 'runAt', width: 150, render: (_v, row) => formatDateTime(row.runAt) },
          {
            title: '商品',
            key: 'sku',
            width: 150,
            render: (_v, row) => (
              <div>
                {row.sku}
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {row.asin || '尚无 ASIN'}
                  </Typography.Text>
                </div>
              </div>
            ),
          },
          { title: '当前价', key: 'current', width: 90, render: (_v, row) => moneyCell(row.currentPrice) },
          {
            title: '建议价',
            key: 'suggested',
            width: 120,
            render: (_v, row) =>
              row.suggestedPrice === null ? (
                <Muted>尚无记录</Muted>
              ) : (
                <span>
                  <span className="erp-num">{formatMoney(row.suggestedPrice, 'USD', { digits: 2 })}</span>
                  {row.rawPrice !== null && Math.abs(row.rawPrice - row.suggestedPrice) > 0.004 ? (
                    <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>策略原值 {formatMoney(row.rawPrice, 'USD', { digits: 2 })}</div>
                  ) : null}
                </span>
              ),
          },
          { title: '护栏', key: 'guard', width: 180, render: (_v, row) => <span style={{ fontSize: 12 }}>{row.guardrailText}</span> },
          {
            title: '结果',
            key: 'outcome',
            width: 170,
            render: (_v, row) => (
              <div>
                <Tag color={OUTCOME_COLOR[row.outcome] ?? 'default'} bordered={false}>
                  {row.outcomeLabel}
                </Tag>
                {row.message ? <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{row.message}</div> : null}
              </div>
            ),
          },
          { title: '调价前后', key: 'compare', width: 260, render: (_v, row) => (row.outcome === 'APPLIED' ? <CompareView compare={row.compare} /> : <Muted>—</Muted>) },
          {
            title: '操作',
            key: 'actions',
            fixed: 'right',
            width: 150,
            render: (_v, row) =>
              row.outcome === 'SUGGESTED' && row.suggestedPrice !== null ? (
                <Space size={0}>
                  <Button type="link" size="small" onClick={() => onConfirm(row)}>
                    确认调价
                  </Button>
                  <ActionGuard
                    label="忽略"
                    guard={{ permission: PRICING_PRICE_WRITE }}
                    preview={{ title: '忽略这条建议', content: <p>忽略后，7 天内同一个建议价不会再出现；不会改动亚马逊上的价格。</p>, confirmText: '确认忽略' }}
                    onExecute={() => dismiss.mutateAsync(row.id)}
                    buttonProps={{ type: 'link', size: 'small' }}
                  />
                </Space>
              ) : null,
          },
        ]}
      />
      <Space style={{ marginTop: 8 }}>
        <Button disabled={stack.length <= 1 || query.isFetching} onClick={() => setStack(current => current.slice(0, -1))}>
          上一页
        </Button>
        <Button disabled={!next || query.isFetching} onClick={() => next && setStack(current => [...current, next])}>
          下一页
        </Button>
        <span style={{ color: 'rgba(0,0,0,0.45)' }}>第 {stack.length} 页</span>
      </Space>
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, fontSize: 12 }}>
        调价前后对照是相关性，不是因果：同期的促销、广告、季节与竞争对手变化都会影响销量。
      </Typography.Paragraph>
    </Drawer>
  )
}
