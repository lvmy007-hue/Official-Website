import { useMemo, useState } from 'react'
import { Alert, Card, Descriptions, Select, Space, Tag, Typography } from 'antd'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { COMPETITOR_FEATURED_LABEL, COMPETITOR_REASON_LABEL, type CompetitorChange, type CompetitorCompareRow, type CompetitorDetailResponse, type CompetitorOfferView } from '@nova/api-contracts'
import { ChartPanel, FreshnessBar, PageHeader, SimpleGrid } from '../../components'
import { formatDateTime, formatNumber } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { moneyCell } from '../advertising/ads-campaigns-ui'
import { Muted } from '../inventory/inventory-ui'
import { buildPriceTrendOption, buildRankTrendOption, buildShareTrendOption } from './competitors-detail-options'
import { ShareTrendPanel } from '../analytics/share-trend-panel'
import { FEATURED_COLOR, detailPath, detailSearch } from './competitors-state'

// 竞品详情（P4-12，05 章 5.6）：最新属性、价格与销售排名对比趋势、目录变化（标题、品牌、图片数量）、在我方核心搜索词中的点击份额趋势（下限）、
// 与我方商品并排对照、我方商品页面上的其他卖家报价。竞品的评分与评分数没有官方来源，固定声明、不显示。没有数据写“尚无记录”，不补 0。

const DAYS = [30, 90, 180]

const NONE = <Muted>尚无记录</Muted>
const section = (state: string, note: string | null) => (state === 'OK' ? undefined : { kind: 'empty' as const, domain: '数据', prerequisite: note ?? '尚无记录' })

