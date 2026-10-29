import { useMemo, type ReactNode } from 'react'
import { Alert, Card, Descriptions, Space, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ASIN360_ADS_ROW_LIMIT, type Asin360AdsBlock, type Asin360AdsResponse } from '@nova/api-contracts'
import { ChartPanel, SimpleGrid } from '../../components'
import { formatMoney } from '../../format'
import { moneyCell, numberCell, percentCell, TabNote } from '../advertising/ads-campaigns-ui'
import { Muted, StateBlock } from '../inventory/inventory-ui'
import { QueryBody, useProductQuery } from './asin360-hooks'
import { buildAdsTrendOption, hasTrendData } from './asin360-ads-options'
import { adGroupColumns, campaignColumns, targetColumns, termColumns } from './asin360-ads-tables'

// 广告页签（05 章 5.2）：汇总 → 断货仍在花钱提示 → 趋势（花费、广告成本销售比、广告占总销售比）→ 关联的活动、广告组、投放对象、搜索词 → 品牌分析缺口。
// 活动一行是这个 ASIN 自己的数字；广告组、投放对象、搜索词是它们各自的合计（亚马逊没有按 ASIN 拆开），页面上写明。同一 ASIN 的多个 SKU 合在一起。
// 空值写“尚无记录”，没有接入的写“尚未接入”，都不写 0；金额只有美元。

function Summary({ data }: { data: Asin360AdsResponse }) {
  const { summary, halo } = data
  const organic = summary.organicIssue ? (
    <Tooltip title="广告销售额大于全部销售额（两个口径的统计时点不同），不给出自然销售额">
      <Muted>不给出</Muted>
    </Tooltip>
  ) : (
    moneyCell(summary.organicSales)
  )
  const haloCell =
    halo.state === 'OK' ? (
      moneyCell(halo.sales)
    ) : (
      <Tooltip title={halo.note}>
        <Muted>尚无记录</Muted>
      </Tooltip>
    )
  return (
    <Descriptions size="small" bordered column={{ xs: 1, md: 4 }} data-testid="asin360-ads-summary">
      <Descriptions.Item label="统计范围">
        {data.range.from} 至 {data.range.to}
        {data.range.defaulted ? '（默认最近 30 天）' : ''}
      </Descriptions.Item>
      <Descriptions.Item label="广告花费">{moneyCell(summary.totals.spend)}</Descriptions.Item>
      <Descriptions.Item label="广告销售额">{moneyCell(summary.totals.sales)}</Descriptions.Item>
      <Descriptions.Item label="广告成本销售比">{percentCell(summary.ratios.acos)}</Descriptions.Item>
      <Descriptions.Item label="广告订单">{summary.totals.spend === null ? <Muted>尚无记录</Muted> : numberCell(summary.totals.orders)}</Descriptions.Item>
      <Descriptions.Item label="全部销售额">{moneyCell(summary.totalSales)}</Descriptions.Item>
      <Descriptions.Item label="广告占总销售比">{percentCell(summary.adsShare)}</Descriptions.Item>
      <Descriptions.Item label="自然销售额（估算）">{organic}</Descriptions.Item>
      <Descriptions.Item label="光环销售">{haloCell}</Descriptions.Item>
      <Descriptions.Item label="推广活动数">{numberCell(summary.campaigns)}</Descriptions.Item>
      <Descriptions.Item label="广告数（在投 / 全部）">{summary.ads ? <span className="erp-num">{`${summary.ads.enabled} / ${summary.ads.total}`}</span> : <Muted>尚无记录</Muted>}</Descriptions.Item>
    </Descriptions>
  )
}

function StockAlert({ stock }: { stock: Asin360AdsResponse['stock'] }) {
  if (stock.stock !== 'OUT_OF_STOCK' || stock.spend === null || stock.spend <= 0) return null
  return (
    <Alert
      type="warning"
      showIcon
      data-testid="asin360-ads-stockout"
      message="这个商品已断货，但仍有广告花费"
      description={`可售库存 ${stock.sellable ?? '—'}（${stock.snapshotDate ?? '日期未知'} 的库存快照），所选范围内广告花费 ${formatMoney(stock.spend, 'USD', { digits: 2 })}；花费是整个范围的合计，不只是断货之后的。建议暂停或降低这个商品的广告。`}
    />
  )
}

