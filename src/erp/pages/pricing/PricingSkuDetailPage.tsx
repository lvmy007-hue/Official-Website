import { useMemo, useState } from 'react'
import { Alert, Card, Descriptions, Space, Tag, Typography } from 'antd'
import { useParams, useSearch } from '@tanstack/react-router'
import {
  GUARDRAIL_SCOPE_LABEL,
  PRICING_PRICE_WRITE,
  type GuardrailView,
  type PriceAdjustmentRow,
  type PricingDetailResponse,
  type PricingEventRow,
  type PricingOfferRow,
  type RuleRunView,
} from '@nova/api-contracts'
import { ActionGuard, ChartPanel, FreshnessBar, PageHeader, SimpleGrid } from '../../components'
import { formatDateTime, formatMoney } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { moneyCell, percentCell } from '../advertising/ads-campaigns-ui'
import { Muted } from '../inventory/inventory-ui'
import { limitsText, PriceChangeDrawer, type PriceChangeTarget, type RuleSuggestion } from './PriceChangeDrawer'
import { PricingSimulator } from './PricingSimulator'
import { CompareView } from './pricing-compare-ui'
import { buildPriceHistoryOption } from './pricing-detail-options'
import { HEALTH_COLOR, guardOf } from './pricing-state'

// 单品定价详情（P4-11，05 章 5.5）：价格历史曲线、当前报价与竞争、价格事件、价格模拟器、调价记录（带调价前后对照）、适用的护栏、待确认的规则建议。
// 没有数据写“尚无记录”，不补 0；调价前后对照是相关性，不是因果。

const yesNo = (value: boolean | null) => (value === null ? <Muted>尚无记录</Muted> : value ? '是' : '否')

function Pending({ rows, onConfirm }: { rows: RuleRunView[]; onConfirm: (run: RuleRunView) => void }) {
  const dismiss = useApiMutation<string>({ method: 'POST', path: id => `/pricing/rule-runs/${encodeURIComponent(id)}/dismiss`, body: () => ({}), invalidate: ['list'], silent: true })
  if (rows.length === 0) return null
  return (
    <Card size="small" title="待确认的规则建议" style={{ marginTop: 8 }} data-testid="pricing-pending">
      <SimpleGrid<RuleRunView>
        gridId="pricing.pricing-sku-detail-page"
        rows={rows}
        rowKey={row => row.id}
        emptyState={{ kind: 'empty', domain: '规则建议', prerequisite: '没有待确认的建议。' }}
        columns={[
          { title: '规则', dataIndex: 'ruleName', width: 160 },
          { title: '时间', key: 'runAt', width: 150, render: (_v, row) => formatDateTime(row.runAt) },
          { title: '当前价', key: 'current', width: 100, render: (_v, row) => moneyCell(row.currentPrice) },
          { title: '建议价', key: 'suggested', width: 100, render: (_v, row) => moneyCell(row.suggestedPrice) },
          { title: '护栏', key: 'guard', render: (_v, row) => <span style={{ fontSize: 12 }}>{row.guardrailText}</span> },
          {
            title: '操作',
            key: 'actions',
            width: 160,
            render: (_v, row) => (
              <Space size={0}>
                <ActionGuard label="确认调价" guard={{ permission: PRICING_PRICE_WRITE }} onExecute={async () => onConfirm(row)} buttonProps={{ type: 'link', size: 'small' }} />
                <ActionGuard
                  label="忽略"
                  guard={{ permission: PRICING_PRICE_WRITE }}
                  preview={{ title: '忽略这条建议', content: <p>忽略后，7 天内同一个建议价不会再出现；不会改动亚马逊上的价格。</p>, confirmText: '确认忽略' }}
                  onExecute={() => dismiss.mutateAsync(row.id)}
                  buttonProps={{ type: 'link', size: 'small' }}
                />
              </Space>
            ),
          },
        ]}
      />
    </Card>
  )
}

