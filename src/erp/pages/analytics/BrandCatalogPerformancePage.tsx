import { useState } from 'react'
import { Alert, Card, Col, Input, Row, Select, Space } from 'antd'
import { BA_CATALOG_SORT_LABEL, BA_CATALOG_SORTS, type BaCatalogFunnel, type BaCatalogResponse, type BaCatalogRow } from '@nova/api-contracts'
import { LocalGrid, PageHeader, renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { changeColor, changeText, countText, moneyText, percentText } from './brand-options'
import { BrandFrame, useBrandPeriod } from './brand-ui'
import { Pager, StatCard } from './business-reports-ui'

// 品牌分析·目录表现（P4-04，04 章 4.7）：按 ASIN 看搜索带来的展示、点击、加购、购买与搜索带来的销售额，
// 各步转化率由次数重算（点击 ÷ 展示、加购 ÷ 点击、购买 ÷ 加购），并与上一周期、业务报告的整体销售与会话对照。
// 官方没给的值写“尚无记录”，不当 0。

const PAGE_SIZE = 20

const rateCell = (value: number | null, previous: number | null | undefined) => {
  const diff = previous !== undefined && value !== null && previous !== null ? value - previous : null
  return (
    <span>
      <span className="erp-num">{percentText(value, 2)}</span>
      {previous === undefined ? null : <span style={{ marginLeft: 6, fontSize: 11, color: changeColor(diff) }}>{changeText(diff)}</span>}
    </span>
  )
}

const columns: ErpColDef<BaCatalogRow>[] = [
  renderColumn<BaCatalogRow>(
    '商品',
    'asin',
    row => (
      <span>
        <b>{row.asin}</b> <Muted>{row.title ?? '目录里没有这个 ASIN'}</Muted>
        {row.brand ? <Muted> · {row.brand}</Muted> : null}
      </span>
    ),
    { width: 340, pin: 'left' },
  ),
  renderColumn<BaCatalogRow>('展示', 'impressions', row => countText(row.impressions), { width: 100, ...RIGHT_ALIGNED }),
  renderColumn<BaCatalogRow>('点击', 'clicks', row => countText(row.clicks), { width: 100, ...RIGHT_ALIGNED }),
  renderColumn<BaCatalogRow>('点击率', 'clickRate', row => rateCell(row.clickRate, row.previous ? row.previous.clickRate : undefined), { width: 170, ...RIGHT_ALIGNED }),
  renderColumn<BaCatalogRow>('加购', 'cartAdds', row => countText(row.cartAdds), { width: 100, ...RIGHT_ALIGNED }),
  renderColumn<BaCatalogRow>('加购率', 'cartAddRate', row => rateCell(row.cartAddRate, row.previous ? row.previous.cartAddRate : undefined), { width: 170, ...RIGHT_ALIGNED }),
  renderColumn<BaCatalogRow>('购买', 'purchases', row => countText(row.purchases), { width: 100, ...RIGHT_ALIGNED }),
  renderColumn<BaCatalogRow>('购买率', 'purchaseRate', row => rateCell(row.purchaseRate, row.previous ? row.previous.purchaseRate : undefined), { width: 170, ...RIGHT_ALIGNED }),
  renderColumn<BaCatalogRow>('搜索带来的销售额', 'searchTrafficSales', row => moneyText(row.searchTrafficSales), { width: 150, ...RIGHT_ALIGNED }),
  renderColumn<BaCatalogRow>('订购销售额（业务报告）', 'allSales', row => moneyText(row.allSales), { width: 170, ...RIGHT_ALIGNED }),
  renderColumn<BaCatalogRow>('搜索销售额占比', 'searchSalesShare', row => percentText(row.searchSalesShare), { width: 140, ...RIGHT_ALIGNED }),
  renderColumn<BaCatalogRow>('会话（业务报告）', 'sessions', row => countText(row.sessions), { width: 140, ...RIGHT_ALIGNED }),
]
function Summary({ summary }: { summary: BaCatalogFunnel }) {
  return (
    <Row gutter={8} data-testid="ba-catalog-summary">
      <Col xs={12} md={6}>
        <StatCard title="展示" footer={<Muted>点击率 {percentText(summary.clickRate, 2)}</Muted>}>
          {countText(summary.impressions)}
        </StatCard>
      </Col>
      <Col xs={12} md={6}>
        <StatCard title="点击" footer={<Muted>加购率 {percentText(summary.cartAddRate, 2)}</Muted>}>
          {countText(summary.clicks)}
        </StatCard>
      </Col>
      <Col xs={12} md={6}>
        <StatCard title="加购" footer={<Muted>购买率 {percentText(summary.purchaseRate, 2)}</Muted>}>
          {countText(summary.cartAdds)}
        </StatCard>
      </Col>
      <Col xs={12} md={6}>
        <StatCard title="购买" footer={<Muted>搜索带来的销售额 {moneyText(summary.searchTrafficSales)}</Muted>}>
          {countText(summary.purchases)}
        </StatCard>
      </Col>
    </Row>
  )
}

export default function BrandCatalogPerformancePage() {
  const [text, setText] = useState('')
  const [keyword, setKeyword] = useState<string | undefined>()
  const [sort, setSort] = useState<(typeof BA_CATALOG_SORTS)[number]>('purchases')
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const reset = () => setStack([undefined])
  const period = useBrandPeriod(reset)
  const query = useApiQuery<BaCatalogResponse>({
    domain: 'analytics',
    path: '/analytics/brand/catalog',
    params: { ...period.params, q: keyword, sort: `${sort}:desc`, pageSize: PAGE_SIZE, cursor: stack[stack.length - 1] },
  })
  return (
    <div>
      <PageHeader title="目录表现" description="看每个 ASIN 通过亚马逊搜索得到的展示、点击、加购、购买和搜索带来的销售额，以及每一步的转化率。数据来自亚马逊品牌分析。" />
      <Card size="small" style={{ marginBottom: 8 }}>
        <Space wrap>
          <Input.Search
            allowClear
            style={{ width: 240 }}
            placeholder="搜索 ASIN、标题或品牌"
            aria-label="搜索"
            value={text}
            onChange={event => setText(event.target.value)}
            onSearch={value => {
              setKeyword(value.trim() || undefined)
              reset()
            }}
          />
          <Select
            style={{ width: 190 }}
            aria-label="排序"
            value={sort}
            options={BA_CATALOG_SORTS.map(value => ({ value, label: `按${BA_CATALOG_SORT_LABEL[value]}` }))}
            onChange={value => {
              setSort(value)
              reset()
            }}
          />
        </Space>
      </Card>
      <BrandFrame query={query} period={period} testId="ba-catalog">
        {data => (
          <>
            <Summary summary={data.summary} />
            <Alert type="info" showIcon style={{ margin: '8px 0' }} message={data.compareNote} data-testid="ba-catalog-note" />
            <Card size="small" title="按 ASIN" data-testid="ba-catalog-table">
              <LocalGrid<BaCatalogRow>
                gridId="analytics.brand.catalog"
                columns={columns}
                rows={data.items}
                getRowId={row => row.key}
                initialPageSize={20}
                height={560}
                emptyState={{ kind: 'empty', domain: '目录表现', prerequisite: data.note ?? '所选范围内没有 ASIN 的目录表现数据。' }}
              />
              <Pager stack={stack} setStack={setStack} pageInfo={data.pageInfo} fetching={query.isFetching} />
            </Card>
          </>
        )}
      </BrandFrame>
    </div>
  )
}
