import { useState } from 'react'
import { Alert, Button, Card, Drawer, Input, Segmented, Space, Tag } from 'antd'
import { BA_TERM_FILTER_LABEL, BA_TERM_FILTERS, BA_TERM_GROUP_LABEL, type BaTermFilter, type BaTermHistoryPoint, type BaTermRow, type BaTermsResponse } from '@nova/api-contracts'
import { DataState, LocalGrid, PageHeader, renderColumn, RIGHT_ALIGNED, stateFromError, type ErpColDef } from '../../components'
import { describeError } from '../../query/errors'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { TermLink } from '../advertising/ad-terms-ui'
import { changeColor, countText, percentText, rankChangeText } from './brand-options'
import { BrandFrame, useBrandPeriod, type BrandPeriodState } from './brand-ui'
import { Pager } from './business-reports-ui'

// 品牌分析·热门搜索词（P4-04，04 章 4.7）：亚马逊每期搜索频率排名靠前的词，以及每个词点击份额前三的商品；
// 标出我方进前三的词、机会词与风险词（规则写在页面上），点一个词看它最近 12 个周期的排名与我方份额。
// 竞品监控尚未接入（P4-12），这里只写明，不提供可点的假按钮。

const PAGE_SIZE = 20
const GROUP_COLOR = { OPPORTUNITY: 'success', RISK: 'error' } as const

const columns: ErpColDef<BaTermRow>[] = [
  renderColumn<BaTermRow>('搜索词', 'term', row => <b>{row.searchTerm}</b>, { width: 200, pin: 'left' }),
  renderColumn<BaTermRow>('部门', 'department', row => (row.department ? row.department : <Muted>未分部门</Muted>), { width: 130 }),
  renderColumn<BaTermRow>('搜索频率排名', 'rank', row => <span className="erp-num">{countText(row.rank)}</span>, { width: 130, ...RIGHT_ALIGNED }),
  renderColumn<BaTermRow>('较上一周期', 'rankChange', row => <span style={{ color: changeColor(row.rankChange) }}>{rankChangeText(row.rankChange)}</span>, { width: 130, ...RIGHT_ALIGNED }),
  renderColumn<BaTermRow>(
    '点击份额前三的商品',
    'slots',
    row => (
      <span>
        {row.slots.map(slot => (
          <span key={slot.rank} style={{ marginRight: 12, fontSize: 12 }}>
            {slot.rank}. {slot.asin ?? '尚无记录'}{' '}
            {slot.own ? (
              <Tag color="blue" bordered={false}>
                我方
              </Tag>
            ) : null}
            <Muted>
              {' '}
              点击份额 {percentText(slot.clickShare)}，转化份额 {percentText(slot.conversionShare)}
            </Muted>
          </span>
        ))}
      </span>
    ),
    { width: 760 },
  ),
  renderColumn<BaTermRow>(
    '分组',
    'group',
    row => (
      <Space size={4}>
        {row.inTop3 ? (
          <Tag color="blue" bordered={false}>
            我方进前三
          </Tag>
        ) : null}
        {row.group ? (
          <Tag color={GROUP_COLOR[row.group]} bordered={false}>
            {BA_TERM_GROUP_LABEL[row.group]}
          </Tag>
        ) : null}
      </Space>
    ),
    { width: 190, pin: 'right' },
  ),
]