export default function CompetitorDetailPage() {
  const { asin } = useParams({ strict: false }) as { asin: string }
  const { storeId, ownAsin } = useSearch({ strict: false }) as { storeId?: string; ownAsin?: string }
  const navigate = useNavigate()
  const [days, setDays] = useState(90)
  const query = useApiQuery<CompetitorDetailResponse>({
    domain: 'list',
    path: `/competitors/${encodeURIComponent(asin ?? '')}`,
    scoped: false,
    params: { storeId, ownAsin, days },
    enabled: Boolean(storeId && asin),
  })
  const data = query.data
  const latest = data?.latest ?? null
  const options = useMemo(
    () => (data ? { price: buildPriceTrendOption(data.trend.points, data.trend.currency), rank: buildRankTrendOption(data.trend.points), share: buildShareTrendOption(data.shareTrend.points) } : null),
    [data],
  )
  const switchOwn = (value: string) => {
    if (!storeId || !asin) return
    void navigate({ to: detailPath(asin), search: detailSearch(storeId, value) as never })
  }
  const ownChoices = (data?.watches ?? []).filter(watch => watch.ownAsin !== null)

  return (
    <div data-testid="competitor-detail-page">
      <PageHeader
        title={latest?.title ?? `竞品详情：${asin}`}
        description={data ? `${data.asin} · ${latest?.brand ?? '品牌尚无记录'} · ${data.store.name}` : '最新属性、价格与排名趋势、目录变化、核心词点击份额与我方对照。'}
        actions={<AppLink to="/app/competitors">返回竞品列表</AppLink>}
      />
      <FreshnessBar freshness={data?.freshness} />
      {!storeId ? <Alert type="warning" showIcon style={{ marginTop: 8 }} message="缺少店铺参数：请从竞品列表点进来。" /> : null}
      {query.isError ? <Alert type="error" showIcon role="alert" style={{ marginTop: 8 }} message="读取竞品详情失败，请稍后重试；如果这个竞品已被取消关注，请回到列表。" /> : null}
      {data ? (
        <>
          <Card size="small" style={{ marginTop: 8 }} data-testid="competitor-summary-card">
            {latest ? (
              <Descriptions size="small" column={4}>
                <Descriptions.Item label="价格">{moneyCell(latest.price, latest.currency)}</Descriptions.Item>
                <Descriptions.Item label="推荐报价">
                  {latest.featured ? (
                    <Tag color={FEATURED_COLOR[latest.featured]} bordered={false}>
                      {COMPETITOR_FEATURED_LABEL[latest.featured]}
                    </Tag>
                  ) : (
                    NONE
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="配送方式">{latest.fulfillment ?? NONE}</Descriptions.Item>
                <Descriptions.Item label="会员资格">{latest.memberEligible === null ? NONE : latest.memberEligible ? '会员可享' : '会员不可享'}</Descriptions.Item>
                <Descriptions.Item label="销售排名">
                  {latest.rank === null ? NONE : <span className="erp-num">{`第 ${formatNumber(latest.rank, { digits: 0 })} 名${latest.rankName ? `（${latest.rankName}）` : ''}`}</span>}
                </Descriptions.Item>
                <Descriptions.Item label="图片数量">{latest.imageCount === null ? NONE : <span className="erp-num">{latest.imageCount}</span>}</Descriptions.Item>
                <Descriptions.Item label="最近同步">{formatDateTime(latest.observedAt)}</Descriptions.Item>
                <Descriptions.Item label="评分与评分数">
                  <Typography.Text type="secondary" data-testid="competitor-rating">
                    无官方来源
                  </Typography.Text>
                </Descriptions.Item>
              </Descriptions>
            ) : (
              <Alert type="info" showIcon message={data.trend.note ?? '还没有同步到这个竞品的快照；新关注的竞品要等下一次同步（每 6 小时一次）。'} />
            )}
            <Space wrap style={{ marginTop: 8 }}>
              <span>对照的我方商品：</span>
              {ownChoices.length > 0 ? (
                <Select
                  aria-label="对照的我方商品"
                  style={{ minWidth: 320 }}
                  value={data.ownAsin ?? undefined}
                  onChange={switchOwn}
                  options={ownChoices.map(watch => ({ value: watch.ownAsin as string, label: `${watch.ownAsin} ${watch.ownTitle ?? ''}` }))}
                />
              ) : (
                <Muted>没有指定我方对应商品</Muted>
              )}
              {data.watches.map(watch => (
                <Tag key={watch.id} bordered={false}>
                  {watch.ownAsin ?? '未指定'}：{COMPETITOR_REASON_LABEL[watch.reason]}
                  {watch.reasonNote ? `（${watch.reasonNote}）` : ''}，{formatDateTime(watch.addedAt)} 关注
                </Tag>
              ))}
            </Space>
            <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>
              {data.rating.note}
            </Typography.Paragraph>
          </Card>

          <Card
            size="small"
            title="价格与销售排名趋势"
            style={{ marginTop: 8 }}
            extra={
              <Select
                aria-label="回看天数"
                size="small"
                value={String(days)}
                onChange={value => setDays(Number(value))}
                options={DAYS.map(value => ({ value: String(value), label: `近 ${value} 天` }))}
              />
            }
          >
            {options ? (
              <Space direction="vertical" style={{ width: '100%' }}>
                <ChartPanel title="价格对比" ariaLabel="价格对比曲线" option={options.price} height={240} emptyState={section(data.trend.state, data.trend.note)} />
                <ChartPanel title="销售排名对比（名次越靠前越在上方）" ariaLabel="销售排名对比曲线" option={options.rank} height={240} emptyState={section(data.trend.state, data.trend.note)} />
              </Space>
            ) : null}
            {data.trend.truncated ? <Alert type="info" showIcon style={{ marginTop: 8 }} message="记录很多，只显示了最近的一部分" /> : null}
          </Card>

          <Card size="small" title="在我方核心搜索词中的点击份额（下限）" style={{ marginTop: 8 }} data-testid="competitor-share">
            {options ? <ChartPanel title="按周" ariaLabel="核心词点击份额曲线" option={options.share} height={220} emptyState={section(data.shareTrend.state, data.shareTrend.note)} /> : null}
            {data.shareTrend.state === 'OK' ? (
              <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>
                各周都用我方这个商品最近一周搜索量最高的 {data.shareTrend.coreTerms} 个核心词与同一组权重；热门搜索词只给点击前三的份额，没进前三的词按 0 计，所以这是下限，不是精确值。
              </Typography.Paragraph>
            ) : null}
          </Card>

          <ShareTrendPanel asin={asin} />

          <Card size="small" title="与我方商品并排对照" style={{ marginTop: 8 }} data-testid="competitor-compare">
            <SimpleGrid<CompetitorCompareRow>
              gridId="competitors.competitor-detail-page"
              rows={data.compare.rows}
              rowKey={row => row.key}
              emptyState={{ kind: 'empty', domain: '并排对照', prerequisite: data.compare.note ?? '尚无记录' }}
              columns={[
                { title: '项目', dataIndex: 'label', width: 120 },
                { title: '我方', key: 'own', render: (_v, row) => row.own ?? NONE },
                { title: '竞品', key: 'competitor', render: (_v, row) => row.competitor ?? NONE },
                { title: '说明', key: 'note', render: (_v, row) => (row.note ? <span style={{ fontSize: 12 }}>{row.note}</span> : null) },
              ]}
            />
          </Card>

          <Card size="small" title="目录变化（标题、品牌、图片数量）" style={{ marginTop: 8 }} data-testid="competitor-changes">
            <SimpleGrid<CompetitorChange>
              gridId="competitors.competitor-detail-page-2"
              rows={data.changes.items}
              rowKey={row => `${row.at}-${row.field}`}
              emptyState={{ kind: 'empty', domain: '目录变化', prerequisite: data.changes.note ?? '最近 180 天没有发现变化。' }}
              columns={[
                { title: '时间', key: 'at', width: 150, render: (_v, row) => formatDateTime(row.at) },
                { title: '项目', dataIndex: 'label', width: 100 },
                { title: '变化前', key: 'before', render: (_v, row) => row.before ?? NONE },
                { title: '变化后', key: 'after', render: (_v, row) => row.after ?? NONE },
              ]}
            />
            {data.changes.truncated ? <Typography.Text type="secondary">只显示了最近 50 条变化。</Typography.Text> : null}
          </Card>

          <Card size="small" title="我方商品页面上的其他卖家报价" style={{ marginTop: 8 }} data-testid="competitor-offers">
            {data.otherOffers.observedAt ? (
              <Typography.Text type="secondary">
                观察时间：{formatDateTime(data.otherOffers.observedAt)}。{data.otherOffers.note}
              </Typography.Text>
            ) : null}
            <SimpleGrid<CompetitorOfferView>
              gridId="competitors.competitor-detail-page-3"
              rows={data.otherOffers.items}
              rowKey={row => [row.fulfillment, row.condition, row.price, row.shipping, row.isOwn, row.isFeatured].join('|')}
              emptyState={{ kind: 'empty', domain: '其他卖家报价', prerequisite: data.otherOffers.note ?? '尚无记录' }}
              columns={[
                { title: '卖家', key: 'own', width: 100, render: (_v, row) => (row.isOwn ? <Tag color="processing">我方</Tag> : '其他卖家') },
                { title: '推荐报价', key: 'featured', width: 100, render: (_v, row) => (row.isFeatured ? <Tag color="success">是</Tag> : '否') },
                { title: '价格', key: 'price', width: 110, render: (_v, row) => moneyCell(row.price, latest?.currency ?? 'USD') },
                { title: '运费', key: 'shipping', width: 110, render: (_v, row) => moneyCell(row.shipping, latest?.currency ?? 'USD') },
                { title: '成色', dataIndex: 'condition', width: 100 },
                { title: '配送', dataIndex: 'fulfillment', width: 140 },
              ]}
            />
          </Card>
          <p style={{ margin: '8px 0 0', fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{data.basis}</p>
        </>
      ) : null}
    </div>
  )
}
