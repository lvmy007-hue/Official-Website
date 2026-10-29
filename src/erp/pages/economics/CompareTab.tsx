import { useState, type ReactNode } from 'react'
import { Alert, Input, Segmented, Select, Space, Statistic, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  COMPARE_FILTERS,
  COMPARE_SORTS,
  COMPARE_SORT_LABEL,
  DIFF_CLASSES,
  DIFF_CLASS_LABEL,
  DIFF_CLASS_NOTE,
  NOT_COMPARABLE_LABEL,
  PROFIT_BASES,
  PROFIT_BASIS_LABEL,
  VERDICT_LABEL,
  type CompareFilter,
  type CompareSort,
  type CompareVerdict,
  type EconomicsCompareResponse,
  type EconomicsCompareRow,
  type ProfitBasis,
} from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { PAGE_SIZE, Pager, TabFrame, plainMoney, signedMoney, useCursorStack } from './economics-ui'

// 双源核对（07 章 7.10 第 1 个页签）：官方单品经济（亚马逊数据中心）与我方利润日表逐 SKU 逐日核对，差异拆成成本口径、广告口径、时间口径、未解释四类。
// 所有“差异”都是对“官方净收益 − 我方可比净收益”的带符号贡献（正数表示官方更高）。官方一天都没有记录的 SKU 不当作全部差异，写“无法核对”。

const VERDICT_COLOR: Record<CompareVerdict, string> = { MATCH: 'success', COST: 'blue', ADS: 'purple', TIME: 'gold', UNEXPLAINED: 'error', NOT_COMPARABLE: 'default' }
const FILTER_LABEL: Record<CompareFilter, string> = { ALL: '全部', DIFF: '只看有差异', MATCH: '只看一致', NOT_COMPARABLE: '只看无法核对', ...DIFF_CLASS_LABEL }

function Pair({ official, ours }: { official: ReactNode; ours: ReactNode }) {
  return (
    <div style={{ lineHeight: 1.5 }}>
      <div>
        <Muted>官方 </Muted>
        {official}
      </div>
      <div>
        <Muted>我方 </Muted>
        {ours}
      </div>
    </div>
  )
}

const NONE = <Muted>尚无记录</Muted>

export const compareColumns: ColumnsType<EconomicsCompareRow> = [
  { title: '日期', dataIndex: 'date', width: 100, render: (value: string) => <span className="erp-num">{value}</span> },
  {
    title: '商品',
    key: 'product',
    width: 200,
    render: (_value, row) => (
      <div>
        <span className="erp-num">{row.msku}</span>
        {row.asin ? <span style={{ marginLeft: 8, color: 'rgba(0,0,0,0.45)' }}>{row.asin}</span> : null}
        <div style={{ color: 'rgba(0,0,0,0.55)' }}>{row.storeName}</div>
      </div>
    ),
  },
  { title: '销售额（净）', key: 'sales', width: 150, align: 'right', render: (_value, row) => <Pair official={plainMoney(row.official?.sales, NONE)} ours={plainMoney(row.ours.sales, NONE)} /> },
  { title: '费用', key: 'fees', width: 150, align: 'right', render: (_value, row) => <Pair official={plainMoney(row.official?.fees, NONE)} ours={plainMoney(row.ours.fees, NONE)} /> },
  {
    title: '广告',
    key: 'ads',
    width: 160,
    align: 'right',
    render: (_value, row) => <Pair official={plainMoney(row.official?.ads, NONE)} ours={row.ours.state === 'NO_RECORD' ? NONE : plainMoney(row.ours.ads, <Muted>尚未分摊</Muted>)} />,
  },
  {
    title: '成本',
    key: 'cost',
    width: 160,
    align: 'right',
    render: (_value, row) => (
      <Pair
        official={row.official === null ? NONE : plainMoney(row.official.cost, <Muted>官方未提供</Muted>)}
        ours={row.ours.state === 'NO_RECORD' ? NONE : plainMoney(row.ours.cost, <Muted>尚无成本</Muted>)}
      />
    ),
  },
  { title: '净差异（官方−我方）', key: 'net', width: 150, align: 'right', render: (_value, row) => (row.impact === null ? <Muted>—</Muted> : signedMoney(row.impact.net)) },
  {
    title: '结论',
    key: 'verdict',
    width: 190,
    render: (_value, row) => (
      <div>
        <Tooltip title={row.notes.length > 0 ? row.notes.join('；') : undefined}>
          <Tag color={VERDICT_COLOR[row.verdict]} bordered={false}>
            {VERDICT_LABEL[row.verdict]}
          </Tag>
        </Tooltip>
        {row.notComparable ? <div style={{ color: 'rgba(0,0,0,0.55)', fontSize: 12 }}>{NOT_COMPARABLE_LABEL[row.notComparable]}</div> : null}
        {row.notes.length > 0 && row.verdict !== 'NOT_COMPARABLE' ? <div style={{ color: 'rgba(0,0,0,0.55)', fontSize: 12 }}>{row.notes[0]}</div> : null}
      </div>
    ),
  },
]

