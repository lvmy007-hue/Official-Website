import { useMemo, useState } from 'react'
import { Card, Input, Segmented, Select, Space, Tag } from 'antd'
import {
  BA_ADVERTISING_LABEL,
  BA_BREAKPOINT_LABEL,
  BA_QUADRANT_LABEL,
  BA_SQP_SORT_LABEL,
  BA_SQP_SORTS,
  type BaDimension,
  type BaQueryRow,
  type BaSearchQueryResponse,
  type BaShareSet,
} from '@nova/api-contracts'
import { LocalGrid, PageHeader, renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { TermLink } from '../advertising/ad-terms-ui'
import { changeColor, changeText, countText, percentText, quadrantColor } from './brand-options'
import { BreakpointPanel, FunnelPanel, OverviewPanel, PricePanel, QuadrantPanel, TrendPanel } from './brand-sqp-panels'
import { BrandFrame, useBrandPeriod } from './brand-ui'
import { Pager } from './business-reports-ui'

// 品牌分析·搜索查询表现（P4-04，04 章 4.7）：按 ASIN 或品牌看每个搜索词的展示、点击、加购、购买份额，
// 份额漏斗、逐期趋势、价格与配送速度、机会象限、份额漏斗断点诊断、品牌搜索份额总览；未投放的词一键去词级分析页加入投放。
// 份额由次数重算；官方没给的值写“尚无记录”，不当 0。

const PAGE_SIZE = 20
const SHARE_COLUMNS: ReadonlyArray<{ key: keyof BaShareSet; title: string }> = [
  { key: 'impression', title: '展示份额' },
  { key: 'click', title: '点击份额' },
  { key: 'cartAdd', title: '加购份额' },
  { key: 'purchase', title: '购买份额' },
]
const NO_JUDGE = '未判断'
const ADVERTISING_COLOR = { ADVERTISED: 'success', PAUSED: 'warning', NONE: 'default', NOT_CONNECTED: 'default' } as const

const shareColumn = (key: keyof BaShareSet, title: string): ErpColDef<BaQueryRow> =>
  renderColumn<BaQueryRow>(
    title,
    key,
    row => (
      <span>
        <span className="erp-num">{percentText(row.shares[key])}</span>
        <span style={{ marginLeft: 6, fontSize: 11, color: changeColor(row.changes[key]) }}>{changeText(row.changes[key])}</span>
      </span>
    ),
    { width: 170, ...RIGHT_ALIGNED },
  )

const columns: ErpColDef<BaQueryRow>[] = [
  renderColumn<BaQueryRow>('搜索词', 'searchQuery', row => row.searchQuery, { width: 200, pin: 'left' }),
  renderColumn<BaQueryRow>('搜索量', 'volume', row => countText(row.searchVolume), { width: 110, ...RIGHT_ALIGNED }),
  ...SHARE_COLUMNS.map(item => shareColumn(item.key, item.title)),
  renderColumn<BaQueryRow>('我方购买', 'ownPurchases', row => countText(row.ownPurchases), { width: 110, ...RIGHT_ALIGNED }),
  renderColumn<BaQueryRow>(
    '象限',
    'quadrant',
    row =>
      row.quadrant ? (
        <Tag color={quadrantColor(row.quadrant)} bordered={false}>
          {BA_QUADRANT_LABEL[row.quadrant]}
        </Tag>
      ) : (
        <Muted>{NO_JUDGE}</Muted>
      ),
    { width: 120 },
  ),
  renderColumn<BaQueryRow>('断点', 'breakpoint', row => (row.breakpoint ? BA_BREAKPOINT_LABEL[row.breakpoint] : <Muted>无</Muted>), { width: 140 }),
  renderColumn<BaQueryRow>(
    '广告',
    'advertising',
    row => (
      <Space size={4}>
        <Tag color={ADVERTISING_COLOR[row.advertising]} bordered={false}>
          {BA_ADVERTISING_LABEL[row.advertising]}
        </Tag>
        {row.advertising === 'NONE' ? <TermLink term={row.searchQuery}>加入投放</TermLink> : null}
      </Space>
    ),
    { width: 210, pin: 'right' },
  ),
]
export default function BrandSearchQueryPage() {
  const [dimension, setDimension] = useState<BaDimension>('BRAND')
  const [asin, setAsin] = useState<string | undefined>()
  const [brand, setBrand] = useState<string | undefined>()
  const [text, setText] = useState('')
  const [keyword, setKeyword] = useState<string | undefined>()
  const [sort, setSort] = useState<(typeof BA_SQP_SORTS)[number]>('searchVolume')
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const reset = () => setStack([undefined])
  const period = useBrandPeriod(reset)
  const query = useApiQuery<BaSearchQueryResponse>({
    domain: 'analytics',
    path: '/analytics/brand/search-query',
    params: {
      ...period.params,
      dimension,
      asin: dimension === 'ASIN' ? asin : undefined,
      brand: dimension === 'BRAND' ? brand : undefined,
      q: keyword,
      sort: `${sort}:desc`,
      pageSize: PAGE_SIZE,
      cursor: stack[stack.length - 1],
    },
  })
  const data = query.data
  const asinOptions = useMemo(
    () => (data?.asinOptions ?? []).map(item => ({ value: item.asin, label: `${item.asin}${item.title ? ` · ${item.title}` : ''}（${item.terms} 词）` })),
    [data?.asinOptions],
  )
  return (
    <div>
      <PageHeader title="搜索查询表现" description="看买家用哪些词搜到你的商品：每个词的展示、点击、加购、购买份额，哪里掉了份额、哪些词值得投放。数据来自亚马逊品牌分析，需要店铺有品牌分析角色。" />
      <Card size="small" style={{ marginBottom: 8 }}>
        <Space wrap>
          <Segmented
            aria-label="分析维度"
            value={dimension}
            options={[
              { value: 'BRAND', label: '按品牌' },
              { value: 'ASIN', label: '按 ASIN' },
            ]}
            onChange={value => {
              setDimension(value as BaDimension)
              reset()
            }}
          />
          {dimension === 'BRAND' ? (
            <Select
              allowClear
              showSearch
              style={{ width: 180 }}
              aria-label="品牌"
              placeholder="全部品牌"
              value={brand}
              options={(data?.brandOptions ?? []).map(value => ({ value, label: value }))}
              onChange={value => {
                setBrand(value)
                reset()
              }}
            />
          ) : (
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: 300 }}
              aria-label="ASIN"
              placeholder="选择一个 ASIN"
              value={asin}
              options={asinOptions}
              onChange={value => {
                setAsin(value)
                reset()
              }}
            />
          )}
          <Input.Search
            allowClear
            style={{ width: 220 }}
            placeholder="搜索关键词"
            aria-label="搜索关键词"
            value={text}
            onChange={event => setText(event.target.value)}
            onSearch={value => {
              setKeyword(value.trim() || undefined)
              reset()
            }}
          />
          <Select
            style={{ width: 150 }}
            aria-label="排序"
            value={sort}
            options={BA_SQP_SORTS.map(value => ({ value, label: `按${BA_SQP_SORT_LABEL[value]}` }))}
            onChange={value => {
              setSort(value)
              reset()
            }}
          />
        </Space>
      </Card>
      <BrandFrame query={query} period={period} testId="ba-sqp">
        {value => (
          <>
            <FunnelPanel stages={value.funnel} />
            <TrendPanel trend={value.trend} note={value.trendNote} />
            <PricePanel price={value.price} priceNote={value.priceNote} shipping={value.shipping} />
            <QuadrantPanel quadrant={value.quadrant} />
            <BreakpointPanel breakpoints={value.breakpoints} />
            <OverviewPanel overview={value.overview} />
            <Card size="small" title="搜索词明细" style={{ marginTop: 8 }} data-testid="ba-sqp-table">
              <LocalGrid<BaQueryRow>
                gridId="analytics.brand.search-query"
                columns={columns}
                rows={value.items}
                getRowId={row => row.key}
                initialPageSize={20}
                height={560}
                emptyState={{ kind: 'empty', domain: '搜索词明细', prerequisite: value.note ?? '所选范围内没有搜索词。' }}
              />
              <Pager stack={stack} setStack={setStack} pageInfo={value.pageInfo} fetching={query.isFetching} />
            </Card>
          </>
        )}
      </BrandFrame>
    </div>
  )
}