interface BlockCardProps<T extends object> {
  title: string
  block: Asin360AdsBlock<T>
  columns: ColumnsType<T>
  rowKey: (row: T) => string
  domain: string
  testId: string
  header?: ReactNode
}

function BlockCard<T extends object>({ title, block, columns, rowKey, domain, testId, header }: BlockCardProps<T>) {
  return (
    <Card size="small" title={title} data-testid={testId}>
      <StateBlock state={block.state} note={block.note}>
        {block.note ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={block.note} /> : null}
        {header}
        {block.truncated ? (
          <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`只列出花费最高的前 ${ASIN360_ADS_ROW_LIMIT} 行`} description="完整列表请到广告模块对应的页面查看。" />
        ) : null}
        <SimpleGrid<T>
          gridId={`products.ads-tab.${testId}`}
          columns={columns}
          rows={block.items}
          rowKey={rowKey}
          emptyState={{ kind: 'empty', domain, prerequisite: block.note ?? `这个 ASIN 目前没有${domain}。` }}
        />
      </StateBlock>
    </Card>
  )
}

function Body({ data }: { data: Asin360AdsResponse }) {
  const option = useMemo(() => buildAdsTrendOption(data.trend), [data.trend])
  if (data.trend.length === 0) {
    // 店铺没有绑定广告账户：没有任何可显示的内容，只说明原因
    return (
      <Space direction="vertical" size={8} style={{ width: '100%' }} data-testid="asin360-ads-unbound">
        <TabNote state={data.state} note={data.note} />
        <Alert type="info" showIcon message="品牌分析缺口：尚未接入" description={data.brandGaps.note} />
      </Space>
    )
  }
  const quiet = !hasTrendData(data.trend)
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <TabNote state={data.state} note={data.note} />
      <Summary data={data} />
      <StockAlert stock={data.stock} />
      <ChartPanel
        title="花费、广告成本销售比与广告占总销售比趋势"
        ariaLabel="商品广告趋势图"
        option={option}
        emptyState={quiet ? { kind: 'empty', domain: '广告趋势', prerequisite: data.note ?? '所选日期范围内没有这个 ASIN 的广告记录。' } : undefined}
      />
      <BlockCard title="关联的广告活动（这个 ASIN 自己的数字）" block={data.campaigns} columns={campaignColumns} rowKey={row => row.key} domain="广告活动" testId="asin360-ads-campaigns" />
      <Alert type="info" showIcon message="下面三张表的数字是对象自己的合计" description={data.sharedNote} data-testid="asin360-ads-shared-note" />
      <BlockCard title="关联的广告组" block={data.adGroups} columns={adGroupColumns} rowKey={row => `${row.adsProfileId}|${row.adGroupId}`} domain="广告组" testId="asin360-ads-adgroups" />
      <BlockCard title="投放对象（关键词与商品、类目投放）" block={data.targets} columns={targetColumns} rowKey={row => `${row.adGroupId}|${row.key}`} domain="投放对象" testId="asin360-ads-targets" />
      <BlockCard
        title="搜索词"
        block={data.searchTerms}
        columns={termColumns}
        rowKey={row => row.searchTerm}
        domain="搜索词"
        testId="asin360-ads-terms"
        header={<Alert type="info" showIcon style={{ marginBottom: 8 }} message={data.searchTerms.matchBasis} data-testid="asin360-ads-term-basis" />}
      />
      <Alert type="info" showIcon message="品牌分析缺口（份额高但尚未投放的搜索词）：尚未接入" description={data.brandGaps.note} data-testid="asin360-ads-brand-gaps" />
      <Muted>{data.basis}</Muted>
    </Space>
  )
}

export function AdsTab({ id }: { id: string }) {
  const query = useProductQuery<Asin360AdsResponse>(id, 'ads', { scoped: true })
  return <QueryBody query={query}>{data => <Body data={data} />}</QueryBody>
}