function Summary({ data }: { data: EconomicsCompareResponse }) {
  const { summary } = data
  const ads = summary.ads
  return (
    <div>
      <Space size={32} wrap style={{ margin: '8px 0' }} data-testid="economics-summary">
        <Statistic title="可核对行数" value={summary.comparable} suffix={`/ ${summary.rows}`} />
        <Statistic title="一致" value={summary.matched} />
        <Statistic title="无法核对" value={summary.notComparable} />
        <Statistic title="净差异合计（官方−我方）" formatter={() => (summary.netDiff === null ? <Muted>尚无记录</Muted> : signedMoney(summary.netDiff))} />
      </Space>
      <Space wrap style={{ marginBottom: 8 }} data-testid="economics-classes">
        {DIFF_CLASSES.map(name => (
          <Tooltip key={name} title={DIFF_CLASS_NOTE[name]}>
            <Tag bordered={false} color={VERDICT_COLOR[name]}>
              {DIFF_CLASS_LABEL[name]}：{signedMoney(summary.byClass[name].amount)}（{summary.byClass[name].rows} 行）
            </Tag>
          </Tooltip>
        ))}
      </Space>
      <Alert
        type={ads.state === 'OK' ? 'success' : 'info'}
        showIcon
        style={{ marginBottom: 8 }}
        data-testid="economics-ads"
        message={
          ads.state === 'OK' ? (
            <span>
              店铺广告核对：官方 {plainMoney(ads.official)}，我方 {plainMoney(ads.ours)}，差额（官方−我方）{signedMoney(ads.diff)}
            </span>
          ) : ads.state === 'NOT_CONNECTED' ? (
            '店铺广告核对：我方广告尚未接入'
          ) : (
            '店铺广告核对：官方在所选范围内尚无记录'
          )
        }
        description={ads.note}
      />
    </div>
  )
}

export function CompareTab() {
  const [recognition, setRecognition] = useState<ProfitBasis>('ORDERED')
  const [verdict, setVerdict] = useState<CompareFilter>('ALL')
  const [sort, setSort] = useState<CompareSort>('diff')
  const [q, setQ] = useState<string | undefined>(undefined)
  const [text, setText] = useState('')
  const paging = useCursorStack()
  const query = useApiQuery<EconomicsCompareResponse>({
    domain: 'list',
    path: '/finance/economics/compare',
    params: { recognition, verdict, q, sort: `${sort}:desc`, pageSize: PAGE_SIZE, cursor: paging.cursor },
  })
  const change = (apply: () => void) => {
    apply()
    paging.reset()
  }
  return (
    <div>
      <Space wrap style={{ margin: '8px 0' }}>
        <Select
          style={{ width: 150 }}
          aria-label="我方收入确认口径"
          value={recognition}
          options={PROFIT_BASES.map(value => ({ value, label: `我方：${PROFIT_BASIS_LABEL[value]}` }))}
          onChange={value => change(() => setRecognition(value))}
        />
        <Segmented
          aria-label="结论过滤"
          value={verdict}
          options={COMPARE_FILTERS.map(value => ({ value, label: FILTER_LABEL[value] }))}
          onChange={value => change(() => setVerdict(value as CompareFilter))}
        />
        <Input.Search
          allowClear
          style={{ width: 220 }}
          placeholder="搜索 SKU 或 ASIN"
          aria-label="搜索商品"
          value={text}
          onChange={event => setText(event.target.value)}
          onSearch={value => change(() => setQ(value.trim() || undefined))}
        />
        <Select
          style={{ width: 150 }}
          aria-label="排序"
          value={sort}
          options={COMPARE_SORTS.map(value => ({ value, label: `按${COMPARE_SORT_LABEL[value]}从高到低` }))}
          onChange={value => change(() => setSort(value))}
        />
      </Space>
      <TabFrame query={query} testId="economics-compare">
        {data => (
          <>
            {data.range.defaulted ? (
              <Alert type="info" showIcon style={{ margin: '8px 0' }} message={`未选择日期范围，当前核对 ${data.range.from} 至 ${data.range.to}（最近 ${data.range.days} 天）`} />
            ) : null}
            {data.truncated ? <Alert type="warning" showIcon style={{ margin: '8px 0' }} message="数据行数超过读取上限，核对不完整" /> : null}
            {data.officialCoverage ? (
              <p style={{ margin: '4px 0', color: 'rgba(0,0,0,0.65)' }}>
                官方数据覆盖 {data.officialCoverage.from} 至 {data.officialCoverage.to}；我方口径：{data.basisLabel}；金额单位 {data.currency}。
              </p>
            ) : null}
            <Summary data={data} />
            <SimpleGrid<EconomicsCompareRow>
              gridId="economics.compare-tab"
              columns={compareColumns}
              rows={data.items}
              rowKey={row => row.key}
              loading={query.isFetching}
              emptyState={{ kind: 'empty', domain: '官方经济数据核对', prerequisite: data.note ?? '所选条件下没有行。' }}
            />
            <Pager stack={paging.stack} setStack={paging.setStack} pageInfo={data.pageInfo} fetching={query.isFetching} />
          </>
        )}
      </TabFrame>
    </div>
  )
}
