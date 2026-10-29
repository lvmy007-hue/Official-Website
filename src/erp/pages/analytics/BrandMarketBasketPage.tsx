import { useState } from 'react'
import { Alert, Card, Input, Select, Space, Tag } from 'antd'
import { BA_BASKET_ADVICE_LABEL, BA_BASKET_ADVICES, BA_BASKET_SORT_LABEL, BA_BASKET_SORTS, type BaBasketResponse, type BaBasketRow, type BaMatrix } from '@nova/api-contracts'
import { LocalGrid, PageHeader, renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { changeColor, changeText, countText, heatColor, percentText } from './brand-options'
import { BrandFrame, useBrandPeriod } from './brand-ui'
import { Pager } from './business-reports-ui'

// 品牌分析·购物篮分析（P4-04，04 章 4.7）：买了我方某个 ASIN 的买家，同一订单里还买了哪些商品、同篮率多高；
// 15×15 热力矩阵一眼看出哪两个商品常一起买；同篮的是我方另一个 ASIN 就是捆绑销售候选，是别家商品就是商品定向广告候选（只是建议，不会自动执行）。
// 同篮率官方没给的值写“尚无记录”，不当 0。

const PAGE_SIZE = 20
const ADVICE_COLOR = { BUNDLE: 'success', PRODUCT_TARGETING: 'processing' } as const

const columns: ErpColDef<BaBasketRow>[] = [
  renderColumn<BaBasketRow>(
    '我方商品',
    'asin',
    row => (
      <span>
        <b>{row.asin}</b> <Muted>{row.asinTitle ?? '目录里没有这个 ASIN'}</Muted>
      </span>
    ),
    { width: 300, pin: 'left' },
  ),
  renderColumn<BaBasketRow>(
    '同篮商品',
    'paired',
    row => (
      <span>
        <b>{row.pairedAsin}</b>{' '}
        {row.pairedOwn ? (
          <Tag color="blue" bordered={false}>
            我方
          </Tag>
        ) : null}
        <Muted>{row.pairedTitle ?? (row.pairedOwn ? '' : '别家商品，没有标题')}</Muted>
      </span>
    ),
    { width: 360 },
  ),
  renderColumn<BaBasketRow>('同篮率', 'combinationPct', row => <span className="erp-num">{percentText(row.combinationPct, 2)}</span>, { width: 110, ...RIGHT_ALIGNED }),
  renderColumn<BaBasketRow>('较上一周期', 'change', row => <span style={{ color: changeColor(row.change) }}>{changeText(row.change)}</span>, { width: 130, ...RIGHT_ALIGNED }),
  renderColumn<BaBasketRow>('同篮排名', 'purchaseRank', row => countText(row.purchaseRank), { width: 110, ...RIGHT_ALIGNED }),
  renderColumn<BaBasketRow>(
    '建议',
    'advice',
    row =>
      row.advice ? (
        <Tag color={ADVICE_COLOR[row.advice]} bordered={false}>
          {BA_BASKET_ADVICE_LABEL[row.advice]}
        </Tag>
      ) : (
        <Muted>无</Muted>
      ),
    { width: 170, pin: 'right' },
  ),
]
/** 同篮率热力矩阵：行是我方商品、列是同篮商品，格子越深同篮率越高；没有这一对留空。 */
function Matrix({ matrix }: { matrix: BaMatrix }) {
  if (matrix.rows.length === 0) return <Muted>所选周期内没有可画矩阵的同篮数据</Muted>
  return (
    <div style={{ overflowX: 'auto' }} data-testid="ba-matrix">
      <table style={{ borderCollapse: 'collapse', fontSize: 12 }} aria-label="同篮率热力矩阵">
        <thead>
          <tr>
            <th style={{ padding: 4 }} />
            {matrix.columns.map(column => (
              <th key={column} style={{ padding: 4, fontWeight: 400 }}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((row, rowIndex) => (
            <tr key={row}>
              <th style={{ padding: 4, fontWeight: 400, textAlign: 'left' }}>{row}</th>
              {matrix.columns.map((column, columnIndex) => {
                const value = matrix.cells[rowIndex]?.[columnIndex] ?? null
                return (
                  <td
                    key={column}
                    data-testid="ba-matrix-cell"
                    title={`${row} + ${column}：${percentText(value, 2)}`}
                    style={{ padding: '4px 6px', textAlign: 'center', border: '1px solid #f0f0f0', background: heatColor(value, matrix.max), minWidth: 52 }}
                  >
                    {value === null ? '' : percentText(value, 1)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function BrandMarketBasketPage() {
  const [text, setText] = useState('')
  const [keyword, setKeyword] = useState<string | undefined>()
  const [sort, setSort] = useState<(typeof BA_BASKET_SORTS)[number]>('combinationPct')
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const reset = () => setStack([undefined])
  const period = useBrandPeriod(reset)
  const query = useApiQuery<BaBasketResponse>({
    domain: 'analytics',
    path: '/analytics/brand/market-basket',
    params: { ...period.params, q: keyword, sort: `${sort}:${sort === 'purchaseRank' ? 'asc' : 'desc'}`, pageSize: PAGE_SIZE, cursor: stack[stack.length - 1] },
  })
  return (
    <div>
      <PageHeader
        title="购物篮分析"
        description="买了你的商品的买家，同一订单里还买了什么：哪些是你自己的另一个商品（可以捆绑销售），哪些是别家的商品（可以做商品定向广告）。数据来自亚马逊品牌分析。"
      />
      <Card size="small" style={{ marginBottom: 8 }}>
        <Space wrap>
          <Input.Search
            allowClear
            style={{ width: 260 }}
            placeholder="搜索 ASIN 或标题"
            aria-label="搜索"
            value={text}
            onChange={event => setText(event.target.value)}
            onSearch={value => {
              setKeyword(value.trim() || undefined)
              reset()
            }}
          />
          <Select
            style={{ width: 170 }}
            aria-label="排序"
            value={sort}
            options={BA_BASKET_SORTS.map(value => ({ value, label: `按${BA_BASKET_SORT_LABEL[value]}` }))}
            onChange={value => {
              setSort(value)
              reset()
            }}
          />
        </Space>
      </Card>
      <BrandFrame query={query} period={period} testId="ba-basket">
        {data => (
          <>
            <Card size="small" title="同篮率矩阵" extra={<Muted>行是我方商品，列是同篮商品，颜色越深同篮率越高</Muted>}>
              <Matrix matrix={data.matrix} />
            </Card>
            <Alert
              type="info"
              showIcon
              style={{ margin: '8px 0' }}
              message={`建议规则：${BA_BASKET_ADVICES.map(key => `${BA_BASKET_ADVICE_LABEL[key]} ${data.adviceCounts[key]} 条`).join('，')}`}
              description={data.adviceBasis}
              data-testid="ba-basket-advice"
            />
            <Card size="small" title="同篮明细" data-testid="ba-basket-table">
              <LocalGrid<BaBasketRow>
                gridId="analytics.brand.market-basket"
                columns={columns}
                rows={data.items}
                getRowId={row => row.key}
                initialPageSize={20}
                height={520}
                emptyState={{ kind: 'empty', domain: '购物篮分析', prerequisite: data.note ?? '所选周期内没有同篮数据。' }}
              />
              <Pager stack={stack} setStack={setStack} pageInfo={data.pageInfo} fetching={query.isFetching} />
            </Card>
          </>
        )}
      </BrandFrame>
    </div>
  )
}
