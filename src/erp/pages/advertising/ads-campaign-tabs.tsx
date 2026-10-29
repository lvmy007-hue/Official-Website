import { useState, type ReactNode } from 'react'
import { Alert, Button, Image, Input, Select, Space, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ADS_TARGET_KIND_LABEL,
  ADS_TERM_STATUS_LABEL,
  ADS_WRITE_PENDING,
  isWastedTarget,
  type AdsAdGroupRow,
  type AdsAudienceRow,
  type AdsCampaignProductList,
  type AdsCampaignProductRow,
  type AdsCreativeRow,
  type AdsPlacementResponse,
  type AdsPlacementRow,
  type AdsSearchTermRow,
  type AdsTabList,
  type AdsTargetRow,
  type AdsTermList,
  type AdsTermStatus,
} from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { PagedTab, type PagedTabProps } from './ads-campaign-paged'
import { EntityStateTag, metricColumns, moneyCell, numberCell, TabNote } from './ads-campaigns-ui'
import { DrillLink, type DrillFactories } from './ads-drill-link'

// 活动详情的数据页签（08 章 8.3）：广告组、投放对象、搜索词、广告商品、广告位、创意、受众。
// 每个页签自己取数（切到才加载）；没有数据写明原因，写入亚马逊的动作显示“尚未接入”并给出原因。

/** root：活动详情用 campaigns，广告组详情复用投放对象与搜索词页签时用 ad-groups。 */
/** drill：活动详情给的下钻层构造器（P6-23）；有就在弹窗里连续下钻，没有就整页跳转。 */
type TabProps = { id: string; currency: string; root?: 'campaigns' | 'ad-groups'; drill?: DrillFactories }
const base = (id: string, tab: string, root: 'campaigns' | 'ad-groups' = 'campaigns') => `/ads/${root}/${encodeURIComponent(id)}/${tab}`

type SearchableProps<T extends object, R extends AdsTabList<T>> = Omit<PagedTabProps<T, R>, 'params'> & { placeholder: string; extraParams?: Record<string, string | undefined>; extra?: ReactNode }

/** 带搜索框的列表页签：搜索词或筛选变化时重新挂载分页壳，回到第一页。 */
export function Searchable<T extends object, R extends AdsTabList<T> = AdsTabList<T>>({ placeholder, extraParams, extra, ...paged }: SearchableProps<T, R>) {
  const [q, setQ] = useState<string>()
  return (
    <div>
      <Space wrap style={{ marginBottom: 8 }}>
        <Input.Search allowClear style={{ width: 260 }} placeholder={placeholder} aria-label={placeholder} onSearch={value => setQ(value.trim() || undefined)} />
        {extra}
      </Space>
      <PagedTab<T, R> key={`${q ?? ''}|${JSON.stringify(extraParams ?? {})}`} {...paged} params={{ q, ...extraParams }} />
    </div>
  )
}
export function AdGroupsTab({ id, currency, drill }: TabProps) {
  const columns: ColumnsType<AdsAdGroupRow> = [
    {
      title: '广告组',
      key: 'name',
      render: (_value, row) => (
        <div>
          {drill ? (
            <DrillLink level={drill.adGroup(row, currency)} heading="广告活动">
              {row.name}
            </DrillLink>
          ) : (
            <AppLink to={`/app/advertising/ad-groups/${encodeURIComponent(row.id)}`}>{row.name}</AppLink>
          )}
          <div className="erp-num">{row.adGroupId}</div>
        </div>
      ),
    },
    { title: '状态', key: 'state', width: 100, render: (_value, row) => <EntityStateTag state={row.state} /> },
    { title: '默认竞价', dataIndex: 'defaultBid', width: 100, align: 'right', render: (value: number | null) => moneyCell(value, currency) },
    ...metricColumns<AdsAdGroupRow>(currency),
  ]
  return <Searchable<AdsAdGroupRow> path={base(id, 'ad-groups')} columns={columns} rowKey={row => row.adGroupId} domain="广告组" placeholder="搜索广告组名称" scrollX={1000} />
}

