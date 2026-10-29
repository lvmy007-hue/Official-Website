import { useCallback, useMemo, useState } from 'react'
import { Segmented, Space } from 'antd'
import type { Asin360CompareParty, Asin360CompetitorCompareResponse } from '@nova/api-contracts'
import { ChartPanel, PagedGrid, renderColumn, RIGHT_ALIGNED, type ErpColDef, type PageFetcher } from '../../components'
import { formatDateTime, formatMoney, formatNumber } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { QueryBody, useProductQuery } from './asin360-hooks'
import { buildCompareOption, COMPARE_METRIC_LABEL, COMPARE_METRICS, hasMetricData, type CompareMetric } from './asin360-competitor-options'

// 竞品对比（P6-21，16 章 3.1 第 8 项，领星没有）：本品与竞品监控里绑定到本 ASIN 的竞品并列，比较价格、销售排名、评分与评论数的趋势。
// 竞品的评分与评论数没有官方来源，表里写原因，不估算；没有关注竞品时引导去竞品监控添加。

const dash = <Muted>—</Muted>

function PartiesGrid({ data }: { data: Asin360CompetitorCompareResponse }) {
  const columns = useMemo<ErpColDef<Asin360CompareParty>[]>(
    () => [
      renderColumn<Asin360CompareParty>('商品', 'asin', row => <span>{row.isOwn ? `本品 ${row.asin}` : row.asin}</span>, { group: '商品', pin: 'left', width: 200, sortable: false }),
      renderColumn<Asin360CompareParty>('标题', 'title', row => row.title ?? dash, { group: '商品', width: 260, sortable: false }),
      renderColumn<Asin360CompareParty>('价格', 'price', row => (row.latest.price === null ? dash : <span className="erp-num">{formatMoney(row.latest.price, row.currency, { digits: 2 })}</span>), {
        group: '最近取值',
        width: 120,
        sortable: false,
        ...RIGHT_ALIGNED,
      }),
      renderColumn<Asin360CompareParty>(
        '销售排名',
        'rank',
        row => (row.latest.rank === null ? dash : <span className="erp-num">{`${row.rankName ? `${row.rankName} ` : ''}#${formatNumber(row.latest.rank)}`}</span>),
        { group: '最近取值', width: 200, sortable: false, ...RIGHT_ALIGNED },
      ),
      renderColumn<Asin360CompareParty>(
        '评分',
        'rating',
        row => (row.latest.rating === null ? <Muted>{row.ratingNote ?? '尚无记录'}</Muted> : <span className="erp-num">{formatNumber(row.latest.rating, { digits: 2 })}</span>),
        { group: '最近取值', width: 160, sortable: false, ...RIGHT_ALIGNED },
      ),
      renderColumn<Asin360CompareParty>('评论数', 'ratingCount', row => (row.latest.ratingCount === null ? dash : <span className="erp-num">{formatNumber(row.latest.ratingCount)}</span>), {
        group: '最近取值',
        width: 110,
        sortable: false,
        ...RIGHT_ALIGNED,
      }),
      renderColumn<Asin360CompareParty>('快照时间', 'observedAt', row => (row.latest.observedAt ? <span className="erp-num">{formatDateTime(row.latest.observedAt)}</span> : dash), {
        group: '最近取值',
        width: 170,
        sortable: false,
      }),
    ],
    [],
  )
  const fetchPage = useCallback<PageFetcher<Asin360CompareParty>>(
    async ({ page, pageSize }) => ({ items: data.parties.slice((page - 1) * pageSize, page * pageSize), total: data.parties.length }),
    [data.parties],
  )
  return (
    <PagedGrid<Asin360CompareParty>
      gridId="asin360.competitor-compare"
      columns={columns}
      fetchPage={fetchPage}
      getRowId={row => row.asin}
      resetKey={`${data.range.from}:${data.range.to}:${data.parties.map(party => party.asin).join(',')}`}
      emptyState={{ kind: 'empty', domain: '竞品对比', prerequisite: '需要先在竞品监控里关注竞品' }}
      height={260}
    />
  )
}

function CompareBody({ data }: { data: Asin360CompetitorCompareResponse }) {
  const [metric, setMetric] = useState<CompareMetric>('price')
  const option = useMemo(() => buildCompareOption(data, metric), [data, metric])
  const hasRivals = data.parties.length > 1
  const hasData = hasMetricData(data, metric)
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }} data-testid="asin360-competitor-compare">
      {data.note ? (
        <Muted>
          {data.note}
          {!hasRivals ? <AppLink to="/app/competitors"> 去竞品监控添加</AppLink> : null}
        </Muted>
      ) : null}
      {data.truncated ? <Muted>绑定的竞品超过 5 个，只并列了关注最早的 5 个；其余在竞品监控里查看。</Muted> : null}
      <Segmented<CompareMetric> size="small" value={metric} options={COMPARE_METRICS.map(key => ({ value: key, label: COMPARE_METRIC_LABEL[key] }))} onChange={setMetric} aria-label="对比指标" />
      <ChartPanel
        title={`${COMPARE_METRIC_LABEL[metric]}趋势`}
        ariaLabel={`竞品对比${COMPARE_METRIC_LABEL[metric]}趋势图`}
        option={option}
        height={280}
        emptyState={
          hasData
            ? undefined
            : {
                kind: 'empty',
                domain: `${COMPARE_METRIC_LABEL[metric]}趋势`,
                prerequisite: metric === 'rating' || metric === 'ratingCount' ? '本品需要导入评分文件；竞品没有官方来源' : '需要所选范围内有价格与排名快照',
              }
        }
      />
      <PartiesGrid data={data} />
      <Muted>{data.basis}</Muted>
    </Space>
  )
}

export function CompetitorCompareBlock({ id }: { id: string }) {
  const query = useProductQuery<Asin360CompetitorCompareResponse>(id, 'competitor-compare', { scoped: true })
  return <QueryBody query={query}>{data => <CompareBody data={data} />}</QueryBody>
}