const historyColumns: ErpColDef<BaTermHistoryPoint>[] = [
  renderColumn<BaTermHistoryPoint>('周期起始日', 'periodStart', row => <span className="erp-num">{row.periodStart}</span>, { width: 130 }),
  renderColumn<BaTermHistoryPoint>('搜索频率排名', 'rank', row => countText(row.rank), { width: 130, ...RIGHT_ALIGNED }),
  renderColumn<BaTermHistoryPoint>('我方最高点击份额', 'share', row => percentText(row.ownBestClickShare), { width: 150, ...RIGHT_ALIGNED }),
  renderColumn<BaTermHistoryPoint>('进前三', 'top3', row => (row.inTop3 ? '是' : '否'), { width: 90 }),
]
function TermDrawer({ term, period, onClose }: { term: string | null; period: BrandPeriodState; onClose: () => void }) {
  const query = useApiQuery<BaTermsResponse>({
    domain: 'analytics',
    path: '/analytics/brand/search-terms',
    params: { ...period.params, term: term ?? undefined, pageSize: 1 },
    enabled: term !== null,
  })
  const history = query.data?.history
  return (
    <Drawer open={term !== null} onClose={onClose} width={560} title={term ? `“${term}”最近 12 个周期` : ''} destroyOnClose>
      <div data-testid="ba-term-drawer">
        {query.error ? (
          <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} />
        ) : !history ? (
          <DataState kind="skeleton" rows={4} />
        ) : (
          <LocalGrid<BaTermHistoryPoint>
            gridId="analytics.brand.search-terms.history"
            columns={historyColumns}
            rows={history.points}
            getRowId={row => row.periodStart}
            initialPageSize={20}
            height={420}
            emptyState={{ kind: 'empty', domain: '词的历史', prerequisite: '这个词在所选周期之前没有记录。' }}
          />
        )}
        <Space direction="vertical" style={{ marginTop: 12 }}>
          {term ? <TermLink term={term}>去词级分析页看这个词的投放</TermLink> : null}
          <Button disabled data-testid="ba-competitor-button">
            加入竞品监控（尚未接入）
          </Button>
          <Muted>{query.data?.competitorNote ?? '竞品监控尚未接入，随“竞品监控”工作包（P4-12）交付。'}</Muted>
        </Space>
      </div>
    </Drawer>
  )
}

export default function BrandSearchTermsPage() {
  const [text, setText] = useState('')
  const [keyword, setKeyword] = useState<string | undefined>()
  const [filter, setFilter] = useState<BaTermFilter>('ALL')
  const [selected, setSelected] = useState<string | null>(null)
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const reset = () => setStack([undefined])
  const period = useBrandPeriod(reset)
  const query = useApiQuery<BaTermsResponse>({
    domain: 'analytics',
    path: '/analytics/brand/search-terms',
    params: { ...period.params, filter, q: keyword, pageSize: PAGE_SIZE, cursor: stack[stack.length - 1] },
  })
  const counts = query.data?.groupCounts
  const countOf = (value: BaTermFilter) => (!counts ? undefined : value === 'ALL' ? undefined : value === 'TOP3' ? counts.top3 : counts[value])
  return (
    <div>
      <PageHeader title="热门搜索词" description="亚马逊每期搜索频率最高的词，以及每个词点击份额前三的商品；标出我方进前三的词、机会词与风险词。点一个词看它最近 12 个周期的变化。" />
      <Card size="small" style={{ marginBottom: 8 }}>
        <Space wrap>
          <Segmented
            aria-label="分组"
            value={filter}
            options={BA_TERM_FILTERS.map(value => ({ value, label: countOf(value) === undefined ? BA_TERM_FILTER_LABEL[value] : `${BA_TERM_FILTER_LABEL[value]} ${countOf(value)}` }))}
            onChange={value => {
              setFilter(value as BaTermFilter)
              reset()
            }}
          />
          <Input.Search
            allowClear
            style={{ width: 240 }}
            placeholder="搜索关键词"
            aria-label="搜索关键词"
            value={text}
            onChange={event => setText(event.target.value)}
            onSearch={value => {
              setKeyword(value.trim() || undefined)
              reset()
            }}
          />
        </Space>
      </Card>
      <BrandFrame query={query} period={period} testId="ba-terms">
        {data => (
          <>
            {data.ownAsinCount === 0 ? (
              <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="还没有同步到我方商品，无法判断“我方进前三”以及机会词、风险词" data-testid="ba-terms-noasin" />
            ) : null}
            <Alert type="info" showIcon style={{ marginBottom: 8 }} message="分组规则" description={data.groupBasis} data-testid="ba-terms-basis" />
            <Card size="small" title="搜索词" extra={<Muted>点一行看这个词的历史</Muted>}>
              <LocalGrid<BaTermRow>
                gridId="analytics.brand.search-terms"
                columns={columns}
                rows={data.items}
                getRowId={row => row.key}
                initialPageSize={20}
                height={560}
                onRowOpen={row => setSelected(row.searchTerm)}
                emptyState={{ kind: 'empty', domain: '热门搜索词', prerequisite: data.note ?? '所选周期与分组下没有搜索词。' }}
              />
              <Pager stack={stack} setStack={setStack} pageInfo={data.pageInfo} fetching={query.isFetching} />
            </Card>
          </>
        )}
      </BrandFrame>
      <TermDrawer term={selected} period={period} onClose={() => setSelected(null)} />
    </div>
  )
}