export function TargetsTab({ id, currency, root, drill }: TabProps) {
  const columns: ColumnsType<AdsTargetRow> = [
    {
      title: '投放对象',
      dataIndex: 'expression',
      width: 220,
      render: (value: string, row) => (
        <span title={value}>
          {drill ? <DrillLink level={drill.target(row, currency)}>{value}</DrillLink> : <AppLink to={`/app/advertising/targets/${encodeURIComponent(row.id)}`}>{value}</AppLink>}
        </span>
      ),
    },
    { title: '类型', dataIndex: 'kind', width: 80, render: (value: string) => ADS_TARGET_KIND_LABEL[value as keyof typeof ADS_TARGET_KIND_LABEL] ?? value },
    { title: '匹配方式', dataIndex: 'matchType', width: 100, render: (value: string | null) => value ?? <Muted>—</Muted> },
    { title: '状态', key: 'state', width: 90, render: (_value, row) => <EntityStateTag state={row.state} /> },
    { title: '竞价', dataIndex: 'bid', width: 90, align: 'right', render: (value: number | null) => moneyCell(value, currency) },
    {
      title: '建议竞价',
      dataIndex: 'suggestedBid',
      width: 100,
      align: 'right',
      render: (value: number | null) =>
        value === null ? <Muted>无推荐</Muted> : <Tooltip title="亚马逊官方推荐里的建议竞价；采纳官方推荐的入口暂未提供，可以到活动列表手动调整">{moneyCell(value, currency)}</Tooltip>,
    },
    { title: '广告组', dataIndex: 'adGroupName', width: 140, render: (value: string | null, row) => value ?? <span className="erp-num">{row.adGroupId}</span> },
    ...metricColumns<AdsTargetRow>(currency),
  ]
  return <Searchable<AdsTargetRow> path={base(id, 'targets', root)} columns={columns} rowKey={row => row.key} domain="投放对象" placeholder="搜索投放对象" scrollX={1300} />
}

const TERM_COLOR: Record<AdsTermStatus, string> = { TARGETED: 'success', NEGATED: 'error', UNTARGETED: 'default' }