function Guardrails({ rows, currency }: { rows: GuardrailView[]; currency: string }) {
  return (
    <SimpleGrid<GuardrailView>
      gridId="pricing.pricing-sku-detail-page-2"
      rows={rows}
      rowKey={row => row.id}
      emptyState={{ kind: 'empty', domain: '价格护栏', prerequisite: '这个商品没有适用的护栏；可以在“定价与购物车”的“价格护栏”里设置。' }}
      columns={[
        { title: '范围', key: 'scope', render: (_v, row) => (row.scope === 'STORE' ? GUARDRAIL_SCOPE_LABEL.STORE : `${GUARDRAIL_SCOPE_LABEL[row.scope]}：${row.scopeRef}`) },
        { title: '限制', key: 'limits', render: (_v, row) => limitsText(row, currency) },
        { title: '状态', key: 'enabled', width: 80, render: (_v, row) => <Tag color={row.enabled ? 'success' : 'default'}>{row.enabled ? '启用' : '停用'}</Tag> },
      ]}
    />
  )
}

export default function PricingSkuDetailPage() {
  const { sku } = useParams({ strict: false }) as { sku: string }
  const { storeId } = useSearch({ strict: false }) as { storeId?: string }
  const [change, setChange] = useState<{ suggestion?: RuleSuggestion } | null>(null)
  const query = useApiQuery<PricingDetailResponse>({
    domain: 'list',
    path: `/pricing/${encodeURIComponent(sku ?? '')}`,
    scoped: false,
    params: { storeId },
    enabled: Boolean(storeId && sku),
  })
  const data = query.data
  const row = data?.row
  const option = useMemo(() => (data ? buildPriceHistoryOption(data.history.points, data.row.currency) : null), [data])
  const target: PriceChangeTarget | null = row
    ? { storeId: row.storeId, sku: row.sku, asin: row.asin, title: row.title, currency: row.currency, price: row.price, expectedPrice: row.expectedPrice, limits: data?.limits ?? null }
    : null

  const confirm = (run: RuleRunView) => {
    if (run.suggestedPrice !== null) setChange({ suggestion: { ruleRunId: run.id, price: run.suggestedPrice, source: 'RULE_CONFIRMED' } })
  }

  return (
    <div data-testid="pricing-detail-page">
      <PageHeader
        title={row ? `${row.title}` : `定价详情：${sku}`}
        description={row ? `${row.asin || '尚无 ASIN'} · ${row.sku} · ${row.storeName}` : '价格历史、报价与竞争、价格模拟与调价记录。'}
        actions={
          <>
            <AppLink to="/app/pricing">返回定价列表</AppLink>
            {row ? <ActionGuard label="改价" guard={guardOf(PRICING_PRICE_WRITE, data?.write.validate)} onExecute={async () => setChange({})} buttonProps={{ type: 'primary' }} /> : null}
          </>
        }
      />
      <FreshnessBar freshness={data?.freshness} />
      {!storeId ? <Alert type="warning" showIcon style={{ marginTop: 8 }} message="缺少店铺参数：请从定价列表点进来。" /> : null}
      {query.isError ? <Alert type="error" showIcon role="alert" style={{ marginTop: 8 }} message="读取定价详情失败，请稍后重试" /> : null}
      {row && data ? (
        <>
          <Card size="small" style={{ marginTop: 8 }} data-testid="pricing-detail-summary">
            <Descriptions size="small" column={4}>
              <Descriptions.Item label="当前价">
                {row.price === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMoney(row.price, row.currency, { digits: 2 })}</span>}
              </Descriptions.Item>
              <Descriptions.Item label="推荐报价价格">{moneyCell(row.featured.price, row.currency)}</Descriptions.Item>
              <Descriptions.Item label="最低竞争价">{moneyCell(row.lowestPrice, row.currency)}</Descriptions.Item>
              <Descriptions.Item label="预期获胜价">{moneyCell(row.expectedPrice, row.currency)}</Descriptions.Item>
              <Descriptions.Item label="我方是否拿到推荐报价">{yesNo(row.featured.ownIsFeatured)}</Descriptions.Item>
              <Descriptions.Item label="购物车获得率（近 30 天）">{percentCell(row.buyBoxPct)}</Descriptions.Item>
              <Descriptions.Item label="价格健康">
                <Tag color={HEALTH_COLOR[row.health]} bordered={false}>
                  {row.healthLabel}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="护栏">{limitsText(data.limits, row.currency)}</Descriptions.Item>
            </Descriptions>
          </Card>
          <Card size="small" title="价格历史" style={{ marginTop: 8 }}>
            {option ? (
              <ChartPanel
                title="近 90 天价格"
                ariaLabel="价格历史曲线"
                option={option}
                height={260}
                emptyState={data.history.state === 'OK' ? undefined : { kind: 'empty', domain: '价格历史', prerequisite: data.history.note ?? '还没有价格记录。' }}
              />
            ) : null}
          </Card>
          <Card size="small" title="价格模拟器" style={{ marginTop: 8 }}>
            <PricingSimulator storeId={row.storeId} sku={row.sku} currency={row.currency} currentPrice={row.price} />
          </Card>
          <Pending rows={data.pendingRuns} onConfirm={confirm} />
          <Card size="small" title="当前报价与竞争" style={{ marginTop: 8 }} data-testid="pricing-offers">
            {data.offers.observedAt ? <Typography.Text type="secondary">观察时间：{formatDateTime(data.offers.observedAt)}</Typography.Text> : null}
            <SimpleGrid<PricingOfferRow>
              gridId="pricing.pricing-sku-detail-page-3"
              rows={data.offers.state === 'OK' ? data.offers.rows : []}
              rowKey={offer => offer.offerKey}
              emptyState={{ kind: 'empty', domain: '竞争报价', prerequisite: data.offers.note ?? '还没有同步到竞争报价。' }}
              columns={[
                { title: '卖家', key: 'own', width: 100, render: (_v, offer) => (offer.isOwn ? <Tag color="processing">我方</Tag> : '其他卖家') },
                { title: '推荐报价', key: 'featured', width: 100, render: (_v, offer) => (offer.isFeatured ? <Tag color="success">是</Tag> : '否') },
                { title: '价格', key: 'price', width: 110, render: (_v, offer) => moneyCell(offer.price, row.currency) },
                { title: '运费', key: 'shipping', width: 110, render: (_v, offer) => moneyCell(offer.shipping, row.currency) },
                { title: '成色', dataIndex: 'condition', width: 100 },
                { title: '配送', dataIndex: 'fulfillment', width: 140 },
              ]}
            />
          </Card>
          <Card size="small" title="调价记录（前后各 7 天对照）" style={{ marginTop: 8 }} data-testid="pricing-adjustments">
            <SimpleGrid<PriceAdjustmentRow>
              gridId="pricing.pricing-sku-detail-page-4"
              rows={data.adjustments}
              rowKey={item => item.runId}
              emptyState={{ kind: 'empty', domain: '调价记录', prerequisite: '这个商品还没有通过本系统调过价。' }}
              columns={[
                { title: '时间', key: 'at', width: 150, render: (_v, item) => formatDateTime(item.at) },
                { title: '来源', dataIndex: 'sourceLabel', width: 170 },
                {
                  title: '价格变化',
                  key: 'change',
                  width: 170,
                  render: (_v, item) => (
                    <span className="erp-num">
                      {item.from === null ? '—' : formatMoney(item.from, row.currency, { digits: 2 })} → {formatMoney(item.to, row.currency, { digits: 2 })}
                    </span>
                  ),
                },
                { title: '状态', dataIndex: 'statusLabel', width: 130 },
                { title: '操作人', key: 'by', width: 100, render: (_v, item) => item.by ?? <Muted>系统</Muted> },
                { title: '调价前后', key: 'compare', render: (_v, item) => <CompareView compare={item.compare} /> },
              ]}
            />
            <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>
              对照是相关性，不是因果：同期的促销、广告、季节与竞争对手变化都会影响销量。
            </Typography.Paragraph>
          </Card>
          <Card size="small" title="价格事件" style={{ marginTop: 8 }} data-testid="pricing-events">
            <SimpleGrid<PricingEventRow>
              gridId="pricing.pricing-sku-detail-page-5"
              rows={data.events}
              rowKey={item => `${item.at}-${item.kind}-${item.title}`}
              emptyState={{ kind: 'empty', domain: '价格事件', prerequisite: '还没有价格变化、推荐报价得失或调价事件。' }}
              columns={[
                { title: '时间', key: 'at', width: 150, render: (_v, item) => formatDateTime(item.at) },
                { title: '事件', dataIndex: 'title', width: 220 },
                { title: '说明', key: 'detail', render: (_v, item) => item.detail ?? <Muted>—</Muted> },
              ]}
            />
          </Card>
          <Card size="small" title="适用的价格护栏" style={{ marginTop: 8 }}>
            <Guardrails rows={data.guardrails} currency={row.currency} />
          </Card>
          <p style={{ margin: '8px 0 0', fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{data.basis}</p>
        </>
      ) : null}
      <PriceChangeDrawer target={change ? target : null} suggestion={change?.suggestion} write={data?.write} onClose={() => setChange(null)} />
    </div>
  )
}
