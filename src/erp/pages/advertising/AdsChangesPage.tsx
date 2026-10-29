import { useState } from 'react'
import { Alert, Button, Card, Input, Radio, Select, Space } from 'antd'
import {
  ADS_CHANGE_ENTITY_LABEL,
  ADS_CHANGE_ENTITY_TYPES,
  ADS_CHANGE_SOURCE_LABEL,
  ADS_CHANGE_SOURCES,
  type AdsChangeEntityType,
  type AdsChangeListResponse,
  type AdsChangeRow,
  type AdsChangeSource,
} from '@nova/api-contracts'
import { PageHeader, SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { ChangeCompareDrawer } from './ads-changes-compare'
import { changeColumns } from './ads-changes-columns'
import { WriteRunsCard } from './ads-write-runs'

// 变更记录（P3-14，08 章 8.11）：汇总广告对象的字段变化，四种来源——手动、自动规则、分时策略、外部变更。
// 外部变更由定时对比实体快照识别，只能知道发生在两次快照之间，不知道是谁改的；手动、自动规则与分时策略的变更由广告写入记录（亚马逊确认成功后记），排队中与失败的写入在页面下方的“写入记录”里看。
// 筛选、翻页在服务端（日期范围与店铺范围用全局筛选）；没有快照写“尚未接入”，拍过快照但没有变更写“尚无记录”。

const PAGE_SIZES = [20, 50, 100]
type SourceFilter = AdsChangeSource | 'ALL'

export default function AdsChangesPage() {
  const [source, setSource] = useState<SourceFilter>('ALL')
  const [entityType, setEntityType] = useState<AdsChangeEntityType>()
  const [adsProfileId, setAdsProfileId] = useState<string>()
  const [q, setQ] = useState<string>()
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  // 游标栈：栈顶是当前页的游标，undefined 表示第一页
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const [opened, setOpened] = useState<AdsChangeRow | null>(null)
  const reset = () => setStack([undefined])
  const query = useApiQuery<AdsChangeListResponse>({
    domain: 'analytics',
    path: '/ads/changes',
    params: { source: source === 'ALL' ? undefined : source, entityType, adsProfileId, q, pageSize, cursor: stack[stack.length - 1] },
  })
  const data = query.data
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null
  const filtered = Boolean(source !== 'ALL' || entityType || adsProfileId || q)
  const allCount = data ? ADS_CHANGE_SOURCES.reduce((sum, key) => sum + data.counts[key], 0) : null

  return (
    <div data-testid="ads-changes-page">
      <PageHeader title="变更记录" description="广告对象（活动、广告组、投放对象、关键词、广告组合）的字段变化：改前、改后、来源与时间，可打开前后对照。外部变更由系统定时对比实体快照识别。" />
      <Card size="small">
        {data?.defaulted ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={`未选择日期范围，当前显示 ${data.period.from} 至 ${data.period.to} 的变更`} /> : null}
        {data?.tracking.state === 'NOT_CONNECTED' ? (
          <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="尚未接入" description={data.tracking.note} data-testid="ads-changes-tracking" />
        ) : null}
        {data?.tracking.state === 'OK' ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 8 }}
            message={`最近一次实体快照：${formatDateTime(data.tracking.lastSnapshotAt ?? '')}`}
            description={`${data.tracking.note}。${data.externalNote}`}
            data-testid="ads-changes-tracking"
          />
        ) : null}
        {data ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="手动、自动规则与分时策略的变更" description={data.write.note} data-testid="ads-changes-write-note" /> : null}
        <Space wrap style={{ marginBottom: 8 }}>
          <Radio.Group
            value={source}
            aria-label="来源"
            optionType="button"
            onChange={event => {
              setSource(event.target.value as SourceFilter)
              reset()
            }}
            options={[
              { value: 'ALL', label: `全部${allCount === null ? '' : `（${allCount}）`}` },
              ...ADS_CHANGE_SOURCES.map(key => ({ value: key, label: `${ADS_CHANGE_SOURCE_LABEL[key]}${data ? `（${data.counts[key]}）` : ''}` })),
            ]}
          />
        </Space>
        <Space wrap style={{ marginBottom: 8 }}>
          <Select
            allowClear
            style={{ width: 140 }}
            placeholder="对象类型"
            aria-label="对象类型"
            value={entityType}
            options={ADS_CHANGE_ENTITY_TYPES.map(value => ({ value, label: ADS_CHANGE_ENTITY_LABEL[value] }))}
            onChange={value => {
              setEntityType(value)
              reset()
            }}
          />
          <Select
            allowClear
            style={{ width: 220 }}
            placeholder="广告账户"
            aria-label="广告账户"
            value={adsProfileId}
            options={(data?.profiles ?? []).map(profile => ({ value: profile.id, label: profile.storeName ? `${profile.name} · ${profile.storeName}` : profile.name }))}
            onChange={value => {
              setAdsProfileId(value)
              reset()
            }}
          />
          <Input.Search
            allowClear
            style={{ width: 260 }}
            placeholder="搜索对象名称或变更前后的值"
            aria-label="搜索对象名称或变更前后的值"
            onSearch={value => {
              setQ(value.trim() || undefined)
              reset()
            }}
          />
          <Select
            value={String(pageSize)}
            aria-label="每页条数"
            style={{ width: 110 }}
            options={PAGE_SIZES.map(size => ({ value: String(size), label: `${size} 条/页` }))}
            onChange={value => {
              setPageSize(Number(value))
              reset()
            }}
          />
        </Space>
        <SimpleGrid<AdsChangeRow>
          gridId="advertising.ads-changes-page"
          columns={changeColumns(setOpened)}
          rows={data?.items}
          rowKey={row => row.id}
          loading={query.isFetching}
          error={query.error}
          onRetry={() => void query.refetch()}
          emptyState={{
            kind: 'empty',
            domain: '变更记录',
            prerequisite: data?.note ?? (filtered ? '没有符合条件的变更记录；可以放宽筛选条件。' : '所选范围内尚无变更记录。'),
          }}
        />
        <Space style={{ marginTop: 8 }}>
          <Button disabled={stack.length <= 1 || query.isFetching} onClick={() => setStack(current => current.slice(0, -1))}>
            上一页
          </Button>
          <Button disabled={!next || query.isFetching} onClick={() => next && setStack(current => [...current, next])}>
            下一页
          </Button>
          <span style={{ color: 'rgba(0,0,0,0.45)' }}>
            第 {stack.length} 页{data ? `，共 ${data.pageInfo.approxTotal ?? data.items.length} 条` : ''}
          </span>
        </Space>
      </Card>
      <WriteRunsCard />
      <ChangeCompareDrawer row={opened} onClose={() => setOpened(null)} />
    </div>
  )
}