export function SearchTermsTab({ id, currency, root, drill }: TabProps) {
  const [status, setStatus] = useState<AdsTermStatus>()
  const columns: ColumnsType<AdsSearchTermRow> = [
    {
      title: '搜索词',
      key: 'searchTerm',
      width: 240,
      render: (_value, row) => (
        <div>
          {drill ? <DrillLink level={drill.term(row, currency)}>{row.searchTerm}</DrillLink> : row.searchTerm}
          {isWastedTarget(row.metrics) ? (
            <Tag color="warning" bordered={false} style={{ marginLeft: 6 }}>
              花费无转化
            </Tag>
          ) : null}
        </div>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 90,
      render: (_value, row) => (
        <Tag color={TERM_COLOR[row.status]} bordered={false}>
          {ADS_TERM_STATUS_LABEL[row.status]}
        </Tag>
      ),
    },
    ...metricColumns<AdsSearchTermRow>(currency),
  ]
  return (
    <Searchable<AdsSearchTermRow, AdsTermList>
      path={base(id, 'search-terms', root)}
      columns={columns}
      rowKey={row => row.searchTerm}
      domain="搜索词"
      placeholder="搜索词包含"
      scrollX={900}
      extraParams={{ status }}
      extra={
        <>
          <Select
            allowClear
            placeholder="全部状态"
            aria-label="搜索词状态"
            style={{ width: 130 }}
            value={status}
            onChange={value => setStatus(value)}
            options={(Object.keys(ADS_TERM_STATUS_LABEL) as AdsTermStatus[]).map(value => ({ value, label: ADS_TERM_STATUS_LABEL[value] }))}
          />
          <Tooltip title={ADS_WRITE_PENDING.note}>
            <span>
              <Button disabled>添加为关键词</Button> <Button disabled>添加否定</Button>
            </span>
          </Tooltip>
        </>
      }
      header={data => (data ? <TermBasis data={data} /> : null)}
    />
  )
}

function TermBasis({ data }: { data: AdsTermList }) {
  return <Alert type="info" showIcon style={{ marginBottom: 8 }} message={data.matchBasis} data-testid="term-basis" />
}

const stockTag = (row: AdsCampaignProductRow) =>
  row.stock === 'OUT_OF_STOCK' ? (
    <Tag color="error" bordered={false}>
      断货
    </Tag>
  ) : row.stock === 'IN_STOCK' ? (
    <Tag color="success" bordered={false}>
      有货
    </Tag>
  ) : (
    <Muted>库存未知</Muted>
  )

export function ProductsTab({ id, currency }: TabProps) {
  const columns: ColumnsType<AdsCampaignProductRow> = [
    {
      title: '商品',
      key: 'asin',
      width: 280,
      render: (_value, row) => (
        <Space>
          {row.imageUrl ? <Image src={row.imageUrl} alt={row.asin} width={36} height={36} style={{ objectFit: 'contain' }} /> : null}
          <div>
            <div className="erp-num">{row.asin}</div>
            <Muted>{row.title ?? '商品资料尚未同步'}</Muted>
          </div>
        </Space>
      ),
    },
    {
      title: '库存',
      key: 'stock',
      width: 130,
      render: (_value, row) => (
        <span>
          {stockTag(row)} {row.sellable === null ? null : <span className="erp-num">{row.sellable}</span>}
        </span>
      ),
    },
    ...metricColumns<AdsCampaignProductRow>(currency),
  ]
  return (
    <Searchable<AdsCampaignProductRow, AdsCampaignProductList>
      path={base(id, 'products')}
      columns={columns}
      rowKey={row => row.asin}
      domain="广告商品"
      placeholder="搜索 ASIN 或商品名称"
      scrollX={1000}
    />
  )
}

export function PlacementsTab({ id, currency }: TabProps) {
  const query = useApiQuery<AdsPlacementResponse>({ domain: 'analytics', path: base(id, 'placements') })
  const data = query.data
  const columns: ColumnsType<AdsPlacementRow> = [
    { title: '广告位', key: 'label', render: (_value, row) => <span title={row.placement}>{row.label}</span> },
    ...metricColumns<AdsPlacementRow>(currency),
  ]
  return (
    <div>
      {data ? <TabNote state={data.state} note={data.note} /> : null}
      <SimpleGrid<AdsPlacementRow>
        gridId="advertising.ads-campaign-tabs"
        columns={columns}
        rows={data?.items}
        rowKey={row => row.placement}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '广告位', prerequisite: data?.note ?? '所选范围内尚无广告位报表记录。' }}
      />
      {data ? (
        <div style={{ marginTop: 8 }} data-testid="placement-adjustments">
          <TabNote state={data.adjustments.state} note={`广告位竞价调整：${data.adjustments.note}`} />
        </div>
      ) : null}
    </div>
  )
}

export function CreativesTab({ id }: TabProps) {
  const columns: ColumnsType<AdsCreativeRow> = [
    { title: '创意', dataIndex: 'headline', render: (value: string | null) => value ?? <Muted>原文里没有标题</Muted> },
    { title: '类型', dataIndex: 'kind', width: 120 },
    { title: '着陆页', dataIndex: 'landingPage', render: (value: string | null) => (value ? <span title={value}>{value.slice(0, 60)}</span> : <Muted>尚无记录</Muted>) },
    { title: '素材数', dataIndex: 'assetCount', width: 80, align: 'right', render: (value: number) => numberCell(value) },
    { title: '广告编号', dataIndex: 'adId', width: 140, render: (value: string) => <span className="erp-num">{value}</span> },
  ]
  return <Searchable<AdsCreativeRow> path={base(id, 'creatives')} columns={columns} rowKey={row => row.creativeId} domain="创意" placeholder="搜索标题或着陆页" />
}

export function AudiencesTab({ id, currency }: TabProps) {
  const columns: ColumnsType<AdsAudienceRow> = [
    { title: '受众', dataIndex: 'expression' },
    { title: '状态', key: 'state', width: 90, render: (_value, row) => <EntityStateTag state={row.state} /> },
    { title: '竞价', dataIndex: 'bid', width: 100, align: 'right', render: (value: number | null) => moneyCell(value, currency) },
    { title: '广告组编号', dataIndex: 'adGroupId', width: 150, render: (value: string) => <span className="erp-num">{value}</span> },
  ]
  return <Searchable<AdsAudienceRow> path={base(id, 'audiences')} columns={columns} rowKey={row => row.targetId} domain="受众" placeholder="搜索受众" />
}
