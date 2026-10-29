import { useState } from 'react'
import { Alert, Drawer, InputNumber, Space, Tag, Typography } from 'antd'
import { PRICING_LIMITS, PRICING_RULE_WRITE, type DryRunDay, type DryRunHit, type DryRunResponse, type PricingRuleView, type PricingWriteStatuses } from '@nova/api-contracts'
import { ActionGuard, SimpleGrid } from '../../components'
import { formatMoney } from '../../format'
import { useApiMutation } from '../../query/api-query'
import { moneyCell } from '../advertising/ads-campaigns-ui'
import { Muted } from '../inventory/inventory-ui'
import { guardOf } from './pricing-state'

// 规则试运行（P4-11）：不改任何价格，只看“按这条规则，过去几天与现在会命中哪些商品、建议改成多少、会不会被护栏拦下”。
// 历史每天按当天结束时的数据逐日模拟（单位经济取最新值，是近似）；结果不写入执行记录。

export function RuleDryRunDrawer({ rule, write, onClose }: { rule: PricingRuleView | null; write: PricingWriteStatuses | undefined; onClose: () => void }) {
  const [days, setDays] = useState<number>(PRICING_LIMITS.dryRunDaysDefault)
  const [result, setResult] = useState<DryRunResponse | null>(null)
  const run = useApiMutation<{ id: string; days: number }, DryRunResponse>({
    method: 'POST',
    path: ({ id }) => `/pricing/rules/${encodeURIComponent(id)}/dry-run`,
    body: ({ days: count }) => ({ days: count }),
    silent: true,
  })

  return (
    <Drawer
      open={Boolean(rule)}
      onClose={() => {
        setResult(null)
        onClose()
      }}
      width={880}
      destroyOnClose
      title={rule ? `试运行：${rule.name}` : '试运行'}
      data-testid="pricing-dry-run"
    >
      {rule ? (
        <>
          <Space wrap style={{ marginBottom: 12 }}>
            <span>模拟最近</span>
            <InputNumber
              aria-label="模拟天数"
              min={1}
              max={PRICING_LIMITS.dryRunDaysMax}
              precision={0}
              value={days}
              onChange={value => setDays(typeof value === 'number' ? value : PRICING_LIMITS.dryRunDaysDefault)}
            />
            <span>天</span>
            <ActionGuard
              label="开始试运行"
              guard={guardOf(PRICING_RULE_WRITE, write?.rule)}
              onExecute={async () => setResult(await run.mutateAsync({ id: rule.id, days }))}
              buttonProps={{ type: 'primary' }}
            />
          </Space>
          {result ? (
            <>
              <Alert type="info" showIcon style={{ marginBottom: 8 }} message={result.note} description={result.basis} />
              <Typography.Title level={5}>逐日命中</Typography.Title>
              <SimpleGrid<DryRunDay>
                gridId="pricing.rule-dry-run-drawer"
                rows={result.daily}
                rowKey={row => row.date}
                emptyState={{ kind: 'empty', domain: '逐日模拟', prerequisite: '所选天数内没有可评估的数据。' }}
                columns={[
                  { title: '日期', dataIndex: 'date', width: 120 },
                  { title: '评估商品数', dataIndex: 'evaluated', width: 110 },
                  { title: '命中', dataIndex: 'hits', width: 80 },
                  { title: '被护栏拦截', dataIndex: 'blocked', width: 110 },
                ]}
              />
              <Typography.Title level={5} style={{ marginTop: 12 }}>
                按最新数据逐个商品（共评估 {result.evaluated} 个）
              </Typography.Title>
              <SimpleGrid<DryRunHit>
                gridId="pricing.rule-dry-run-drawer-2"
                rows={result.current}
                rowKey={row => row.sku}
                emptyState={{ kind: 'empty', domain: '命中的商品', prerequisite: '现在没有商品命中这条规则。' }}
                columns={[
                  { title: 'SKU', dataIndex: 'sku', width: 150 },
                  { title: '当前价', key: 'current', width: 100, render: (_v, row) => moneyCell(row.currentPrice) },
                  { title: '策略原值', key: 'raw', width: 100, render: (_v, row) => moneyCell(row.rawPrice) },
                  {
                    title: '建议价',
                    key: 'suggested',
                    width: 100,
                    render: (_v, row) => (row.suggestedPrice === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMoney(row.suggestedPrice, 'USD', { digits: 2 })}</span>),
                  },
                  { title: '护栏', key: 'guard', render: (_v, row) => <span style={{ fontSize: 12 }}>{row.guardrailText}</span> },
                  { title: '命中', key: 'hit', width: 80, render: (_v, row) => (row.hit ? <Tag color="processing">命中</Tag> : <Tag>未命中</Tag>) },
                ]}
              />
            </>
          ) : (
            <Muted>点“开始试运行”查看结果；试运行不会改价，也不会生成建议。</Muted>
          )}
        </>
      ) : null}
    </Drawer>
  )
}
